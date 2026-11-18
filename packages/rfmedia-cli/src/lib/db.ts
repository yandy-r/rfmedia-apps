/**
 * Core database module for rfmedia CLI.
 * Provides SQLite-based tracking for operations, completed sources, and inventory.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";

import { logDebug } from "./logger.js";
import { pathExists } from "./filesystem.js";
import { preflightExistingDatabase } from "./db/reconciliation-database.js";
export {
  READ_ONLY_DATABASE_MAX_BYTES,
  assertReconciliationDatabaseGenerationCurrent,
  openDatabaseReadOnly,
  openReconciliationDatabaseAuthorityLease,
  openReconciliationDatabaseReadOnly,
  withReconciliationDatabaseWritable,
} from "./db/reconciliation-database.js";
export {
  RECONCILIATION_INVENTORY_MAX_CANDIDATES,
  getReconciliationInventoryCandidates,
  getReconciliationInventoryCandidatesAtPath,
  updateReconciliationInventory,
} from "./db/reconciliation-inventory.js";
import type {
  DbConnection,
  DbOperation,
  DbCompletedSource,
  DbCompletedAlbumCopy,
  DbFailedSource,
  DbInventoryEntry,
  DbInventoryFingerprint,
  CreateOperationParams,
  OperationFilter,
  OperationCounts,
  DbHistorySession,
  DbHistoryOperation,
  CreateHistorySessionParams,
  RecordHistoryOperationParams,
  HistorySessionFilter,
  DbPlexQuery,
  DbPlexQueryResult,
  CreatePlexQueryParams,
  PlexQueryListOptions,
  PlexQueryResultItem,
  DbSmartPlaylist,
  DbSmartPlaylistHistory,
  CreateSmartPlaylistParams,
  UpdateSmartPlaylistParams,
  SmartPlaylistTrackInfo,
} from "../types/db.js";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Returns the default database path.
 *
 * Searches for existing database in priority order:
 * 1. ~/.config/rfmedia/tracking.db (XDG standard)
 * 2. ~/.rfmedia/tracking.db (legacy location)
 *
 * If no database exists, returns XDG path for new database creation.
 * This mirrors the config file search order for consistency.
 */
export function getDefaultDatabasePath(): string {
  const home = homedir();
  const candidates = [
    join(home, ".config", "rfmedia", "tracking.db"), // XDG standard
    join(home, ".rfmedia", "tracking.db"), // Legacy location
  ];

  // Return first existing path, or XDG default for new databases
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] as string; // Default to XDG for new databases
}

/**
 * Reads and returns the SQL schema.
 */
async function loadSchema(): Promise<string> {
  // Schema file is in same directory as this module
  const schemaPath = new URL("./schema.sql", import.meta.url).pathname;
  return await readFile(schemaPath, "utf-8");
}

/**
 * Initializes the database connection and creates tables if needed.
 *
 * @param dbPath - Path to database file (defaults to XDG or legacy location via getDefaultDatabasePath())
 * @returns Database connection
 */
