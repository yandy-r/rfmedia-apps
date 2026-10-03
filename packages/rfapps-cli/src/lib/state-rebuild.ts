/**
 * SQLite primitives for rfapps state-database reconstruction.
 *
 * The state database is derived and re-derivable, so recovery is always
 * preferable to trusting a damaged file. Every primitive here upholds one
 * invariant: **the existing database is never opened read-write**. A suspect
 * file is probed and backed up through a read-only handle; the replacement is
 * built at a sibling temp path via `initializeDatabase(tempPath)` and swapped in
 * with `rename()`, so any failure before the swap is indistinguishable from
 * "nothing happened".
 *
 * Key functions:
 * - {@link openReadOnlyStateDatabase} - The only sanctioned source handle
 * - {@link probeStateDatabase} - Read-only diagnosis that never throws
 * - {@link readLatestRecordedImageIds} - Recorded identity per tracked service
 * - {@link carryOverState} - Salvage carry-over into a fresh replacement
 *
 * Filesystem artifacts ({@link buildReplacementDatabasePath},
 * {@link defaultBackupPath}, {@link backupStateDatabase},
 * {@link swapStateDatabase}) live in `./state-rebuild-files.js` and are
 * re-exported here, so this module stays the single entry point.
 *
 * Contract: corrupt input is the input this module exists for. Source reads are
 * individually guarded, invalid rows are discarded and counted, and no SQLite
 * error is ever propagated to the caller from a salvage.
 */

import Database from "better-sqlite3";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";

import { logDebug } from "@rfmedia/common";

import { getDefaultDatabasePath } from "./db.js";
import type { DbConnection } from "./db.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";
import type { DeploymentAction } from "../types/state.js";
import type { CarryOverCounts, StateDatabaseProbe } from "../types/state-rebuild.js";

export {
  buildReplacementDatabasePath,
  defaultBackupPath,
  backupStateDatabase,
  swapStateDatabase,
} from "./state-rebuild-files.js";

/** A raw row read from a source database of unknown schema version. */
type SourceRow = Record<string, unknown>;

/** Tables this module reads from a source database. */
type StateTable = "deployments" | "generations";

/** `deployments` columns in the current schema, in insert order. */
const DEPLOYMENT_COLUMNS = [
  "id",
  "timestamp",
  "service",
  "action",
  "image_tag",
  "image_id",
  "image_digest",
  "config_snapshot",
  "status",
  "plan_id",
  "error_message",
] as const;

/** `generations` columns read from the source (`id` is only used for ordering). */
const GENERATION_SOURCE_COLUMNS = [
  "id",
  "service",
  "generation",
  "deployment_id",
  "timestamp",
  "image_tag",
  "image_id",
  "image_digest",
  "config_snapshot",
  "created_by_action",
] as const;

/** `generations` columns written to the replacement (`id` is reassigned). */
const GENERATION_INSERT_COLUMNS = [
  "service",
  "generation",
  "deployment_id",
  "timestamp",
  "image_tag",
  "image_id",
  "image_digest",
  "config_snapshot",
  "created_by_action",
] as const;

/** Upper bound for a sanitized diagnostic surfaced in the probe. */
const MAX_REASON_LENGTH = 200;

/** `schema.sql`'s `DEFAULT (datetime('now'))` form: `YYYY-MM-DD HH:MM:SS` (UTC). */
const SQL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

/** Absolute-path-looking token, scrubbed out of diagnostics before reporting. */
const ABSOLUTE_PATH_PATTERN = /\/[^\s:,;)"']+/gu;

