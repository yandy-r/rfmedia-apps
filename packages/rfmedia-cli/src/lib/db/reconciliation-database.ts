import Database from "better-sqlite3";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, join, parse, sep } from "node:path";

import type {
  DbConnection,
  ReconciliationDatabaseAuthorityLease,
  ReconciliationDatabaseFileIdentity,
  ReconciliationDatabaseGeneration,
  ReconciliationDatabaseReadOnlySnapshot,
  ReconciliationDatabaseWritableResult,
} from "../../types/db.js";

const SUPPORTED_READ_ONLY_SCHEMA_VERSION = 11;
export const READ_ONLY_DATABASE_MAX_BYTES = 256 * 1024 * 1024;
const GENERATION_CHANGED_AFTER_REVIEW =
  "Tracking database generation changed after reconciliation review.";
const GENERATION_CHANGED_WHILE_STARTING =
  "Tracking database generation changed while starting reconciliation update.";

export interface ReconciliationWritableDatabaseOpenHooks {
  /** @internal Test-only seam for deterministic pathname replacement races. */
  beforeSqliteOpen?: () => void;
  /** @internal Test-only seam paired with beforeSqliteOpen for race cleanup. */
  afterSqliteOpen?: () => void;
  /** @internal Test-only seam immediately before the final ancestor trust check and BEGIN. */
  beforeTransactionOpen?: () => void;
  /** @internal Test-only seam after the final filesystem precheck and before its logical recheck. */
  afterGenerationPrecheck?: () => void;
  /** @internal Test-only seam after the final generation precheck and immediately before BEGIN. */
  beforeImmediateTransactionOpen?: () => void;
  /** @internal Test-only seam paired with beforeTransactionOpen for race cleanup. */
  afterTransactionOpen?: () => void;
}

interface AttachedDatabase {
  name: string;
  file: string;
}

interface PinnedDatabaseAncestor {
  readonly path: string;
  readonly descriptor: number;
  readonly isDatabaseParent: boolean;
}

function getValidatedSchemaVersion(db: DbConnection): number {
  const metadataTable = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'metadata'")
    .get();
  if (metadataTable === undefined) {
    throw new Error("Database schema metadata is malformed: metadata table is missing.");
  }

  let rows: Array<{ value: unknown }>;
  try {
    rows = db.prepare("SELECT value FROM metadata WHERE key = ?").all("schema_version") as Array<{
      value: unknown;
    }>;
  } catch (error) {
    throw new Error("Database schema metadata is malformed: cannot read schema_version.", {
      cause: error,
    });
  }

  if (rows.length !== 1) {
    throw new Error(
      "Database schema metadata is malformed: expected exactly one schema_version value.",
    );
  }

  const value = rows[0]?.value;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(
      "Database schema metadata is malformed: schema_version must be a positive integer.",
    );
  }

  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new Error(
      "Database schema metadata is malformed: schema_version exceeds the supported integer range.",
    );
  }
  return version;
}

export function preflightExistingDatabase(path: string, supportedVersion: number): void {
  if (!existsSync(path)) return;

  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const objects = db
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    if (objects.length === 0) return;

    const version = getValidatedSchemaVersion(db);
    if (version > supportedVersion) {
      throw new Error(
        `Database schema version ${version} is newer than supported version ${supportedVersion}. Please upgrade rfmedia CLI.`,
      );
    }
  } finally {
    db.close();
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.dev === left.dev &&
    right.ino === left.ino &&
    right.size === left.size &&
    right.mtimeMs === left.mtimeMs &&
    right.ctimeMs === left.ctimeMs
  );
}

function databaseFileIdentity(stats: Stats): ReconciliationDatabaseFileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