export async function initializeDatabase(dbPath?: string): Promise<DbConnection> {
  const path = dbPath ?? getDefaultDatabasePath();

  // Ensure parent directory exists
  const dir = dirname(path);
  if (!(await pathExists(dir))) {
    await mkdir(dir, { recursive: true });
    logDebug(`Created database directory: ${dir}`);
  }

  const { CURRENT_SCHEMA_VERSION, runMigrations } = await import("./migrations.js");
  preflightExistingDatabase(path, CURRENT_SCHEMA_VERSION);

  // Open database connection only after the read-only compatibility preflight.
  const db = new Database(path);
  try {
    logDebug(`Opened database: ${path}`);

    // Performance and concurrency pragmas (#112):
    // - WAL allows concurrent readers during writes and replaces the
    //   full-database fsync per commit with a sequential WAL append
    // - synchronous=NORMAL is safe with WAL: commits survive application
    //   crashes; only an OS crash or power loss can roll back the tail
    // - busy_timeout makes concurrent openers wait instead of failing
    //   immediately with SQLITE_BUSY
    const journalMode = db.pragma("journal_mode = WAL", { simple: true }) as string;
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    logDebug(`Journal mode: ${journalMode}`);

    // Enable foreign keys
    db.pragma("foreign_keys = ON");

    // Load and execute schema
    const schema = await loadSchema();
    db.exec(schema);
    logDebug("Database schema initialized");

    await runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

/**
 * Gets the current schema version from the database.
 */
export function getCurrentSchemaVersion(db: DbConnection): number {
  const stmt = db.prepare("SELECT value FROM metadata WHERE key = ?");
  const row = stmt.get("schema_version") as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

/**
 * Creates a new operation record.
 *
 * @param db - Database connection
 * @param params - Operation parameters
 * @returns Operation ID
 */
export function createOperation(db: DbConnection, params: CreateOperationParams): number {
  const stmt = db.prepare(`
    INSERT INTO operations (
      created_at, command, mode, input_file, options_hash,
      rating_key, range_key, convert_key, status, total_sources,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const result = stmt.run(
    now,
    params.command,
    params.mode,
    params.inputFile,
    params.optionsHash,
    params.ratingKey,
    params.rangeKey,
    params.convertKey,
    "pending",
    params.totalSources ?? 0,
    now,
  );

  const operationId = Number(result.lastInsertRowid);
  logDebug(`Created operation ${operationId}: ${params.command} (${params.optionsHash})`);
  return operationId;
}

/**
 * Updates operation status.
 */
export function updateOperationStatus(
  db: DbConnection,
  operationId: number,
  status: "pending" | "completed" | "failed" | "partial",
): void {
  const stmt = db.prepare(`
    UPDATE operations
    SET status = ?, ended_at = ?
    WHERE id = ?
  `);

  stmt.run(status, new Date().toISOString(), operationId);
  logDebug(`Updated operation ${operationId} status to: ${status}`);
}

/**
 * Updates operation counts.
 */
export function updateOperationCounts(
  db: DbConnection,
  operationId: number,
  counts: OperationCounts,
): void {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (counts.totalSources !== undefined) {
    updates.push("total_sources = ?");
    values.push(counts.totalSources);
  }
  if (counts.completedCount !== undefined) {
    updates.push("completed_count = ?");
    values.push(counts.completedCount);
  }
  if (counts.failedCount !== undefined) {
    updates.push("failed_count = ?");
    values.push(counts.failedCount);
  }

  if (updates.length === 0) return;

  const stmt = db.prepare(`
    UPDATE operations
    SET ${updates.join(", ")}
    WHERE id = ?
  `);

  stmt.run(...values, operationId);
  logDebug(`Updated operation ${operationId} counts`);
}

/**
 * Gets an operation by ID.
 */
export function getOperation(db: DbConnection, operationId: number): DbOperation | null {
  const stmt = db.prepare("SELECT * FROM operations WHERE id = ?");
  return (stmt.get(operationId) as DbOperation | undefined) ?? null;
}

/**
 * Finds an operation matching the filter.
 * Returns the most recent matching operation.
 */
export function findOperation(db: DbConnection, filter: OperationFilter): DbOperation | null {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.inputFile !== undefined) {
    conditions.push("input_file = ?");
    values.push(filter.inputFile);
  }
  if (filter.optionsHash !== undefined) {
    conditions.push("options_hash = ?");
    values.push(filter.optionsHash);
  }
  if (filter.mode !== undefined) {
    conditions.push("mode = ?");
    values.push(filter.mode);
  }
  if (filter.status !== undefined) {
    conditions.push("status = ?");
    values.push(filter.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const stmt = db.prepare(`
    SELECT * FROM operations
    ${where}
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return (stmt.get(...values) as DbOperation | undefined) ?? null;
}

/**
 * Records a completed source for an operation.
 */
export function recordCompleted(db: DbConnection, operationId: number, sourcePath: string): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO completed_sources (operation_id, source_path, completed_at)
    VALUES (?, ?, ?)
  `);

  stmt.run(operationId, sourcePath, new Date().toISOString());
  logDebug(`Recorded completed source for operation ${operationId}: ${sourcePath}`);
}

/**
 * Gets all completed sources for an operation.
 */
export function getCompletedSources(db: DbConnection, operationId: number): string[] {
  const stmt = db.prepare(`
    SELECT source_path FROM completed_sources
    WHERE operation_id = ?
    ORDER BY completed_at
  `);

  const rows = stmt.all(operationId) as { source_path: string }[];
  return rows.map((r) => r.source_path);
}

/**
 * Checks if a source is completed for an operation.
 */
export function isSourceCompleted(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
): boolean {
  const stmt = db.prepare(`
    SELECT 1 FROM completed_sources
    WHERE operation_id = ? AND source_path = ?
  `);

  return stmt.get(operationId, sourcePath) !== undefined;
}

/**
 * Records a failed source for an operation.
 */
export function recordFailed(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  error: string,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO failed_sources (operation_id, source_path, error_message, failed_at)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(operationId, sourcePath, error, new Date().toISOString());
  logDebug(`Recorded failed source for operation ${operationId}: ${sourcePath}`);
}

/**
 * Gets all failed sources for an operation.
 */
export function getFailedSources(db: DbConnection, operationId: number): DbFailedSource[] {
  const stmt = db.prepare(`
    SELECT * FROM failed_sources
    WHERE operation_id = ?
    ORDER BY failed_at
  `);

  return stmt.all(operationId) as DbFailedSource[];
}

/**
 * Records a completed album copy (granular per-suffix tracking).
 *
 * This enables range expansion: when a user first runs with range 001-002,
 * then later expands to 001-020, only suffixes 003-020 will be processed.
 *
 * Also supports rating-aware tracking: different rating filters (e.g., r50 vs r80)
 * create separate tracking states, allowing re-processing with different filters.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path (artist or album)
 * @param albumName - Album folder name
 * @param suffix - Completed suffix (e.g., '001', '002')
 * @param ratingKey - Rating filter key (e.g., 'r80', 's3', null for no filter)
 */
export function recordCompletedAlbumCopy(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  albumName: string,
  suffix: string,
  ratingKey?: string | null,
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO completed_album_copies (operation_id, source_path, album_name, suffix, rating_key, completed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const effectiveRatingKey = ratingKey ?? null;
  stmt.run(
    operationId,
    sourcePath,
    albumName,
    suffix,
    effectiveRatingKey,
    new Date().toISOString(),
  );
  const ratingPart = effectiveRatingKey ? ` (rating: ${effectiveRatingKey})` : "";
  logDebug(`Recorded completed album copy: ${sourcePath}/${albumName}-${suffix}${ratingPart}`);
}

/**
 * Gets all completed album copies for a source path within an operation.
 *
 * When ratingKey is provided, only returns copies matching that rating filter.
 * When ratingKey is undefined, returns all copies regardless of rating filter.
 * When ratingKey is null, returns only copies with no rating filter.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param ratingKey - Rating filter key (undefined = all, null = no filter, string = specific filter)
 * @returns Array of completed album copy records
 */
export function getCompletedAlbumCopies(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  ratingKey?: string | null,
): DbCompletedAlbumCopy[] {
  // If ratingKey is undefined, return all copies
  if (ratingKey === undefined) {
    const stmt = db.prepare(`
      SELECT * FROM completed_album_copies
      WHERE operation_id = ? AND source_path = ?
      ORDER BY album_name, suffix
    `);
    return stmt.all(operationId, sourcePath) as DbCompletedAlbumCopy[];
  }

  // Filter by specific rating key (including null for no filter)
  const stmt = db.prepare(`
    SELECT * FROM completed_album_copies
    WHERE operation_id = ? AND source_path = ? AND (rating_key IS ? OR (rating_key IS NULL AND ? IS NULL))
    ORDER BY album_name, suffix
  `);

  return stmt.all(operationId, sourcePath, ratingKey, ratingKey) as DbCompletedAlbumCopy[];
}

/**
 * Gets all completed album copies under a library root path.
 *
 * Uses prefix matching to find all entries where source_path starts with the given path.
 * This is used for library root mode where entries are stored per-artist.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param libraryRoot - Library root path (e.g., /data/media/music)
 * @param ratingKey - Rating filter key (undefined = all, null = no filter, string = specific filter)
 * @returns Array of completed album copy records for all artists under the library root
 */
export function getCompletedAlbumCopiesUnderPath(
  db: DbConnection,
  operationId: number,
  libraryRoot: string,
  ratingKey?: string | null,
): DbCompletedAlbumCopy[] {
  // Ensure we match paths that start with libraryRoot followed by a separator
  const prefix = libraryRoot.endsWith("/") ? libraryRoot : `${libraryRoot}/`;

  // If ratingKey is undefined, return all copies
  if (ratingKey === undefined) {
    const stmt = db.prepare(`
      SELECT * FROM completed_album_copies
      WHERE operation_id = ? AND (source_path = ? OR source_path LIKE ?)
      ORDER BY source_path, album_name, suffix
    `);
    return stmt.all(operationId, libraryRoot, `${prefix}%`) as DbCompletedAlbumCopy[];
  }

  // Filter by specific rating key (including null for no filter)
  const stmt = db.prepare(`
    SELECT * FROM completed_album_copies
    WHERE operation_id = ? AND (source_path = ? OR source_path LIKE ?)
      AND (rating_key IS ? OR (rating_key IS NULL AND ? IS NULL))
    ORDER BY source_path, album_name, suffix
  `);

  return stmt.all(
    operationId,
    libraryRoot,
    `${prefix}%`,
    ratingKey,
    ratingKey,
  ) as DbCompletedAlbumCopy[];
}

/**
 * Gets all completed suffixes for a specific album within a source.
 *
 * When ratingKey is provided, only returns suffixes matching that rating filter.
 * When ratingKey is undefined, returns all suffixes regardless of rating filter.
 * When ratingKey is null, returns only suffixes with no rating filter.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param albumName - Album folder name
 * @param ratingKey - Rating filter key (undefined = all, null = no filter, string = specific filter)
 * @returns Set of completed suffix strings
 */
export function getCompletedSuffixesForAlbum(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  albumName: string,
  ratingKey?: string | null,
): Set<string> {
  // If ratingKey is undefined, return all suffixes
  if (ratingKey === undefined) {
    const stmt = db.prepare(`
      SELECT suffix FROM completed_album_copies
      WHERE operation_id = ? AND source_path = ? AND album_name = ?
    `);
    const rows = stmt.all(operationId, sourcePath, albumName) as { suffix: string }[];
    return new Set(rows.map((r) => r.suffix));
  }

  // Filter by specific rating key (including null for no filter)
  const stmt = db.prepare(`
    SELECT suffix FROM completed_album_copies
    WHERE operation_id = ? AND source_path = ? AND album_name = ?
      AND (rating_key IS ? OR (rating_key IS NULL AND ? IS NULL))
  `);

  const rows = stmt.all(operationId, sourcePath, albumName, ratingKey, ratingKey) as {
    suffix: string;
  }[];
  return new Set(rows.map((r) => r.suffix));
}

/**
 * Inventory file write parameters.
 */
interface InventoryFileRecordParams {
  sourcePath: string;
  relativePath: string;
  mtime: number;
  size: number;
  rating: number | null;
  genre?: string | null;
  year?: number | null;
  bpm?: number | null;
  artist?: string | null;
  destPath: string;
  contentHash?: string | null;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function validateContentHash(contentHash: string | null | undefined): void {
  if (contentHash !== null && contentHash !== undefined && !SHA256_HEX_PATTERN.test(contentHash)) {
    throw new Error("Invalid content hash: expected 64 lowercase hexadecimal characters.");
  }
}

/**
 * Records an inventory file entry with extended metadata support.
 *
 * Extended metadata fields (genre, year, bpm, artist) are nullable
 * for backward compatibility with existing inventory entries.
 */
export function recordInventoryFile(
  db: DbConnection,
  operationId: number,
  entry: InventoryFileRecordParams,
): void {
  validateContentHash(entry.contentHash);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO inventory (
      operation_id, source_path, relative_path, mtime, size, rating,
      genre, year, bpm, artist, dest_path, content_hash, copied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    operationId,
    entry.sourcePath,
    entry.relativePath,
    entry.mtime,
    entry.size,
    entry.rating,
    entry.genre ?? null,
    entry.year ?? null,
    entry.bpm ?? null,
    entry.artist ?? null,
    entry.destPath,
    entry.contentHash ?? null,
    Date.now(),
  );
}

/**
 * Records multiple inventory entries using one prepared statement and transaction.
 */
export function recordInventoryFiles(
  db: DbConnection,
  operationId: number,
  entries: InventoryFileRecordParams[],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO inventory (
      operation_id, source_path, relative_path, mtime, size, rating,
      genre, year, bpm, artist, dest_path, content_hash, copied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const copiedAt = Date.now();
  const insertMany = db.transaction((records: InventoryFileRecordParams[]) => {
    for (const entry of records) {
      validateContentHash(entry.contentHash);
      stmt.run(
        operationId,
        entry.sourcePath,
        entry.relativePath,
        entry.mtime,
        entry.size,
        entry.rating,
        entry.genre ?? null,
        entry.year ?? null,
        entry.bpm ?? null,
        entry.artist ?? null,
        entry.destPath,
        entry.contentHash ?? null,
        copiedAt,
      );
    }
  });

  insertMany(entries);
}

/**
 * Gets inventory entries for an operation.
 */
export function getInventory(db: DbConnection, operationId: number): DbInventoryEntry[] {
  const stmt = db.prepare(`
    SELECT * FROM inventory
    WHERE operation_id = ?
    ORDER BY source_path, relative_path
  `);

  return stmt.all(operationId) as DbInventoryEntry[];
}

/**
 * Gets inventory entries for a specific source within an operation.
 */
export function getInventoryForSource(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
): DbInventoryEntry[] {
  const stmt = db.prepare(`
    SELECT * FROM inventory
    WHERE operation_id = ? AND source_path = ?
    ORDER BY relative_path
  `);

  return stmt.all(operationId, sourcePath) as DbInventoryEntry[];
}

function assertFiniteNonNegativeNumber(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `Invalid inventory fingerprint: ${field} must be a finite non-negative number.`,
    );
  }
}

function assertNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be a non-negative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be a positive safe integer.`);
  }
}

function assertNullableFiniteNumber(value: unknown, field: string): asserts value is number | null {
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be null or a finite number.`);
  }
}

function assertNullableSafeInteger(value: unknown, field: string): asserts value is number | null {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be null or a safe integer.`);
  }
}

function assertNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`Invalid inventory fingerprint: ${field} must be null or a string.`);
  }
}

function assertAbsoluteInventoryPath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !isAbsolute(value)
  ) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be an absolute path.`);
  }
}

function assertRelativeInventoryPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    isAbsolute(value) ||
    normalize(value) !== value ||
    value === "." ||
    value
      .split(/[\\/]/u)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Invalid inventory fingerprint: relative_path must be a normalized relative path.",
    );
  }
}

function assertInventoryEntry(row: unknown): asserts row is DbInventoryEntry {
  if (typeof row !== "object" || row === null) {
    throw new Error("Invalid inventory fingerprint: candidate must be a database row.");
  }

  const candidate = row as Record<string, unknown>;
  assertPositiveSafeInteger(candidate["id"], "id");
  assertPositiveSafeInteger(candidate["operation_id"], "operation_id");
  assertAbsoluteInventoryPath(candidate["source_path"], "source_path");
  assertRelativeInventoryPath(candidate["relative_path"]);
  assertFiniteNonNegativeNumber(candidate["mtime"], "mtime");
  assertNonNegativeSafeInteger(candidate["size"], "size");
  assertNullableFiniteNumber(candidate["rating"], "rating");
  assertNullableString(candidate["genre"], "genre");
  assertNullableSafeInteger(candidate["year"], "year");
  assertNullableFiniteNumber(candidate["bpm"], "bpm");
  assertNullableString(candidate["artist"], "artist");
  assertAbsoluteInventoryPath(candidate["dest_path"], "dest_path");
  assertNullableString(candidate["content_hash"], "content_hash");
  assertFiniteNonNegativeNumber(candidate["copied_at"], "copied_at");
}

function assertInventoryFingerprint(row: unknown): asserts row is DbInventoryFingerprint {
  assertInventoryEntry(row);

  const candidate = row as unknown as Record<string, unknown>;
  assertNullableString(candidate["convert_key"], "convert_key");
}

/**
 * Gets all fingerprint candidates for exact source paths.
 *
 * Results retain duplicates for ambiguity classification and are ordered by
 * newest inventory timestamp, then newest inventory row ID. Digest strings
 * are structurally validated but deliberately not interpreted here so the
 * verification policy can report invalid fingerprints per artifact.
 */
export function getInventoryFingerprintCandidates(
  db: DbConnection,
  sourcePaths: readonly string[],
): DbInventoryFingerprint[] {
  if (sourcePaths.length === 0) {
    return [];
  }

  const placeholders = sourcePaths.map(() => "?").join(", ");
  const query = `