/** Freshly zeroed carry-over accounting. */
function zeroCounts(): CarryOverCounts {
  return {
    deploymentsCarried: 0,
    deploymentsDiscarded: 0,
    generationsCarried: 0,
    generationsDiscarded: 0,
    generationsDerived: 0,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Coerces a SQLite value into something bindable to a TEXT column. */
function toNullableText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

/**
 * Runs one read against a possibly corrupt database.
 *
 * Every source read goes through here so a `SQLITE_NOTADB` (or a missing table
 * on a legacy schema) degrades to `undefined` instead of aborting the recovery.
 */
function guardedRead<T>(description: string, read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    logDebug(`Could not ${description}: ${describeError(error)}`);
    return undefined;
  }
}

/** Truncates a diagnostic and strips absolute paths other than the database's own. */
function sanitizeReason(error: unknown, dbPath: string): string {
  const scrubbed = describeError(error).replace(ABSOLUTE_PATH_PATTERN, (match) =>
    match === dbPath ? match : basename(match),
  );
  return scrubbed.length > MAX_REASON_LENGTH
    ? `${scrubbed.slice(0, MAX_REASON_LENGTH - 3)}...`
    : scrubbed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites SQLite's `datetime('now')` form to ISO 8601.
 *
 * Every ordering path in the codebase compares timestamps lexicographically and
 * `' '` (0x20) sorts before `'T'`, so mixed formats silently mis-sort within a
 * day. The SQL default is UTC, hence the `Z` suffix.
 */
function normalizeTimestamp(value: string): string {
  if (!SQL_DATETIME_PATTERN.test(value)) {
    return value;
  }
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Source table set, or `undefined` when even `sqlite_master` is unreadable. */
function readTableNames(db: DbConnection): Set<string> | undefined {
  return guardedRead("read the state database table list", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as SourceRow[];
    return new Set(rows.map((row) => row["name"]).filter(isNonEmptyString));
  });
}

/** Column set of one table, empty when the table is absent or unreadable. */
function readColumnNames(db: DbConnection, table: StateTable): Set<string> {
  return (
    guardedRead(`read the columns of "${table}"`, () => {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as SourceRow[];
      return new Set(rows.map((row) => row["name"]).filter(isNonEmptyString));
    }) ?? new Set<string>()
  );
}

/** Rows from an arbitrary read query, empty when the read fails. */
function readRows(db: DbConnection, sql: string): SourceRow[] {
  return (
    guardedRead("read rows from the source state database", () => {
      return db.prepare(sql).all() as SourceRow[];
    }) ?? []
  );
}

/** Opens the source read-only, keeping the failure so callers can report it. */
function openReadOnly(dbPath: string): { db?: DbConnection; error?: unknown } {
  try {
    return { db: new Database(dbPath, { readonly: true, fileMustExist: true }) };
  } catch (error) {
    return { error };
  }
}

/**
 * Opens an existing state database read-only.
 *
 * This is the ONLY sanctioned way to obtain a handle on a suspect database:
 * `initializeDatabase()` opens read-write, applies `schema.sql` and runs
 * migrations, so it throws on exactly the input that needs repair. It is called
 * exclusively on the replacement's temp path.
 *
 * @param dbPath - Absolute path to the existing database
 * @returns A read-only connection, or undefined when the file cannot be opened
 */
export function openReadOnlyStateDatabase(dbPath: string): DbConnection | undefined {
  const opened = openReadOnly(dbPath);
  if (opened.db === undefined) {
    logDebug(`Could not open state database read-only (${dbPath}): ${describeError(opened.error)}`);
  }
  return opened.db;
}

/**
 * Runs `PRAGMA integrity_check`, reporting rather than throwing.
 *
 * On a `SQLITE_NOTADB` file the read-only open succeeds and this is the first
 * call that fails, so its message ("file is not a database") is the diagnostic
 * the operator actually needs.
 *
 * @returns `{ reason: undefined }` when the database is intact
 */
function checkIntegrity(db: DbConnection, dbPath: string): { reason?: string } {
  try {
    const result = db.pragma("integrity_check", { simple: true });
    return result === "ok" ? {} : { reason: `PRAGMA integrity_check reported: ${String(result)}` };
  } catch (error) {
    return { reason: sanitizeReason(error, dbPath) };
  }
}

/**
 * Diagnoses an existing state database without ever opening it read-write.
 *
 * NEVER THROWS: a missing, corrupt, or future-schema file is a normal input to a
 * recovery command, so each condition is reported as a status rather than an
 * exception. Every count query is individually guarded and gated on
 * `sqlite_master` — a real v1 database has no `generations` table at all.
 *
 * @param dbPath - Resolved absolute path to the state database
 * @returns A secret-free diagnosis of the file
 */
export async function probeStateDatabase(dbPath: string): Promise<StateDatabaseProbe> {
  const isDefaultPath = dbPath === getDefaultDatabasePath();

  if (!(await pathExists(dbPath))) {
    return { path: dbPath, status: "missing", isDefaultPath };
  }

  const opened = openReadOnly(dbPath);
  const db = opened.db;
  if (db === undefined) {
    return {
      path: dbPath,
      status: "unreadable",
      isDefaultPath,
      reason: sanitizeReason(opened.error, dbPath),
    };
  }

  try {
    const integrity = checkIntegrity(db, dbPath);
    if (integrity.reason !== undefined) {
      return {
        path: dbPath,
        status: "unreadable",
        isDefaultPath,
        integrity: "failed",
        reason: integrity.reason,
      };
    }

    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion !== undefined && schemaVersion > CURRENT_SCHEMA_VERSION) {
      return {
        path: dbPath,
        status: "unreadable",
        isDefaultPath,
        integrity: "ok",
        schemaVersion,
        reason:
          `Stored schema version ${schemaVersion} is newer than this CLI supports ` +
          `(${CURRENT_SCHEMA_VERSION})`,
      };
    }

    const probe: StateDatabaseProbe = {
      path: dbPath,
      status: "readable",
      isDefaultPath,
      integrity: "ok",
      schemaVersion,
    };

    const tables = readTableNames(db) ?? new Set<string>();
    if (tables.has("deployments")) {
      probe.deployments = countRows(db, "deployments");
      probe.trackedServices = readRows(
        db,
        "SELECT DISTINCT service FROM deployments ORDER BY service",
      )
        .map((row) => row["service"])
        .filter(isNonEmptyString);
      const range = readRows(
        db,
        "SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM deployments",
      )[0];
      const oldest = range?.["oldest"];
      const newest = range?.["newest"];
      probe.oldestTimestamp = isNonEmptyString(oldest) ? oldest : undefined;
      probe.newestTimestamp = isNonEmptyString(newest) ? newest : undefined;
    }
    if (tables.has("generations")) {
      probe.generations = countRows(db, "generations");
    }

    return probe;
  } finally {
    db.close();
  }
}

function readSchemaVersion(db: DbConnection): number | undefined {
  const value = readRows(db, "SELECT value FROM metadata WHERE key = 'schema_version'")[0]?.[
    "value"
  ];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function countRows(db: DbConnection, table: StateTable): number | undefined {
  const count = readRows(db, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.["count"];
  return typeof count === "number" ? count : undefined;
}

/**
 * Reads the most recently recorded image id per service from a source database.
 *
 * NEVER THROWS. A service present with a NULL image id appears in the map with
 * value `undefined`, so the caller can distinguish "tracked but no recorded
 * identity" (a pre-v3 row, which migration v3 deliberately does not backfill)
 * from "not tracked at all".
 *
 * Both tables are read and MERGED per service: `generations` wins where it has a
 * row, `deployments` covers every service it does not.
 *
 * @param source - Read-only source connection
 * @returns Map of service name to recorded image id (or undefined)
 */
export function readLatestRecordedImageIds(source: DbConnection): Map<string, string | undefined> {
  const recorded = new Map<string, string | undefined>();

  /**
   * `generations` is the more authoritative source, so `deployments` only fills
   * gaps: a service whose generation row is missing must still contribute its
   * recorded identity, or it is reported as drifted purely for being absent.
   */
  const collect = (rows: SourceRow[], keepExisting: boolean): void => {
    for (const row of rows) {
      const service = row["service"];
      if (!isNonEmptyString(service) || (keepExisting && recorded.has(service))) {
        continue;
      }
      const imageId = row["image_id"];
      recorded.set(service, isNonEmptyString(imageId) ? imageId : undefined);
    }
  };

  /** A v2 source has no `image_id` column; report "tracked, no identity". */
  const identityColumn = (table: StateTable): string =>
    readColumnNames(source, table).has("image_id") ? "image_id" : "NULL AS image_id";

  const tables = readTableNames(source);
  if (tables === undefined) {
    return recorded;
  }

  if (tables.has("generations")) {
    collect(
      readRows(
        source,
        `SELECT service, ${identityColumn("generations")} FROM generations AS g
         WHERE generation = (SELECT MAX(generation) FROM generations WHERE service = g.service)`,
      ),
      false,
    );
  }

  if (tables.has("deployments")) {
    collect(
      readRows(
        source,
        `SELECT service, ${identityColumn("deployments")} FROM deployments
         WHERE status = 'success'
           AND id IN (SELECT MAX(id) FROM deployments WHERE status = 'success' GROUP BY service)`,
      ),
      true,
    );
  }

  return recorded;
}

/**
 * Copies validated `deployments` rows into the replacement, preserving ids.
 *
 * `deployments.id` is user-facing: printed by `rfapps history`, resolved by
 * `findDeploymentById` and a rollback target, so letting AUTOINCREMENT renumber
 * would break every id an operator wrote down.
 */
function carryDeployments(
  source: DbConnection,
  target: DbConnection,
  counts: CarryOverCounts,
): Set<number> {
  const carriedIds = new Set<number>();

  // A v1 source has no image_id/image_digest: naming them unconditionally would
  // throw on exactly the legacy databases the migration system exists for.
  const available = readColumnNames(source, "deployments");
  const selected = DEPLOYMENT_COLUMNS.filter((column) => available.has(column));
  if (!available.has("id") || selected.length === 0) {
    return carriedIds;
  }

  const rows = readRows(source, `SELECT ${selected.join(", ")} FROM deployments ORDER BY id ASC`);
  const insert = target.prepare(
    `INSERT INTO deployments (${DEPLOYMENT_COLUMNS.join(", ")})
     VALUES (${DEPLOYMENT_COLUMNS.map(() => "?").join(", ")})`,
  );

  for (const row of rows) {
    const id = row["id"];
    const service = row["service"];
    const action = row["action"];
    const status = row["status"];
    const timestamp = row["timestamp"];

    if (
      !isPositiveInteger(id) ||
      !isNonEmptyString(service) ||
      !isNonEmptyString(action) ||
      !isNonEmptyString(status) ||
      !isNonEmptyString(timestamp)
    ) {
      counts.deploymentsDiscarded += 1;
      continue;
    }

    try {
      insert.run(
        id,
        normalizeTimestamp(timestamp),
        service,
        action,
        toNullableText(row["image_tag"]),
        toNullableText(row["image_id"]),
        toNullableText(row["image_digest"]),
        toNullableText(row["config_snapshot"]),
        status,
        toNullableText(row["plan_id"]),
        toNullableText(row["error_message"]),
      );
      carriedIds.add(id);
      counts.deploymentsCarried += 1;
    } catch (error) {
      counts.deploymentsDiscarded += 1;
      logDebug(`Discarded deployment row ${id}: ${describeError(error)}`);
    }
  }

  return carriedIds;
}

/**
 * Copies validated `generations` rows, preserving `generation` verbatim.
 *
 * `rollback --to-generation N` and operator runbooks reference those numbers.
 * `deployment_id` is kept only when it names a carried deployment, so the FK
 * stays valid under `pragma foreign_keys = ON`.
 */
function carryGenerations(
  source: DbConnection,
  target: DbConnection,
  counts: CarryOverCounts,
  carriedDeploymentIds: ReadonlySet<number>,
): void {
  const available = readColumnNames(source, "generations");
  const selected = GENERATION_SOURCE_COLUMNS.filter((column) => available.has(column));
  if (selected.length === 0) {
    return;
  }

  const ordering = available.has("id") ? " ORDER BY id ASC" : "";
  const rows = readRows(source, `SELECT ${selected.join(", ")} FROM generations${ordering}`);
  const insert = target.prepare(
    `INSERT INTO generations (${GENERATION_INSERT_COLUMNS.join(", ")})
     VALUES (${GENERATION_INSERT_COLUMNS.map(() => "?").join(", ")})`,
  );

  // Pre-detected so UNIQUE(service, generation) never actually fires.
  const seen = new Set<string>();

  for (const row of rows) {
    const service = row["service"];
    const generation = row["generation"];
    const timestamp = row["timestamp"];
    const createdByAction = row["created_by_action"];

    if (
      !isNonEmptyString(service) ||
      !isPositiveInteger(generation) ||
      !isNonEmptyString(timestamp) ||
      !isNonEmptyString(createdByAction)
    ) {
      counts.generationsDiscarded += 1;
      continue;
    }

    const key = `${service} ${generation}`;
    if (seen.has(key)) {
      counts.generationsDiscarded += 1;
      continue;
    }

    const deploymentId = row["deployment_id"];
    const linkedDeploymentId =
      isPositiveInteger(deploymentId) && carriedDeploymentIds.has(deploymentId)
        ? deploymentId
        : null;

    try {
      insert.run(
        service,
        generation,
        linkedDeploymentId,
        normalizeTimestamp(timestamp),
        toNullableText(row["image_tag"]),
        toNullableText(row["image_id"]),
        toNullableText(row["image_digest"]),
        toNullableText(row["config_snapshot"]),
        createdByAction,
      );
      seen.add(key);
      counts.generationsCarried += 1;
    } catch (error) {
      counts.generationsDiscarded += 1;
      logDebug(`Discarded generation row ${service}#${generation}: ${describeError(error)}`);
    }
  }
}

/**
 * Re-derives generations from carried deployments when the source had none.
 *
 * Shaped like the v2 migration's backfill, but filtered by the INJECTED action
 * vocabulary rather than v2's frozen literal, which omits `update` and `import`.
 */
function deriveGenerations(
  target: DbConnection,
  generationActions: ReadonlySet<DeploymentAction>,
): number {
  const actions = [...generationActions];
  if (actions.length === 0) {
    return 0;
  }
  const result = target
    .prepare(
      `INSERT INTO generations (${GENERATION_INSERT_COLUMNS.join(", ")})
       SELECT
         service,
         ROW_NUMBER() OVER (PARTITION BY service ORDER BY timestamp ASC, id ASC),
         id,
         timestamp,
         image_tag,
         image_id,
         image_digest,
         config_snapshot,
         action
       FROM deployments
       WHERE status = 'success'
         AND action IN (${actions.map(() => "?").join(", ")})`,
    )
    .run(...actions);
  return result.changes;
}

/**
 * Carries every readable row from a source database into a fresh replacement.
 *
 * Runs inside a SINGLE transaction on the target. Invalid rows are discarded and
 * counted rather than aborting — corrupt input is the input this command exists
 * for — and no SQLite error is propagated to the caller, so a missing or
 * unreadable source degenerates salvage into runtime-only automatically.
 *
 * `metadata` is deliberately NOT carried: the replacement keeps the fresh
 * `schema_version` stamped by `runMigrations()`, because carrying a stale or
 * future version is exactly the corruption being repaired.
 *
 * @param source - Read-only connection to the existing database
 * @param target - Read-write connection to the fresh replacement
 * @param generationActions - Action vocabulary used for generation re-derivation
 * @returns Row-level accounting for the report and the safety invariant
 */
export function carryOverState(
  source: DbConnection,
  target: DbConnection,
  generationActions: ReadonlySet<DeploymentAction>,
): CarryOverCounts {
  const counts = zeroCounts();

  const tables = readTableNames(source);
  if (tables === undefined || !tables.has("deployments")) {
    return counts;
  }

  const carry = target.transaction(() => {
    const carriedIds = carryDeployments(source, target, counts);
    if (tables.has("generations")) {
      carryGenerations(source, target, counts, carriedIds);
    }
    if (counts.deploymentsCarried > 0 && counts.generationsCarried === 0) {
      counts.generationsDerived = deriveGenerations(target, generationActions);
    }
  });

  try {
    carry();
  } catch (error) {
    // The transaction rolled back, so nothing reached the replacement.
    logDebug(`Salvage carry-over was rolled back: ${describeError(error)}`);
    return zeroCounts();
  }

  return counts;
}
