/**
 * Core database module for rfapps CLI.
 *
 * Provides SQLite-based state persistence for deployment history and rollback capabilities.
 * The database stores deployment records including service configurations, image tags,
 * and status information that enables rollback to previous states.
 *
 * Database location follows XDG Base Directory Specification:
 * - Default: ~/.config/rfapps/state.db (XDG compliant)
 * - Legacy: ~/.rfapps/state.db (if directory exists from older installations)
 *
 * The module handles:
 * - Database initialization and schema setup
 * - XDG-compliant path resolution with legacy fallback
 * - Foreign key enforcement
 * - Sequential migration execution
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readFile, mkdir, access, constants, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { logDebug } from "@rfmedia/common";
import { runMigrations } from "./migrations.js";

/**
 * Database connection type alias for better-sqlite3 Database instance.
 */
export type DbConnection = Database.Database;

/**
 * Default database filename.
 */
const DEFAULT_DB_NAME = "state.db";

/**
 * XDG-compliant directory for rfapps state files.
 */
const XDG_RFAPPS_DIR = join(homedir(), ".config", "rfapps");

/**
 * Legacy directory for rfapps state files.
 */
const LEGACY_RFAPPS_DIR = join(homedir(), ".rfapps");

/**
 * Determines the preferred directory for state files.
 *
 * Resolution order:
 * 1. If ~/.config/rfapps/ exists, use it (XDG compliant)
 * 2. If ~/.rfapps/ exists, use it (legacy location)
 * 3. Otherwise, prefer ~/.config/rfapps/ for new installations (XDG standard)
 *
 * @returns The preferred directory path for state files
 */
function getPreferredStateDir(): string {
  // Check XDG location first
  if (existsSync(XDG_RFAPPS_DIR)) {
    return XDG_RFAPPS_DIR;
  }

  // Check legacy location
  if (existsSync(LEGACY_RFAPPS_DIR)) {
    return LEGACY_RFAPPS_DIR;
  }

  // Default to XDG for new installations
  return XDG_RFAPPS_DIR;
}

/**
 * Returns the default database path.
 *
 * The location follows XDG preference:
 * - ~/.config/rfapps/state.db (preferred, XDG compliant)
 * - ~/.rfapps/state.db (legacy fallback if directory exists)
 *
 * @returns The absolute path to the default database file
 */
export function getDefaultDatabasePath(): string {
  return join(getPreferredStateDir(), DEFAULT_DB_NAME);
}

/**
 * Reads and returns the SQL schema.
 *
 * @returns The schema SQL content
 */
async function loadSchema(): Promise<string> {
  // Schema file is in same directory as this module
  const schemaPath = new URL("./schema.sql", import.meta.url).pathname;
  return await readFile(schemaPath, "utf-8");
}

/**
 * Checks if a path exists and is accessible.
 *
 * @param path - The path to check
 * @returns true if path exists, false otherwise
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initializes the database connection and creates tables if needed.
 *
 * Creates the parent directory if it doesn't exist, opens the database,
 * enables foreign keys, executes the schema SQL to create tables, and
 * runs any pending migrations.
 *
 * @param dbPath - Path to database file (defaults to XDG-compliant location)
 * @returns Database connection ready for queries
 * @throws Error if the database cannot be opened or schema fails to initialize
 *
 * @example
 * ```typescript
 * // Initialize with default path (~/.config/rfapps/state.db)
 * const db = await initializeDatabase();
 *
 * // Initialize with custom path
 * const testDb = await initializeDatabase('/tmp/test-state.db');
 *
 * // Always close when done
 * closeDatabase(db);
 * ```
 */
export async function initializeDatabase(dbPath?: string): Promise<DbConnection> {
  const path = dbPath ?? getDefaultDatabasePath();

  // Ensure parent directory exists with restrictive permissions (owner only)
  const dir = dirname(path);
  if (!(await pathExists(dir))) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    logDebug(`Created database directory: ${dir} (mode 700)`);
  }

  // Track if this is a new database file
  const isNewDb = !(await pathExists(path));

  // Open database connection
  const db = new Database(path);
  logDebug(`Opened database: ${path}`);

  // Set restrictive permissions on database file (owner read/write only)
  // Only set on new databases to avoid permission changes on existing files
  if (isNewDb) {
    try {
      await chmod(path, 0o600);
      logDebug(`Set database file permissions: 600`);
    } catch (err) {
      // Non-fatal: permissions might fail on some filesystems
      logDebug(`Could not set database permissions: ${err}`);
    }
  }

  // Enable foreign keys
  db.pragma("foreign_keys = ON");

  // Load and execute schema
  const schema = await loadSchema();
  db.exec(schema);
  logDebug("Database schema initialized");

  // Run any pending migrations
  runMigrations(db);

  return db;
}

/**
 * Closes the database connection.
 *
 * @param db - Database connection to close
 */
export function closeDatabase(db: DbConnection): void {
  db.close();
  logDebug("Database connection closed");
}

/**
 * Gets the current schema version from the database.
 *
 * Reads the schema_version from the metadata table. Returns 0 if the
 * metadata table does not exist or the version is not set.
 *
 * Used by the migration system to determine which migrations need to run.
 *
 * @param db - Database connection
 * @returns The current schema version number (0 if not set)
 *
 * @example
 * ```typescript
 * const version = getCurrentSchemaVersion(db);
 * if (version < CURRENT_SCHEMA_VERSION) {
 *   runMigrations(db);
 * }
 * ```
 */
export function getCurrentSchemaVersion(db: DbConnection): number {
  const stmt = db.prepare("SELECT value FROM metadata WHERE key = ?");
  const row = stmt.get("schema_version") as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

/**
 * Updates the stored schema version in the metadata table.
 *
 * Called by the migration system at the end of each migration to record
 * that the database has been upgraded to the given version.
 *
 * @param db - Database connection
 * @param version - The schema version to record
 *
 * @example
 * ```typescript
 * const migrate = db.transaction(() => {
 *   db.exec("ALTER TABLE deployments ADD COLUMN new_field TEXT");
 *   updateSchemaVersion(db, 2);
 * });
 * migrate();
 * ```
 */
export function updateSchemaVersion(db: DbConnection, version: number): void {
  const stmt = db.prepare(
    "INSERT INTO metadata (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  stmt.run(version.toString());
  logDebug(`Updated schema version to ${version}`);
}