SELECT
  inventory.id,
  inventory.operation_id,
  inventory.source_path,
  inventory.relative_path,
  inventory.mtime,
  inventory.size,
  inventory.rating,
  inventory.genre,
  inventory.year,
  inventory.bpm,
  inventory.artist,
  inventory.dest_path,
  inventory.content_hash,
  inventory.copied_at,
  operations.convert_key
FROM inventory
INNER JOIN operations ON operations.id = inventory.operation_id
WHERE inventory.source_path IN (${placeholders})
ORDER BY inventory.copied_at DESC, inventory.id DESC
`;
  const rows = db.prepare(query).all(...sourcePaths) as unknown[];

  const candidates: DbInventoryFingerprint[] = [];
  for (const row of rows) {
    assertInventoryFingerprint(row);
    candidates.push(row);
  }

  return candidates;
}

/**
 * Creates a new history session record.
 *
 * @param db - Database connection
 * @param params - History session parameters
 * @returns Session ID (database primary key)
 */
export function createHistorySession(db: DbConnection, params: CreateHistorySessionParams): number {
  const stmt = db.prepare(`
    INSERT INTO history_sessions (
      session_id, version, command, started_at, status, cwd, operation_count
    ) VALUES (?, ?, ?, ?, 'pending', ?, 0)
  `);

  const result = stmt.run(
    params.sessionId,
    params.version,
    params.command,
    params.startedAt,
    params.cwd,
  );

  const sessionId = Number(result.lastInsertRowid);
  logDebug(`Created history session ${sessionId}: ${params.sessionId}`);
  return sessionId;
}

/**
 * Finds a history session by session_id string.
 *
 * @param db - Database connection
 * @param sessionId - Session ID string (e.g., "2024-01-01T12:00:00.000Z-copy-12345")
 * @returns History session or null if not found
 */
export function findHistorySession(db: DbConnection, sessionId: string): DbHistorySession | null {
  const stmt = db.prepare("SELECT * FROM history_sessions WHERE session_id = ?");
  return (stmt.get(sessionId) as DbHistorySession | undefined) ?? null;
}

/**
 * Gets history sessions with optional filtering.
 *
 * @param db - Database connection
 * @param filter - Optional filter criteria
 * @returns Array of history sessions
 */
export function getHistorySessions(
  db: DbConnection,
  filter?: HistorySessionFilter,
): DbHistorySession[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.status !== undefined) {
    conditions.push("status = ?");
    values.push(filter.status);
  }
  if (filter?.command !== undefined) {
    conditions.push("command = ?");
    values.push(filter.command);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter?.limit !== undefined ? "LIMIT ?" : "";

  const stmt = db.prepare(`
    SELECT * FROM history_sessions
    ${where}
    ORDER BY started_at DESC
    ${limit}
  `);

  // Add limit value to parameters if specified
  if (filter?.limit !== undefined) {
    values.push(filter.limit);
  }

  return stmt.all(...values) as DbHistorySession[];
}

/**
 * Closes a history session (updates ended_at and operation_count).
 *
 * @param db - Database connection
 * @param sessionId - Session ID (database primary key)
 * @param endedAt - ISO timestamp
 * @param operationCount - Total number of operations
 */
export function closeHistorySession(
  db: DbConnection,
  sessionId: number,
  endedAt: string,
  operationCount: number,
): void {
  const stmt = db.prepare(`
    UPDATE history_sessions
    SET ended_at = ?, operation_count = ?
    WHERE id = ?
  `);

  stmt.run(endedAt, operationCount, sessionId);
  logDebug(`Closed history session ${sessionId}`);
}

/**
 * Updates a history session status.
 *
 * @param db - Database connection
 * @param sessionId - Session ID string (e.g., "2024-01-01T12:00:00.000Z-copy-12345")
 * @param status - New status
 */
export function updateHistorySessionStatus(
  db: DbConnection,
  sessionId: string,
  status: "pending" | "undone" | "partial",
): void {
  const stmt = db.prepare(`
    UPDATE history_sessions
    SET status = ?
    WHERE session_id = ?
  `);

  stmt.run(status, sessionId);
  logDebug(`Updated history session ${sessionId} status to: ${status}`);
}

/**
 * Records a history operation.
 *
 * @param db - Database connection
 * @param params - Operation parameters
 */
export function recordHistoryOperation(
  db: DbConnection,
  params: RecordHistoryOperationParams,
): void {
  const stmt = db.prepare(`
    INSERT INTO history_operations (
      session_id, operation_type, occurred_at, source_path, dest_path,
      created_dir, convert_format
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.sessionId,
    params.operationType,
    params.occurredAt,
    params.sourcePath ?? null,
    params.destPath,
    params.createdDir ? 1 : 0,
    params.convertFormat ?? null,
  );

  logDebug(`Recorded history operation: ${params.operationType} for session ${params.sessionId}`);
}