function databaseGeneration(stats: Stats): ReconciliationDatabaseGeneration {
  return {
    ...databaseFileIdentity(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameDatabaseFileIdentity(
  stats: Stats,
  expected: ReconciliationDatabaseFileIdentity,
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.dev === expected.device &&
    stats.ino === expected.inode
  );
}

function sameDatabaseGeneration(stats: Stats, expected: ReconciliationDatabaseGeneration): boolean {
  return (
    sameDatabaseFileIdentity(stats, expected) &&
    stats.size === expected.size &&
    stats.mtimeMs === expected.mtimeMs &&
    stats.ctimeMs === expected.ctimeMs
  );
}

function reconciliationDatabaseSidecarPaths(path: string): readonly string[] {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function currentReconciliationDatabaseGeneration(
  path: string,
  expected?: ReconciliationDatabaseGeneration,
  allowConnectionOwnedSidecars = false,
): ReconciliationDatabaseGeneration {
  const pathStats = lstatSync(path);
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    (expected !== undefined && !sameDatabaseGeneration(pathStats, expected))
  ) {
    throw new Error(GENERATION_CHANGED_AFTER_REVIEW);
  }

  const sidecarPaths = reconciliationDatabaseSidecarPaths(path);
  if (
    !allowConnectionOwnedSidecars &&
    sidecarPaths.some((sidecarPath) => existsSync(sidecarPath))
  ) {
    throw new Error(GENERATION_CHANGED_AFTER_REVIEW);
  }

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorStats = fstatSync(descriptor);
    if (
      !sameFileSnapshot(pathStats, descriptorStats) ||
      (expected !== undefined && !sameDatabaseGeneration(descriptorStats, expected))
    ) {
      throw new Error(GENERATION_CHANGED_AFTER_REVIEW);
    }

    const finalPathStats = lstatSync(path);
    const finalDescriptorStats = fstatSync(descriptor);
    if (
      !sameFileSnapshot(pathStats, finalPathStats) ||
      !sameFileSnapshot(descriptorStats, finalDescriptorStats) ||
      (!allowConnectionOwnedSidecars && sidecarPaths.some((sidecarPath) => existsSync(sidecarPath)))
    ) {
      throw new Error(GENERATION_CHANGED_AFTER_REVIEW);
    }
    return databaseGeneration(finalDescriptorStats);
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedDatabaseSnapshot(path: string, pathStats: Stats): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = fstatSync(descriptor);
    if (!sameFileSnapshot(pathStats, openedStats)) {
      throw new Error("Tracking database changed while creating the read-only snapshot.");
    }
    if (openedStats.size > READ_ONLY_DATABASE_MAX_BYTES) {
      throw new Error(
        `Tracking database exceeds the ${READ_ONLY_DATABASE_MAX_BYTES}-byte read-only snapshot limit.`,
      );
    }

    const snapshot = Buffer.allocUnsafe(openedStats.size);
    let offset = 0;
    while (offset < snapshot.length) {
      const bytesRead = readSync(descriptor, snapshot, offset, snapshot.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const afterReadStats = fstatSync(descriptor);
    if (offset !== snapshot.length || !sameFileSnapshot(openedStats, afterReadStats)) {
      throw new Error("Tracking database changed while creating the read-only snapshot.");
    }
    return snapshot;
  } finally {
    closeSync(descriptor);
  }
}

function getDescriptorBackedDatabasePath(descriptor: number): string {
  const descriptorRoot =
    process.platform === "linux"
      ? "/proc/self/fd"
      : process.platform === "darwin"
        ? "/dev/fd"
        : undefined;
  if (!descriptorRoot) {
    throw new Error(
      `Descriptor-backed reconciliation database opens are not supported on ${process.platform}.`,
    );
  }

  const descriptorPath = join(descriptorRoot, String(descriptor));
  if (!existsSync(descriptorPath)) {
    throw new Error("Descriptor-backed reconciliation database path is unavailable.");
  }
  return descriptorPath;
}

function getMainDatabasePath(db: DbConnection): string {
  const mainDatabase = db
    .prepare("PRAGMA database_list")
    .all()
    .find((database): database is AttachedDatabase => {
      if (typeof database !== "object" || database === null) return false;
      const record = database as Record<string, unknown>;
      return record["name"] === "main" && typeof record["file"] === "string";
    });
  if (!mainDatabase) throw new Error("SQLite did not report a main reconciliation database.");
  return mainDatabase.file;
}

function getSqliteDataVersion(db: DbConnection): number {
  const value = db.pragma("data_version", { simple: true });
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("SQLite did not report a valid reconciliation data version.");
  }
  return value as number;
}

function reconciliationDatabaseAncestorPaths(canonicalParentPath: string): readonly string[] {
  const root = parse(canonicalParentPath).root;
  const relative = canonicalParentPath.slice(root.length);
  const paths = [root];
  let current = root;
  for (const component of relative.split(sep).filter((entry) => entry.length > 0)) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

function pinReconciliationDatabaseAncestors(canonicalParentPath: string): PinnedDatabaseAncestor[] {
  const pinned: PinnedDatabaseAncestor[] = [];
  try {
    for (const ancestorPath of reconciliationDatabaseAncestorPaths(canonicalParentPath)) {
      pinned.push({
        path: ancestorPath,
        descriptor: openSync(
          ancestorPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
        isDatabaseParent: ancestorPath === canonicalParentPath,
      });
    }
    return pinned;
  } catch (error) {
    for (const ancestor of pinned.reverse()) closeSync(ancestor.descriptor);
    throw error;
  }
}

function assertTrustedReconciliationDatabaseAncestor(ancestor: PinnedDatabaseAncestor): void {
  const pathStats = lstatSync(ancestor.path);
  const descriptorStats = fstatSync(ancestor.descriptor);
  const effectiveUserId = process.geteuid?.();
  const trustedOwner =
    effectiveUserId !== undefined && (pathStats.uid === effectiveUserId || pathStats.uid === 0);

  if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) {
    throw new Error("Tracking database ancestors must be stable trusted directories.");
  }
  if (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino) {
    throw new Error("Tracking database ancestor changed while opening it for reconciliation.");
  }

  const writableByOthers = (pathStats.mode & 0o022) !== 0;
  const trustedStickyRootAncestor =
    !ancestor.isDatabaseParent && pathStats.uid === 0 && (pathStats.mode & 0o1000) !== 0;
  if (!trustedOwner || (writableByOthers && !trustedStickyRootAncestor)) {
    throw new Error("Tracking database ancestors must not grant unsafe group or world writes.");
  }

  const descriptorCanonicalPath = realpathSync(
    getDescriptorBackedDatabasePath(ancestor.descriptor),
  );
  if (descriptorCanonicalPath !== ancestor.path) {
    throw new Error("Tracking database ancestor changed while opening it for reconciliation.");
  }
}

function assertTrustedReconciliationDatabaseAncestors(
  ancestors: readonly PinnedDatabaseAncestor[],
): void {
  for (const ancestor of ancestors) assertTrustedReconciliationDatabaseAncestor(ancestor);
}

function assertTrustedReconciliationDatabaseFile(
  canonicalPath: string,
  descriptor: number,
  expected: ReconciliationDatabaseFileIdentity,
): void {
  const pathStats = lstatSync(canonicalPath);
  const descriptorStats = fstatSync(descriptor);
  const effectiveUserId = process.geteuid?.();
  const trustedOwner =
    effectiveUserId !== undefined && (pathStats.uid === effectiveUserId || pathStats.uid === 0);

  if (
    !sameDatabaseFileIdentity(pathStats, expected) ||
    !sameDatabaseFileIdentity(descriptorStats, expected)
  ) {
    throw new Error("Tracking database identity changed while opening it for reconciliation.");
  }
  if (!trustedOwner || (pathStats.mode & 0o022) !== 0 || (descriptorStats.mode & 0o022) !== 0) {
    throw new Error(
      "Tracking database file must have a trusted owner and no group, world, or ACL-effective write access.",
    );
  }

  const descriptorCanonicalPath = realpathSync(getDescriptorBackedDatabasePath(descriptor));
  if (descriptorCanonicalPath !== canonicalPath) {
    throw new Error("Tracking database identity changed while opening it for reconciliation.");
  }
}

function closeReconciliationDatabaseDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Best-effort close keeps cleanup idempotent after a partial acquisition.
  }
}

export function assertReconciliationDatabaseGenerationCurrent(
  path: string,
  expected: ReconciliationDatabaseGeneration,
): void {
  currentReconciliationDatabaseGeneration(path, expected);
  const canonicalPath = realpathSync(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let ancestors: PinnedDatabaseAncestor[] = [];
  try {
    ancestors = pinReconciliationDatabaseAncestors(dirname(canonicalPath));
    assertTrustedReconciliationDatabaseAncestors(ancestors);
    assertTrustedReconciliationDatabaseFile(canonicalPath, descriptor, expected);
    currentReconciliationDatabaseGeneration(path, expected);
  } finally {
    closeSync(descriptor);
    for (const ancestor of ancestors.reverse()) closeSync(ancestor.descriptor);
  }
}

export function openReconciliationDatabaseReadOnly(
  path: string,
): ReconciliationDatabaseReadOnlySnapshot {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Tracking database must be an existing regular file, not a symbolic link.");
  }
  if (stats.size > READ_ONLY_DATABASE_MAX_BYTES) {
    throw new Error(
      `Tracking database exceeds the ${READ_ONLY_DATABASE_MAX_BYTES}-byte read-only snapshot limit.`,
    );
  }

  const sidecarPaths = reconciliationDatabaseSidecarPaths(path);
  if (sidecarPaths.some((sidecarPath) => existsSync(sidecarPath))) {
    throw new Error("Tracking database has active SQLite sidecars and cannot be read immutably.");
  }

  const snapshot = readBoundedDatabaseSnapshot(path, stats);
  const afterReadStats = lstatSync(path);
  if (
    !sameFileSnapshot(stats, afterReadStats) ||
    sidecarPaths.some((sidecarPath) => existsSync(sidecarPath))
  ) {
    throw new Error("Tracking database changed while creating the read-only snapshot.");
  }

  if (snapshot.length >= 20 && snapshot[18] === 2 && snapshot[19] === 2) {
    snapshot[18] = 1;
    snapshot[19] = 1;
  }

  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const version = getValidatedSchemaVersion(db);
    if (version < SUPPORTED_READ_ONLY_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is older than required version ${SUPPORTED_READ_ONLY_SCHEMA_VERSION}. Run a migration-capable rfmedia command first.`,
      );
    }
    if (version > SUPPORTED_READ_ONLY_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than supported version ${SUPPORTED_READ_ONLY_SCHEMA_VERSION}. Please upgrade rfmedia CLI.`,
      );
    }
    return {
      database: db,
      identity: databaseFileIdentity(afterReadStats),
      generation: databaseGeneration(afterReadStats),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openDatabaseReadOnly(path: string): DbConnection {
  return openReconciliationDatabaseReadOnly(path).database;
}

export function openReconciliationDatabaseAuthorityLease(
  path: string,
  expectedGeneration: ReconciliationDatabaseGeneration,
  hooks?: ReconciliationWritableDatabaseOpenHooks,
): ReconciliationDatabaseAuthorityLease {
  const pathStats = lstatSync(path);
  if (!sameDatabaseGeneration(pathStats, expectedGeneration)) {
    throw new Error(GENERATION_CHANGED_AFTER_REVIEW);
  }
  const expectedCanonicalPath = realpathSync(path);
  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  let ancestors: PinnedDatabaseAncestor[] = [];
  let db: DbConnection | undefined;
  let transactionOpen = false;
  let leaseCreated = false;
  try {
    ancestors = pinReconciliationDatabaseAncestors(dirname(expectedCanonicalPath));
    assertTrustedReconciliationDatabaseAncestors(ancestors);
    assertTrustedReconciliationDatabaseFile(expectedCanonicalPath, descriptor, expectedGeneration);
    assertReconciliationDatabaseGenerationCurrent(path, expectedGeneration);

    try {
      hooks?.beforeSqliteOpen?.();
      db = new Database(getDescriptorBackedDatabasePath(descriptor), { fileMustExist: true });
    } finally {
      hooks?.afterSqliteOpen?.();
    }

    if (!sameDatabaseGeneration(lstatSync(path), expectedGeneration)) {
      throw new Error("Tracking database identity changed while opening it for reconciliation.");
    }

    try {
      hooks?.beforeTransactionOpen?.();
      let dataVersionBeforePrecheck: number;
      try {
        dataVersionBeforePrecheck = getSqliteDataVersion(db);
      } catch (error) {
        assertTrustedReconciliationDatabaseAncestors(ancestors);
        assertTrustedReconciliationDatabaseFile(
          expectedCanonicalPath,
          descriptor,
          expectedGeneration,
        );
        currentReconciliationDatabaseGeneration(path, expectedGeneration, true);
        throw error;
      }
      assertTrustedReconciliationDatabaseAncestors(ancestors);
      assertTrustedReconciliationDatabaseFile(
        expectedCanonicalPath,
        descriptor,
        expectedGeneration,
      );
      currentReconciliationDatabaseGeneration(path, expectedGeneration, true);
      hooks?.afterGenerationPrecheck?.();
      if (getSqliteDataVersion(db) !== dataVersionBeforePrecheck) {
        throw new Error(GENERATION_CHANGED_WHILE_STARTING);
      }
      hooks?.beforeImmediateTransactionOpen?.();
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (getSqliteDataVersion(db) !== dataVersionBeforePrecheck) {
        throw new Error(GENERATION_CHANGED_WHILE_STARTING);
      }
    } finally {
      hooks?.afterTransactionOpen?.();
    }

    if (
      !sameDatabaseGeneration(lstatSync(path), expectedGeneration) ||
      getMainDatabasePath(db) !== expectedCanonicalPath
    ) {
      throw new Error(GENERATION_CHANGED_WHILE_STARTING);
    }
    assertTrustedReconciliationDatabaseAncestors(ancestors);
    assertTrustedReconciliationDatabaseFile(expectedCanonicalPath, descriptor, expectedGeneration);

    const version = getValidatedSchemaVersion(db);
    if (version !== SUPPORTED_READ_ONLY_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is not the required reconciliation version ${SUPPORTED_READ_ONLY_SCHEMA_VERSION}.`,
      );
    }

    const connection = db;
    let active = true;
    const release = (rollback: boolean): void => {
      if (!active) return;
      active = false;
      if (rollback && transactionOpen && connection.inTransaction) {
        try {
          connection.exec("ROLLBACK");
        } catch {
          // Closing the connection below is the final rollback backstop.
        }
      }
      transactionOpen = false;
      if (connection.open) {
        try {
          connection.close();
        } catch {
          // Continue closing pinned descriptors after a SQLite close failure.
        }
      }
      closeReconciliationDatabaseDescriptor(descriptor);
      for (const ancestor of ancestors.reverse()) {
        closeReconciliationDatabaseDescriptor(ancestor.descriptor);
      }
    };

    const lease: ReconciliationDatabaseAuthorityLease = {
      connection,
      commit(): ReconciliationDatabaseGeneration {
        if (!active) throw new Error("Reconciliation database authority lease is closed.");

        let committed = false;
        try {
          if (!sameDatabaseFileIdentity(lstatSync(path), expectedGeneration)) {
            throw new Error("Tracking database identity changed during reconciliation update.");
          }
          assertTrustedReconciliationDatabaseAncestors(ancestors);
          assertTrustedReconciliationDatabaseFile(
            expectedCanonicalPath,
            descriptor,
            expectedGeneration,
          );
          connection.exec("COMMIT");
          transactionOpen = false;
          committed = true;
          connection.pragma("wal_checkpoint(TRUNCATE)");
          connection.close();

          assertTrustedReconciliationDatabaseAncestors(ancestors);
          assertTrustedReconciliationDatabaseFile(
            expectedCanonicalPath,
            descriptor,
            expectedGeneration,
          );
          return currentReconciliationDatabaseGeneration(path);
        } finally {
          release(!committed);
        }
      },
      rollback(): void {
        release(true);
      },
      close(): void {
        release(true);
      },
    };
    leaseCreated = true;
    return lease;
  } catch (error) {
    if (transactionOpen && db?.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Closing the connection below is the final rollback backstop.
      }
    }
    if (db?.open) {
      try {
        db.close();
      } catch {
        // Continue closing pinned descriptors after a SQLite close failure.
      }
    }
    throw error;
  } finally {
    if (!leaseCreated) {
      closeReconciliationDatabaseDescriptor(descriptor);
      for (const ancestor of ancestors.reverse()) {
        closeReconciliationDatabaseDescriptor(ancestor.descriptor);
      }
    }
  }
}

export function withReconciliationDatabaseWritable<T>(
  path: string,
  expectedGeneration: ReconciliationDatabaseGeneration,
  operation: (database: DbConnection) => T,
  hooks?: ReconciliationWritableDatabaseOpenHooks,
): ReconciliationDatabaseWritableResult<T> {
  const lease = openReconciliationDatabaseAuthorityLease(path, expectedGeneration, hooks);
  try {
    const result = operation(lease.connection);
    if (
      typeof result === "object" &&
      result !== null &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      throw new TypeError("Reconciliation database operations must be synchronous.");
    }
    return { value: result, generation: lease.commit() };
  } catch (error) {
    lease.close();
    throw error;
  }
}
