/**
 * Database migration system for rfapps CLI.
 *
 * Handles schema version upgrades with sequential migrations. Migrations are
 * executed in order when the database schema version is behind the current
 * application version.
 *
 * Migration Design:
 * - Each migration runs in a transaction for atomicity
 * - Migrations are sequential (v1 -> v2 -> v3)
 * - Failed migrations roll back, leaving database in previous state
 * - Schema version is stored in the metadata table
 *
 * Adding New Migrations:
 * 1. Increment CURRENT_SCHEMA_VERSION
 * 2. Add a new conditional block: `if (currentVersion < N) { ... }`
 * 3. Wrap migration SQL in a transaction
 * 4. Call updateSchemaVersion(db, N) at the end of the migration
 */

import type { DbConnection } from "./db.js";
import { getCurrentSchemaVersion, updateSchemaVersion } from "./db.js";
import { logDebug } from "@rfmedia/common";

/**
 * Current schema version.
 *
 * Increment this constant when adding new migrations. The migration system
 * compares this value against the stored schema_version in the database
 * to determine which migrations need to run.
 */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * Maps schema versions to minimum CLI versions that support them.
 *
 * Update this when adding new migrations. This mapping is used to provide
 * helpful error messages when a database was created with a newer CLI version.
 */
const SCHEMA_VERSION_CLI_MAP: Record<number, string> = {
  1: "1.0.0", // Initial state file support
  2: "0.5.0", // Generational snapshots (generations table)
  3: "0.5.0", // Immutable image identity for deployments and generations
};

/**
 * Adds a nullable column only when it is absent from an existing table.
 *
 * `initializeDatabase()` intentionally applies the current `schema.sql` before
 * migrations so new tables and indexes are created idempotently. On an older
 * database that means a table introduced after its recorded schema version may
 * already have current columns while pre-existing tables do not. SQLite does
 * not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so migrations must
 * inspect each table instead of assuming every column is uniformly old.
 */
function addNullableTextColumnIfMissing(
  db: DbConnection,
  table: "deployments" | "generations",
  column: "image_id" | "image_digest",
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
}

function ensureRecoveryLookupIndex(db: DbConnection): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_generations_service_image_id_generation
      ON generations(service, image_id, generation DESC)
  `);
}

/**
 * Runs all pending migrations on the database.
 *
 * Migrations are executed sequentially in order. Each migration is wrapped
 * in a transaction for atomicity - if a migration fails, the database state
 * is rolled back to before that migration started.
 *
 * This function is idempotent: calling it multiple times on an up-to-date
 * database has no effect.
 *
 * @param db - Database connection (must be initialized)
 * @throws Error if database version is newer than the CLI supports (indicates
 *         the user needs to upgrade rfapps CLI)
 *
 * @example
 * ```typescript
 * const db = new Database('/path/to/state.db');
 * db.exec(schema); // Initialize tables
 * runMigrations(db); // Upgrade schema if needed
 * ```
 */
export function runMigrations(db: DbConnection): void {
  const currentVersion = getCurrentSchemaVersion(db);

  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    ensureRecoveryLookupIndex(db);
    logDebug(`Database schema is up to date (version ${currentVersion})`);
    return;
  }

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    const minCliVersion = SCHEMA_VERSION_CLI_MAP[currentVersion] ?? "unknown";
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}. ` +
        `This database requires rfapps CLI version ${minCliVersion} or later. ` +
        `Current CLI supports schema version ${CURRENT_SCHEMA_VERSION}. ` +
        "Please upgrade rfapps CLI to use this state database.",
    );
  }

  logDebug(`Database schema needs upgrade: ${currentVersion} -> ${CURRENT_SCHEMA_VERSION}`);

  // Run migrations sequentially
  // Version 1: Initial schema (handled by schema.sql, no migration needed)

  // Version 2: Generational snapshots.
  // Creates the immutable generations table and backfills one generation per
  // successful deploy-like deployment, numbered per service in chronological
  // order. The table/index DDL is idempotent because schema.sql also creates
  // them for fresh databases before migrations run.
  if (currentVersion < 2) {
    logDebug("Migrating from version 1 to version 2: generational snapshots");
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS generations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          service TEXT NOT NULL,
          generation INTEGER NOT NULL,
          deployment_id INTEGER,
          timestamp TEXT NOT NULL,
          image_tag TEXT,
          config_snapshot TEXT,
          created_by_action TEXT NOT NULL,
          UNIQUE (service, generation),
          FOREIGN KEY (deployment_id) REFERENCES deployments(id)
        );
        CREATE INDEX IF NOT EXISTS idx_generations_service ON generations(service);
        CREATE INDEX IF NOT EXISTS idx_generations_timestamp ON generations(timestamp);
      `);

      // Backfill generations from existing successful deploy-like deployments
      // so restore-by-generation works on pre-existing history. Only runs when
      // the table is empty to keep the migration idempotent.
      const existing = db.prepare("SELECT COUNT(*) as count FROM generations").get() as {
        count: number;
      };
      if (existing.count === 0) {
        db.exec(`
          INSERT INTO generations (
            service, generation, deployment_id, timestamp,
            image_tag, config_snapshot, created_by_action
          )
          SELECT
            service,
            ROW_NUMBER() OVER (PARTITION BY service ORDER BY timestamp ASC, id ASC),
            id,
            timestamp,
            image_tag,
            config_snapshot,
            action
          FROM deployments
          WHERE status = 'success'
            AND action IN ('deploy', 'rebuild', 'apply', 'rollback')
        `);
      }

      updateSchemaVersion(db, 2);
    });
    migrate();
    logDebug("Migration to version 2 complete");
  }

  // Version 3: Immutable image identity.
  // Adds nullable columns without backfilling legacy deployment or generation
  // rows, which do not have a trustworthy immutable identity to record.
  if (currentVersion < 3) {
    logDebug("Migrating from version 2 to version 3: immutable image identity");
    const migrate = db.transaction(() => {
      addNullableTextColumnIfMissing(db, "deployments", "image_id");
      addNullableTextColumnIfMissing(db, "deployments", "image_digest");
      addNullableTextColumnIfMissing(db, "generations", "image_id");
      addNullableTextColumnIfMissing(db, "generations", "image_digest");
      ensureRecoveryLookupIndex(db);

      updateSchemaVersion(db, 3);
    });
    migrate();
    logDebug("Migration to version 3 complete");
  }

  logDebug("All migrations complete");
}