/**
 * Gets all operations for a history session.
 *
 * @param db - Database connection
 * @param sessionId - Session ID (database primary key)
 * @returns Array of history operations
 */
export function getHistoryOperations(db: DbConnection, sessionId: number): DbHistoryOperation[] {
  const stmt = db.prepare(`
    SELECT * FROM history_operations
    WHERE session_id = ?
    ORDER BY occurred_at
  `);

  return stmt.all(sessionId) as DbHistoryOperation[];
}

/**
 * Deletes a single completed album copy entry.
 *
 * Used by the delete command to remove tracking entries when
 * album copies are deleted from the filesystem.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param albumName - Album folder name
 * @param suffix - Suffix that was deleted (e.g., '001', '002')
 * @param ratingKey - Rating filter key (e.g., 'r80', 's3', null for no filter)
 * @returns true if an entry was deleted, false if not found
 */
export function deleteCompletedAlbumCopy(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  albumName: string,
  suffix: string,
  ratingKey?: string | null,
): boolean {
  const effectiveRatingKey = ratingKey ?? null;

  const stmt = db.prepare(`
    DELETE FROM completed_album_copies
    WHERE operation_id = ?
      AND source_path = ?
      AND album_name = ?
      AND suffix = ?
      AND (rating_key IS ? OR (rating_key IS NULL AND ? IS NULL))
  `);

  const result = stmt.run(
    operationId,
    sourcePath,
    albumName,
    suffix,
    effectiveRatingKey,
    effectiveRatingKey,
  );
  const deleted = result.changes > 0;

  if (deleted) {
    const ratingPart = effectiveRatingKey ? ` (rating: ${effectiveRatingKey})` : "";
    logDebug(`Deleted completed album copy: ${sourcePath}/${albumName}-${suffix}${ratingPart}`);
  }

  return deleted;
}

/**
 * Deletes completed album copy entries by source path and album/suffix.
 *
 * This function deletes entries from ALL operations, not just a specific one.
 * This is used by the delete command to ensure files can be re-copied
 * regardless of which operation originally created them.
 *
 * @param db - Database connection
 * @param sourcePath - Source directory path
 * @param albumName - Album folder name
 * @param suffix - Suffix that was deleted (e.g., '001', '002')
 * @returns Number of entries deleted (may be > 1 if multiple operations)
 */
export function deleteCompletedAlbumCopyByPath(
  db: DbConnection,
  sourcePath: string,
  albumName: string,
  suffix: string,
): number {
  const stmt = db.prepare(`
    DELETE FROM completed_album_copies
    WHERE source_path = ?
      AND album_name = ?
      AND suffix = ?
  `);

  const result = stmt.run(sourcePath, albumName, suffix);
  const deleted = result.changes;

  if (deleted > 0) {
    logDebug(
      `Deleted ${deleted} completed album copy entries: ${sourcePath}/${albumName}-${suffix}`,
    );
  }

  return deleted;
}

// =============================================================================
// Plex Query CRUD Operations
// =============================================================================

/**
 * Creates a new Plex query record.
 *
 * @param db - Database connection
 * @param params - Query parameters
 * @returns Query ID
 */
export function createPlexQuery(db: DbConnection, params: CreatePlexQueryParams): number {
  const stmt = db.prepare(`
    INSERT INTO plex_queries (
      created_at, library_name, media_type, filters_json, status, name
    ) VALUES (?, ?, ?, ?, 'pending', ?)
  `);

  const now = new Date().toISOString();
  const filtersJson = JSON.stringify(params.filters);

  const result = stmt.run(
    now,
    params.libraryName,
    params.mediaType,
    filtersJson,
    params.name ?? null,
  );

  const queryId = Number(result.lastInsertRowid);
  logDebug(`Created Plex query ${queryId}: ${params.libraryName} (${params.mediaType})`);
  return queryId;
}

/**
 * Updates a Plex query status and result counts.
 *
 * @param db - Database connection
 * @param queryId - Query ID
 * @param status - New status
 * @param resultCount - Number of results returned
 * @param totalCount - Total matches available in Plex
 */
export function updatePlexQueryStatus(
  db: DbConnection,
  queryId: number,
  status: "pending" | "completed" | "failed",
  resultCount?: number,
  totalCount?: number,
): void {
  const updates: string[] = ["status = ?"];
  const values: unknown[] = [status];

  if (resultCount !== undefined) {
    updates.push("result_count = ?");
    values.push(resultCount);
  }
  if (totalCount !== undefined) {
    updates.push("total_count = ?");
    values.push(totalCount);
  }

  const stmt = db.prepare(`
    UPDATE plex_queries
    SET ${updates.join(", ")}
    WHERE id = ?
  `);

  stmt.run(...values, queryId);
  logDebug(`Updated Plex query ${queryId} status to: ${status}`);
}

/**
 * Gets a Plex query by ID.
 *
 * @param db - Database connection
 * @param queryId - Query ID
 * @returns Query record or null if not found
 */
export function getPlexQuery(db: DbConnection, queryId: number): DbPlexQuery | null {
  const stmt = db.prepare("SELECT * FROM plex_queries WHERE id = ?");
  return (stmt.get(queryId) as DbPlexQuery | undefined) ?? null;
}

/**
 * Lists Plex queries with optional filtering.
 *
 * @param db - Database connection
 * @param options - Filter options
 * @returns Array of query records
 */
export function listPlexQueries(db: DbConnection, options?: PlexQueryListOptions): DbPlexQuery[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options?.libraryName !== undefined) {
    conditions.push("library_name = ?");
    values.push(options.libraryName);
  }
  if (options?.mediaType !== undefined) {
    conditions.push("media_type = ?");
    values.push(options.mediaType);
  }
  if (options?.status !== undefined) {
    conditions.push("status = ?");
    values.push(options.status);
  }
  if (options?.name !== undefined) {
    conditions.push("name LIKE ?");
    values.push(`%${options.name}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit !== undefined ? "LIMIT ?" : "";

  const stmt = db.prepare(`
    SELECT * FROM plex_queries
    ${where}
    ORDER BY created_at DESC
    ${limit}
  `);

  // Add limit value to parameters if specified
  if (options?.limit !== undefined) {
    values.push(options.limit);
  }

  return stmt.all(...values) as DbPlexQuery[];
}

/**
 * Saves Plex query results to the database.
 *
 * @param db - Database connection
 * @param queryId - Query ID
 * @param results - Array of result items to save
 * @returns Number of results saved
 */
export function savePlexQueryResults(
  db: DbConnection,
  queryId: number,
  results: PlexQueryResultItem[],
): number {
  if (results.length === 0) {
    return 0;
  }

  const stmt = db.prepare(`
    INSERT INTO plex_query_results (
      query_id, rating_key, media_type, title, artist, album,
      user_rating, view_count, year, file_path, track_count, album_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: PlexQueryResultItem[]) => {
    let count = 0;
    for (const item of items) {
      stmt.run(
        queryId,
        item.ratingKey,
        item.mediaType,
        item.title,
        item.artist ?? null,
        item.album ?? null,
        item.userRating,
        item.viewCount ?? null,
        item.year ?? null,
        item.filePath ?? null,
        item.trackCount ?? null,
        item.albumCount ?? null,
      );
      count++;
    }
    return count;
  });

  const savedCount = insertMany(results);
  logDebug(`Saved ${savedCount} Plex query results for query ${queryId}`);
  return savedCount;
}

/**
 * Gets all results for a Plex query.
 *
 * @param db - Database connection
 * @param queryId - Query ID
 * @returns Array of result records
 */
export function getPlexQueryResults(db: DbConnection, queryId: number): DbPlexQueryResult[] {
  const stmt = db.prepare(`
    SELECT * FROM plex_query_results
    WHERE query_id = ?
    ORDER BY id
  `);

  return stmt.all(queryId) as DbPlexQueryResult[];
}

// =============================================================================
// Smart Playlist CRUD Operations
// =============================================================================

/**
 * Creates a new smart playlist.
 *
 * @param db - Database connection
 * @param params - Smart playlist parameters
 * @returns The new playlist ID
 */
export function createSmartPlaylist(db: DbConnection, params: CreateSmartPlaylistParams): number {
  const stmt = db.prepare(`
    INSERT INTO smart_playlists (name, output_path, source_type, source_name, relative_paths)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    params.name,
    params.outputPath,
    params.sourceType,
    params.sourceName,
    params.relativePaths ? 1 : 0,
  );

  const playlistId = Number(result.lastInsertRowid);
  logDebug(`Created smart playlist ${playlistId}: ${params.name}`);
  return playlistId;
}

/**
 * Gets a smart playlist by name.
 *
 * @param db - Database connection
 * @param name - Playlist name
 * @returns The playlist record or null if not found
 */
export function getSmartPlaylist(db: DbConnection, name: string): DbSmartPlaylist | null {
  const stmt = db.prepare("SELECT * FROM smart_playlists WHERE name = ?");
  return (stmt.get(name) as DbSmartPlaylist | undefined) ?? null;
}

/**
 * Lists all smart playlists.
 *
 * @param db - Database connection
 * @returns Array of all smart playlists ordered by name
 */
export function listSmartPlaylists(db: DbConnection): DbSmartPlaylist[] {
  const stmt = db.prepare(`
    SELECT * FROM smart_playlists
    ORDER BY name
  `);

  return stmt.all() as DbSmartPlaylist[];
}

/**
 * Updates a smart playlist's track count, config, and updated_at timestamp.
 * Pass full config (outputPath, sourceType, sourceName, relativePaths) when
 * recreating a playlist with the same name so the DB stays in sync.
 *
 * @param db - Database connection
 * @param id - Playlist ID
 * @param params - Update parameters
 */
export function updateSmartPlaylist(
  db: DbConnection,
  id: number,
  params: UpdateSmartPlaylistParams,
): void {
  const updates: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (params.trackCount !== undefined) {
    updates.push("track_count = ?");
    values.push(params.trackCount);
  }
  if (params.outputPath !== undefined) {
    updates.push("output_path = ?");
    values.push(params.outputPath);
  }
  if (params.sourceType !== undefined) {
    updates.push("source_type = ?");
    values.push(params.sourceType);
  }
  if (params.sourceName !== undefined) {
    updates.push("source_name = ?");
    values.push(params.sourceName);
  }
  if (params.relativePaths !== undefined) {
    updates.push("relative_paths = ?");
    values.push(params.relativePaths ? 1 : 0);
  }

  const stmt = db.prepare(`
    UPDATE smart_playlists
    SET ${updates.join(", ")}
    WHERE id = ?
  `);

  stmt.run(...values, id);
  logDebug(`Updated smart playlist ${id}`);
}

/**
 * Deletes a smart playlist and its history/tracks (via CASCADE).
 *
 * @param db - Database connection
 * @param id - Playlist ID
 * @returns true if playlist was deleted, false if not found
 */
export function deleteSmartPlaylist(db: DbConnection, id: number): boolean {
  const stmt = db.prepare("DELETE FROM smart_playlists WHERE id = ?");
  const result = stmt.run(id);
  const deleted = result.changes > 0;

  if (deleted) {
    logDebug(`Deleted smart playlist ${id} and its history`);
  }

  return deleted;
}

/**
 * Records a playlist generation with its tracks.
 *
 * Creates a history entry and stores all track information for the generation.
 *
 * @param db - Database connection
 * @param playlistId - Smart playlist ID
 * @param tracks - Array of track information to record
 * @returns The new history record ID
 */
export function recordPlaylistHistory(
  db: DbConnection,
  playlistId: number,
  tracks: SmartPlaylistTrackInfo[],
): number {
  const historyStmt = db.prepare(`
    INSERT INTO smart_playlist_history (playlist_id, track_count)
    VALUES (?, ?)
  `);

  const historyResult = historyStmt.run(playlistId, tracks.length);
  const historyId = Number(historyResult.lastInsertRowid);

  if (tracks.length > 0) {
    const trackStmt = db.prepare(`
      INSERT INTO smart_playlist_tracks (history_id, track_order, file_path, title, artist, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertTracks = db.transaction((trackList: SmartPlaylistTrackInfo[]) => {
      for (let i = 0; i < trackList.length; i++) {
        const track = trackList[i];
        if (track) {
          trackStmt.run(
            historyId,
            i + 1,
            track.filePath,
            track.title ?? null,
            track.artist ?? null,
            track.durationMs ?? null,
          );
        }
      }
    });

    insertTracks(tracks);
  }

  logDebug(`Recorded playlist history ${historyId} with ${tracks.length} tracks`);
  return historyId;
}

/**
 * Gets the generation history for a smart playlist.
 *
 * @param db - Database connection
 * @param playlistId - Smart playlist ID
 * @param limit - Maximum number of history entries to return (default: 10)
 * @returns Array of history records ordered by most recent first
 */
export function getSmartPlaylistHistory(
  db: DbConnection,
  playlistId: number,
  limit: number = 10,
): DbSmartPlaylistHistory[] {
  const stmt = db.prepare(`
    SELECT * FROM smart_playlist_history
    WHERE playlist_id = ?
    ORDER BY generated_at DESC
    LIMIT ?
  `);

  return stmt.all(playlistId, limit) as DbSmartPlaylistHistory[];
}

/**
 * Closes the database connection.
 */
export function closeDatabase(db: DbConnection): void {
  db.close();
  logDebug("Database connection closed");
}
