/**
 * Tests for core database initialization and optimization behavior (#112).
 *
 * Covers WAL mode and pragma configuration, the version 8 index migration,
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, renameSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { DbConnection } from "../types/db.js";
import {
  initializeDatabase,
  getCurrentSchemaVersion,
  createOperation,
  getInventory,
  recordCompletedAlbumCopy,
  recordInventoryFile,
  recordInventoryFiles,
  getCompletedAlbumCopies,
  getInventoryFingerprintCandidates,
  getReconciliationInventoryCandidates,
  getReconciliationInventoryCandidatesAtPath,
  updateReconciliationInventory,
  assertReconciliationDatabaseGenerationCurrent,
  openDatabaseReadOnly,
  openReconciliationDatabaseAuthorityLease,
  openReconciliationDatabaseReadOnly,
  withReconciliationDatabaseWritable,
  READ_ONLY_DATABASE_MAX_BYTES,
  RECONCILIATION_INVENTORY_MAX_CANDIDATES,
} from "./db.js";

describe("Database Initialization", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("enables WAL journal mode", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("sets synchronous to NORMAL", () => {
    // synchronous: 0=OFF, 1=NORMAL, 2=FULL
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("sets a busy timeout for concurrent access", () => {
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("keeps foreign keys enabled", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("reports schema version 11", () => {
    expect(getCurrentSchemaVersion(db)).toBe(11);
  });

  it("creates inventory content_hash column", () => {
    const columns = db.prepare("PRAGMA table_info(inventory)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("content_hash");
  });

  it("creates the exact v11 bridge snapshot table, unique scope index, and checks", () => {
    const columns = db.prepare("PRAGMA table_info(bridge_identity_snapshots)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "plex_origin", type: "TEXT", notnull: 1, pk: 0 },
      { name: "plex_machine_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "plex_library_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "lidarr_origin", type: "TEXT", notnull: 1, pk: 0 },
      { name: "entity_kind", type: "TEXT", notnull: 1, pk: 0 },
      { name: "snapshot_version", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "resolver_version", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "payload_json", type: "TEXT", notnull: 1, pk: 0 },
      { name: "captured_at", type: "TEXT", notnull: 1, pk: 0 },
      { name: "verified_at", type: "TEXT", notnull: 1, pk: 0 },
    ]);

    const uniqueIndex = (
      db.prepare("PRAGMA index_list(bridge_identity_snapshots)").all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>
    ).find((index) => index.unique === 1 && index.origin === "u");
    if (uniqueIndex === undefined) {
      throw new Error("Expected bridge_identity_snapshots to have one unique scope index.");
    }
    const indexColumns = db
      .prepare(`PRAGMA index_info("${uniqueIndex.name.replaceAll('"', '""')}")`)
      .all() as Array<{ name: string }>;
    expect(indexColumns.map((column) => column.name)).toEqual([
      "plex_origin",
      "plex_machine_id",
      "plex_library_id",
      "lidarr_origin",
      "entity_kind",
    ]);

    const insert = db.prepare(`
      INSERT INTO bridge_identity_snapshots (
        plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind,
        snapshot_version, resolver_version, payload_json, captured_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const runInsert = (entityKind = "artist", snapshotVersion = 1, resolverVersion = 1) =>
      insert.run(
        "http://plex.example.net:32400",
        "plex-machine-a",
        "7",
        "http://lidarr.example.net:8686",
        entityKind,
        snapshotVersion,
        resolverVersion,
        "{}",
        "2026-07-27T10:00:00.000Z",
        "2026-07-27T09:59:00.000Z",
      );
    runInsert();
    expect(() => runInsert()).toThrow();
    expect(() => runInsert("album")).toThrow();
    expect(() => runInsert("artist", 0)).toThrow();
    expect(() => runInsert("artist", 1, 0)).toThrow();
  });

  it("keeps snapshots distinct across every non-kind scope dimension", () => {
    const insert = db.prepare(`
      INSERT INTO bridge_identity_snapshots (
        plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind,
        snapshot_version, resolver_version, payload_json, captured_at, verified_at
      ) VALUES (?, ?, ?, ?, 'artist', 1, 1, '{}', ?, ?)
    `);
    const capturedAt = "2026-07-27T10:00:00.000Z";
    const verifiedAt = "2026-07-27T09:59:00.000Z";
    const scopes = [
      ["http://plex-a.example.net:32400", "machine-a", "7", "http://lidarr-a.example.net:8686"],
      ["http://plex-b.example.net:32400", "machine-a", "7", "http://lidarr-a.example.net:8686"],
      ["http://plex-a.example.net:32400", "machine-b", "7", "http://lidarr-a.example.net:8686"],
      ["http://plex-a.example.net:32400", "machine-a", "8", "http://lidarr-a.example.net:8686"],
      ["http://plex-a.example.net:32400", "machine-a", "7", "http://lidarr-b.example.net:8686"],
    ] as const;

    for (const scope of scopes) {
      insert.run(...scope, capturedAt, verifiedAt);
    }

    expect(db.prepare("SELECT COUNT(*) FROM bridge_identity_snapshots").pluck().get()).toBe(
      scopes.length,
    );
  });

  it("persists WAL mode across re-open", async () => {
    const dbPath = join(tempDir, "test.db");
    db.close();

    db = await initializeDatabase(dbPath);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("reopens an existing version 11 database without schema churn", async () => {
    const dbPath = join(tempDir, "test.db");
    const before = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    db.close();

    db = await initializeDatabase(dbPath);

    const after = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    expect(after).toEqual(before);
  });
});

describe("Database compatibility preflight", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function snapshotDatabase(dbPath: string): {
    schema: unknown[];
    metadata: unknown[];
    journalMode: unknown;
  } {
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return {
        schema: probe
          .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
          .all(),
        metadata: probe.prepare("SELECT key, value FROM metadata ORDER BY key").all(),
        journalMode: probe.pragma("journal_mode", { simple: true }),
      };
    } finally {
      probe.close();
    }
  }

  it("initializes an existing empty database file", async () => {
    const dbPath = join(tempDir, "empty.db");
    await writeFile(dbPath, "");

    db = await initializeDatabase(dbPath);

    expect(getCurrentSchemaVersion(db)).toBe(11);
  });

  it("rejects a future schema before changing schema or journal mode", async () => {
    const dbPath = join(tempDir, "future.db");
    const futureDb = new Database(dbPath);
    futureDb.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('schema_version', '12');
      CREATE TABLE future_only (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO future_only (id, value) VALUES (1, 'preserve-me');
    `);
    futureDb.close();
    const before = snapshotDatabase(dbPath);

    await expect(initializeDatabase(dbPath)).rejects.toThrow(
      "Database schema version 12 is newer than supported version 11",
    );

    expect(snapshotDatabase(dbPath)).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("rejects a non-empty database without schema metadata", async () => {
    const dbPath = join(tempDir, "missing-metadata.db");
    const malformedDb = new Database(dbPath);
    malformedDb.exec("CREATE TABLE existing_data (id INTEGER PRIMARY KEY)");
    malformedDb.close();

    await expect(initializeDatabase(dbPath)).rejects.toThrow(
      "Database schema metadata is malformed: metadata table is missing",
    );
  });

  it.each(["", "0", "-1", "9.0", " 9", "9junk"])(
    "rejects malformed schema version metadata %j",
    async (version) => {
      const dbPath = join(tempDir, "malformed-version.db");
      const malformedDb = new Database(dbPath);
      malformedDb.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      malformedDb
        .prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?)")
        .run(version);
      malformedDb.close();

      await expect(initializeDatabase(dbPath)).rejects.toThrow(
        "Database schema metadata is malformed: schema_version must be a positive integer",
      );
    },
  );

  it("rejects missing schema version metadata", async () => {
    const dbPath = join(tempDir, "missing-version.db");
    const malformedDb = new Database(dbPath);
    malformedDb.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('other_key', 'value');
    `);
    malformedDb.close();

    await expect(initializeDatabase(dbPath)).rejects.toThrow(
      "Database schema metadata is malformed: expected exactly one schema_version value",
    );
  });
});

describe("Version 8 index migration", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Returns all index names present in the database. */
  function indexNames(database: DbConnection): string[] {
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  it("drops pre-v8 redundant indexes from an existing database", async () => {
    const dbPath = join(tempDir, "test.db");
    db = await initializeDatabase(dbPath);

    // Simulate a database created by an older schema version
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_completed_operation ON completed_sources(operation_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_operation ON inventory(operation_id);
      CREATE INDEX IF NOT EXISTS idx_queue_jobs_status ON queue_jobs(status);
      UPDATE metadata SET value = '7' WHERE key = 'schema_version';
    `);
    db.close();

    // Re-opening runs the schema, which applies the v8 migration
    db = await initializeDatabase(dbPath);
    const indexes = indexNames(db);

    expect(indexes).not.toContain("idx_completed_operation");
    expect(indexes).not.toContain("idx_inventory_operation");
    expect(indexes).not.toContain("idx_queue_jobs_status");
    expect(indexes).toContain("idx_queue_jobs_status_added");
    expect(indexes).toContain("idx_history_operations_session_occurred");
    expect(getCurrentSchemaVersion(db)).toBe(11);
  });
});

describe("Version 9 content hash migration", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("adds nullable content_hash to an existing version 8 inventory table", async () => {
    const dbPath = join(tempDir, "test.db");
    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO metadata (key, value) VALUES ('schema_version', '8');

      CREATE TABLE operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        command TEXT NOT NULL,
        mode TEXT NOT NULL,
        input_file TEXT,
        options_hash TEXT NOT NULL,
        rating_key TEXT,
        range_key TEXT,
        convert_key TEXT,
        status TEXT NOT NULL,
        total_sources INTEGER DEFAULT 0,
        completed_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        started_at TEXT,
        ended_at TEXT
      );
      INSERT INTO operations (
        id, created_at, command, mode, input_file, options_hash, status
      ) VALUES (
        1, '2026-01-01T00:00:00.000Z', 'copy-filter', 'filter', NULL, 'filter-r80', 'completed'
      );

      CREATE TABLE inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        rating REAL,
        genre TEXT,
        year INTEGER,
        bpm REAL,
        artist TEXT,
        dest_path TEXT NOT NULL,
        copied_at INTEGER NOT NULL,
        UNIQUE(operation_id, source_path, relative_path)
      );
      INSERT INTO inventory (
        operation_id, source_path, relative_path, mtime, size, rating,
        genre, year, bpm, artist, dest_path, copied_at
      ) VALUES (
        1, '/music/Artist', 'Album/track.flac', 1000, 42, NULL,
        NULL, NULL, NULL, NULL, '/dest/Album/track.flac', 2000
      );
    `);
    oldDb.close();

    db = await initializeDatabase(dbPath);
    const columns = db.prepare("PRAGMA table_info(inventory)").all() as Array<{ name: string }>;
    const rows = getInventory(db, 1);

    expect(columns.map((column) => column.name)).toContain("content_hash");
    expect(getCurrentSchemaVersion(db)).toBe(11);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_hash).toBeNull();
  });
});

describe("Version 10 Lidarr resilience migration", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the Lidarr resilience tables when migrating a version 9 database", async () => {
    const dbPath = join(tempDir, "test.db");
    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO metadata (key, value) VALUES ('schema_version', '9');

      CREATE TABLE operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        command TEXT NOT NULL,
        mode TEXT NOT NULL,
        input_file TEXT,
        options_hash TEXT NOT NULL,
        rating_key TEXT,
        range_key TEXT,
        convert_key TEXT,
        status TEXT NOT NULL,
        total_sources INTEGER DEFAULT 0,
        completed_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        started_at TEXT,
        ended_at TEXT
      );
      INSERT INTO operations (
        id, created_at, command, mode, input_file, options_hash, status
      ) VALUES (
        1, '2026-01-01T00:00:00.000Z', 'copy-filter', 'filter', NULL, 'filter-r80', 'completed'
      );
    `);
    oldDb.close();

    db = await initializeDatabase(dbPath);

    const tableNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lidarr_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((table) => table.name);
    const indexNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_lidarr_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((index) => index.name);

    expect(tableNames).toEqual([
      "lidarr_circuit_state",
      "lidarr_deferred_intents",
      "lidarr_metadata_cache",
    ]);
    expect(indexNames).toEqual([
      "idx_lidarr_deferred_intents_origin",
      "idx_lidarr_deferred_intents_status",
    ]);
    expect(getCurrentSchemaVersion(db)).toBe(11);
    expect(db.prepare("SELECT COUNT(*) FROM operations").pluck().get()).toBe(1);
  });
});

describe("Version 11 bridge identity snapshot migration", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the bridge table and preserves populated version 10 data", async () => {
    const dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);
    const operationId = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: "/fixtures/selection.yml",
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: "flac",
    });
    db.prepare(
      `INSERT INTO lidarr_metadata_cache (
         origin, category, discriminator, payload_json, fetched_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "http://lidarr.example.net:8686",
      "artists",
      "",
      '[{"id":41,"artistName":"Preserved Artist"}]',
      "2026-07-27T09:00:00.000Z",
    );
    db.exec(`
      DROP TABLE bridge_identity_snapshots;
      UPDATE metadata SET value = '10' WHERE key = 'schema_version';
    `);
    db.close();

    db = await initializeDatabase(dbPath);

    expect(getCurrentSchemaVersion(db)).toBe(11);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'bridge_identity_snapshots'",
        )
        .pluck()
        .get(),
    ).toBe("bridge_identity_snapshots");
    expect(db.prepare("SELECT command FROM operations WHERE id = ?").pluck().get(operationId)).toBe(
      "copy-filter",
    );
    expect(
      db
        .prepare(
          `SELECT payload_json FROM lidarr_metadata_cache
           WHERE origin = ? AND category = ? AND discriminator = ?`,
        )
        .pluck()
        .get("http://lidarr.example.net:8686", "artists", ""),
    ).toBe('[{"id":41,"artistName":"Preserved Artist"}]');
  });
});

describe("Inventory content hashes", () => {
  let tempDir: string;
  let db: DbConnection;
  let operationId: number;

  function inventoryRecord(relativePath: string, contentHash?: string | null) {
    return {
      sourcePath: "/music/Artist",
      relativePath,
      mtime: 1000,
      size: 42,
      rating: 0.8,
      destPath: `/dest/${relativePath}`,
      ...(contentHash !== undefined && { contentHash }),
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
    operationId = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: null,
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
    });
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists and returns destination content hashes", () => {
    const hash = "a".repeat(64);

    recordInventoryFile(db, operationId, {
      sourcePath: "/music/Artist",
      relativePath: "Album/track.flac",
      mtime: 1000,
      size: 42,
      rating: 0.8,
      destPath: "/dest/Album/track.flac",
      contentHash: hash,
    });

    const rows = getInventory(db, operationId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_hash).toBe(hash);
    expect(rows[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists valid content hashes in one batch", () => {
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);

    recordInventoryFiles(db, operationId, [
      inventoryRecord("Album/first.flac", firstHash),
      inventoryRecord("Album/second.flac", secondHash),
    ]);

    expect(getInventory(db, operationId).map((row) => row.content_hash)).toEqual([
      firstHash,
      secondHash,
    ]);
  });

  it("preserves null and omitted legacy content hashes", () => {
    recordInventoryFile(db, operationId, inventoryRecord("Album/null.flac", null));
    recordInventoryFile(db, operationId, inventoryRecord("Album/omitted.flac"));

    expect(getInventory(db, operationId).map((row) => row.content_hash)).toEqual([null, null]);
  });

  it.each([
    ["uppercase", "A".repeat(64)],
    ["short", "a".repeat(63)],
    ["long", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
  ])("rejects a %s content hash", (_label, contentHash) => {
    expect(() =>
      recordInventoryFile(db, operationId, inventoryRecord("Album/invalid.flac", contentHash)),
    ).toThrow("Invalid content hash: expected 64 lowercase hexadecimal characters");
    expect(getInventory(db, operationId)).toHaveLength(0);
  });

  it("rolls back a batch containing an invalid content hash", () => {
    expect(() =>
      recordInventoryFiles(db, operationId, [
        inventoryRecord("Album/valid.flac", "a".repeat(64)),
        inventoryRecord("Album/invalid.flac", "invalid"),
      ]),
    ).toThrow("Invalid content hash: expected 64 lowercase hexadecimal characters");

    expect(getInventory(db, operationId)).toHaveLength(0);
  });
});

describe("Read-only fingerprint access", () => {
  let tempDir: string;
  let db: DbConnection | undefined;

  const sourcePath = "/music/Artist's Collection";
  const relativePath = "Album/track.flac";
  const destinationPath = "/destination/Album/track.flac";
  const validHash = "a".repeat(64);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-readonly-test-"));
  });

  afterEach(async () => {
    db?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createCurrentDatabase(dbPath: string): Promise<number> {
    db = await initializeDatabase(dbPath);
    return createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: null,
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: "mp3",
    });
  }

  function recordCandidate(
    operationId: number,
    overrides: {
      sourcePath?: string;
      relativePath?: string;
      destinationPath?: string;
      contentHash?: string | null;
    } = {},
  ): void {
    if (!db) {
      throw new Error("Test database is not initialized");
    }

    recordInventoryFile(db, operationId, {
      sourcePath: overrides.sourcePath ?? sourcePath,
      relativePath: overrides.relativePath ?? relativePath,
      mtime: 1_750_000_000_000.5,
      size: 42,
      rating: 0.8,
      genre: "Rock",
      year: 2026,
      bpm: 120.5,
      artist: "Artist",
      destPath: overrides.destinationPath ?? destinationPath,
      contentHash: overrides.contentHash === undefined ? validHash : overrides.contentHash,
    });
  }

  async function closeWritableAndOpenReadOnly(dbPath: string): Promise<DbConnection> {
    db?.close();
    db = openDatabaseReadOnly(dbPath);
    return db;
  }

  async function databaseFilesSnapshot(): Promise<Map<string, Buffer>> {
    const snapshot = new Map<string, Buffer>();
    for (const name of (await readdir(tempDir)).sort()) {
      snapshot.set(name, await readFile(join(tempDir, name)));
    }
    return snapshot;
  }

  function schemaSnapshot(connection: DbConnection): unknown[] {
    return connection
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
  }

  it("opens only an existing schema-v11 database with query_only enabled", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    const readOnly = await closeWritableAndOpenReadOnly(dbPath);

    expect(readOnly.readonly).toBe(true);
    expect(readOnly.pragma("query_only", { simple: true })).toBe(1);
    expect(() =>
      readOnly.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("probe", "value"),
    ).toThrow();
  });

  it("does not create a missing database or its parent", () => {
    const missingDir = join(tempDir, "missing-parent");
    const dbPath = join(missingDir, "tracking.db");

    expect(() => openDatabaseReadOnly(dbPath)).toThrow();
    expect(existsSync(missingDir)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("opens only the exact reviewed database for reconciliation writes", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    const expectedSchema = schemaSnapshot(reviewed.database);
    reviewed.database.close();

    const { value: version } = withReconciliationDatabaseWritable(
      dbPath,
      reviewed.generation,
      (database) => {
        expect(database.readonly).toBe(false);
        expect(schemaSnapshot(database)).toEqual(expectedSchema);
        return getCurrentSchemaVersion(database);
      },
    );

    expect(version).toBe(11);
  });

  it("holds an immediate authority lease across external work and returns the committed generation", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    const lease = openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation);

    expect(lease.connection.inTransaction).toBe(true);
    expect(getCurrentSchemaVersion(lease.connection)).toBe(11);
    lease.connection
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("authority_lease", "committed");

    const competingWriter = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    try {
      expect(() => competingWriter.exec("BEGIN IMMEDIATE")).toThrow(/database is locked/i);
    } finally {
      competingWriter.close();
    }

    await Promise.resolve();
    expect(lease.connection.inTransaction).toBe(true);
    const generation = lease.commit();

    expect(generation).not.toEqual(reviewed.generation);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);

    const releasedWriter = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    try {
      expect(() => releasedWriter.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
    } finally {
      releasedWriter.close();
    }

    const committed = openReconciliationDatabaseReadOnly(dbPath);
    try {
      expect(
        committed.database
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("authority_lease"),
      ).toBe("committed");
      expect(committed.generation).toEqual(generation);
    } finally {
      committed.database.close();
    }
  });

  it("rolls back and releases an authority lease idempotently without leaking sidecars or handles", async () => {
    if (process.platform !== "linux" || !existsSync("/proc/self/fd")) return;

    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const openTempDirectoryHandles = async (): Promise<string[]> => {
      const descriptors = await readdir("/proc/self/fd");
      const targets = await Promise.all(
        descriptors.map(async (descriptor) => {
          try {
            return await readlink(`/proc/self/fd/${descriptor}`);
          } catch {
            return undefined;
          }
        }),
      );
      return targets.filter((target): target is string => target?.startsWith(tempDir) === true);
    };

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    expect(await openTempDirectoryHandles()).toEqual([]);

    const lease = openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation);
    lease.connection
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("authority_lease", "rolled-back");
    expect((await openTempDirectoryHandles()).length).toBeGreaterThan(0);

    lease.rollback();
    lease.rollback();
    lease.close();
    lease.close();

    expect(await openTempDirectoryHandles()).toEqual([]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
    expect(() => lease.commit()).toThrow("Reconciliation database authority lease is closed.");

    const rolledBack = openReconciliationDatabaseReadOnly(dbPath);
    try {
      expect(
        rolledBack.database
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("authority_lease"),
      ).toBeUndefined();
      expect(rolledBack.generation).toEqual(reviewed.generation);
    } finally {
      rolledBack.database.close();
    }
  });

  it("checks a trusted generation without opening SQLite or changing database files", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    const before = await databaseFilesSnapshot();

    assertReconciliationDatabaseGenerationCurrent(dbPath, reviewed.generation);

    expect(await databaseFilesSnapshot()).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  });

  it("rejects an externally committed generation without opening a writable transaction", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    assertReconciliationDatabaseGenerationCurrent(dbPath, reviewed.generation);

    const external = new Database(dbPath, { fileMustExist: true });
    external
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("external_generation", "changed");
    external.close();

    expect(() =>
      assertReconciliationDatabaseGenerationCurrent(dbPath, reviewed.generation),
    ).toThrow("Tracking database generation changed after reconciliation review.");
  });

  it("accepts root-owned sticky /tmp above the user-owned private database directory", async () => {
    if (process.platform !== "linux" || !tempDir.startsWith("/tmp/")) return;
    const tmpStats = lstatSync("/tmp");
    if (tmpStats.uid !== 0 || (tmpStats.mode & 0o1000) === 0) return;

    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;
    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();

    expect(() =>
      assertReconciliationDatabaseGenerationCurrent(dbPath, reviewed.generation),
    ).not.toThrow();
  });

  it("does not open or mutate a replacement hidden by an ABA race", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const movedReviewedPath = join(tempDir, "reviewed-during-open.db");
    const replacementPath = join(tempDir, "replacement.db");
    await createCurrentDatabase(dbPath);
    db?.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
      "identity_probe",
      "reviewed",
    );
    db?.close();
    db = undefined;

    const replacement = await initializeDatabase(replacementPath);
    replacement
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("identity_probe", "replacement");
    replacement.close();

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();

    expect(() =>
      openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation, {
        beforeSqliteOpen: () => {
          renameSync(dbPath, movedReviewedPath);
          renameSync(replacementPath, dbPath);
        },
        afterSqliteOpen: () => {
          renameSync(dbPath, replacementPath);
          renameSync(movedReviewedPath, dbPath);
        },
      }),
    ).toThrow("Tracking database identity changed while opening it for reconciliation.");
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const reviewedProbe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const replacementProbe = new Database(replacementPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        reviewedProbe
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("identity_probe"),
      ).toBe("reviewed");
      expect(
        replacementProbe
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("identity_probe"),
      ).toBe("replacement");
    } finally {
      reviewedProbe.close();
      replacementProbe.close();
    }
  });

  it("pins the reviewed WAL namespace through a post-open ABA swap and guarded update", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const movedReviewedPath = join(tempDir, "reviewed-during-update.db");
    const replacementPath = join(tempDir, "replacement.db");
    await createCurrentDatabase(dbPath);
    db?.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
      "identity_probe",
      "reviewed",
    );
    db?.close();
    db = undefined;

    const replacement = await initializeDatabase(replacementPath);
    replacement
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("identity_probe", "replacement");
    replacement.close();

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();

    withReconciliationDatabaseWritable(dbPath, reviewed.generation, (database) => {
      renameSync(dbPath, movedReviewedPath);
      renameSync(replacementPath, dbPath);
      database
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run("reviewed-updated", "identity_probe");
      renameSync(dbPath, replacementPath);
      renameSync(movedReviewedPath, dbPath);
    });

    const reviewedProbe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const replacementProbe = new Database(replacementPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        reviewedProbe
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("identity_probe"),
      ).toBe("reviewed-updated");
      expect(
        replacementProbe
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("identity_probe"),
      ).toBe("replacement");
    } finally {
      reviewedProbe.close();
      replacementProbe.close();
    }
  });

  it("rejects an untrusted writable parent before opening a reconciliation transaction", async () => {
    const writableParent = join(tempDir, "writable-parent");
    await mkdir(writableParent, { mode: 0o700 });
    const dbPath = join(writableParent, "tracking.db");
    const connection = await initializeDatabase(dbPath);
    connection.close();

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    chmodSync(writableParent, 0o777);

    const beforeTransactionOpen = vi.fn();
    expect(() =>
      openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation, {
        beforeTransactionOpen,
      }),
    ).toThrow("Tracking database ancestors must not grant unsafe group or world writes.");
    expect(beforeTransactionOpen).not.toHaveBeenCalled();
  });

  it("rejects an unsafe writable ancestor above a private database parent", async () => {
    const writableAncestor = join(tempDir, "writable-ancestor");
    const privateParent = join(writableAncestor, "private");
    await mkdir(privateParent, { recursive: true, mode: 0o700 });
    const dbPath = join(privateParent, "tracking.db");
    const connection = await initializeDatabase(dbPath);
    connection.close();

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    chmodSync(writableAncestor, 0o777);

    expect(() =>
      assertReconciliationDatabaseGenerationCurrent(dbPath, reviewed.generation),
    ).toThrow("Tracking database ancestors must not grant unsafe group or world writes.");
  });

  it("detects a complete-chain ancestor swap at the final trust check before BEGIN", async () => {
    const libraryParent = join(tempDir, "library");
    const movedParent = join(tempDir, "library-moved");
    const replacementParent = join(tempDir, "library-replacement");
    const privateDirectory = "private";
    await mkdir(join(libraryParent, privateDirectory), { recursive: true, mode: 0o700 });
    await mkdir(join(replacementParent, privateDirectory), { recursive: true, mode: 0o700 });
    const dbPath = join(libraryParent, privateDirectory, "tracking.db");
    const connection = await initializeDatabase(dbPath);
    connection.close();

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    const operation = vi.fn();

    expect(() =>
      withReconciliationDatabaseWritable(dbPath, reviewed.generation, operation, {
        beforeTransactionOpen: () => {
          renameSync(libraryParent, movedParent);
          renameSync(replacementParent, libraryParent);
        },
        afterTransactionOpen: () => {
          renameSync(libraryParent, replacementParent);
          renameSync(movedParent, libraryParent);
        },
      }),
    ).toThrow("Tracking database ancestor changed while opening it for reconciliation.");

    expect(operation).not.toHaveBeenCalled();
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(join(replacementParent, privateDirectory, "tracking.db"))).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("rolls back when a competing commit lands after the final precheck but before BEGIN", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    const competingCommit = vi.fn(() => {
      const competing = new Database(dbPath, { fileMustExist: true, timeout: 0 });
      try {
        competing
          .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
          .run("competing_generation", "x".repeat(1024 * 1024));
        competing.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        competing.close();
      }
    });

    let lease: ReturnType<typeof openReconciliationDatabaseAuthorityLease> | undefined;
    let openError: unknown;
    try {
      lease = openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation, {
        beforeImmediateTransactionOpen: competingCommit,
      });
    } catch (error) {
      openError = error;
    } finally {
      lease?.close();
    }

    expect(competingCommit).toHaveBeenCalledOnce();
    expect(openError).toBeInstanceOf(Error);
    expect((openError as Error).message).toBe(
      "Tracking database generation changed while starting reconciliation update.",
    );
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);

    const committed = openReconciliationDatabaseReadOnly(dbPath);
    try {
      expect(committed.generation).not.toEqual(reviewed.generation);
      expect(
        committed.database
          .prepare("SELECT length(value) FROM metadata WHERE key = ?")
          .pluck()
          .get("competing_generation"),
      ).toBe(1024 * 1024);
    } finally {
      committed.database.close();
    }
  });

  it("rejects an uncheckpointed WAL commit after the final precheck but before BEGIN", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    let competing: Database.Database | undefined;
    const competingCommit = vi.fn(() => {
      competing = new Database(dbPath, { fileMustExist: true, timeout: 0 });
      competing
        .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
        .run("competing_wal_generation", "uncheckpointed");
    });

    let lease: ReturnType<typeof openReconciliationDatabaseAuthorityLease> | undefined;
    let openError: unknown;
    try {
      lease = openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation, {
        beforeImmediateTransactionOpen: competingCommit,
        afterTransactionOpen: () => competing?.close(),
      });
    } catch (error) {
      openError = error;
    } finally {
      lease?.close();
    }

    expect(competingCommit).toHaveBeenCalledOnce();
    expect(openError).toBeInstanceOf(Error);
    expect((openError as Error).message).toBe(
      "Tracking database generation changed while starting reconciliation update.",
    );

    const committed = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(
        committed
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("competing_wal_generation"),
      ).toBe("uncheckpointed");
    } finally {
      committed.close();
    }
  });

  it("rejects an uncheckpointed WAL commit after the filesystem precheck before logical resampling", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    let competing: Database.Database | undefined;
    const competingCommit = vi.fn(() => {
      competing = new Database(dbPath, { fileMustExist: true, timeout: 0 });
      competing
        .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
        .run("competing_precheck_generation", "uncheckpointed");
    });

    let lease: ReturnType<typeof openReconciliationDatabaseAuthorityLease> | undefined;
    let openError: unknown;
    try {
      lease = openReconciliationDatabaseAuthorityLease(dbPath, reviewed.generation, {
        afterGenerationPrecheck: competingCommit,
        afterTransactionOpen: () => competing?.close(),
      });
    } catch (error) {
      openError = error;
    } finally {
      lease?.close();
    }

    expect(competingCommit).toHaveBeenCalledOnce();
    expect(openError).toBeInstanceOf(Error);
    expect((openError as Error).message).toBe(
      "Tracking database generation changed while starting reconciliation update.",
    );

    const committed = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(
        committed
          .prepare("SELECT value FROM metadata WHERE key = ?")
          .pluck()
          .get("competing_precheck_generation"),
      ).toBe("uncheckpointed");
    } finally {
      committed.close();
    }
  });

  it("rejects group/world and ACL-effective writes on the main database file", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;
    chmodSync(dbPath, 0o660);

    const modeReviewed = openReconciliationDatabaseReadOnly(dbPath);
    modeReviewed.database.close();
    const beforeTransactionOpen = vi.fn();
    expect(() =>
      withReconciliationDatabaseWritable(dbPath, modeReviewed.generation, () => undefined, {
        beforeTransactionOpen,
      }),
    ).toThrow(
      "Tracking database file must have a trusted owner and no group, world, or ACL-effective write access.",
    );
    expect(beforeTransactionOpen).not.toHaveBeenCalled();

    chmodSync(dbPath, 0o600);
    const namedUser = process.geteuid?.() === 65534 ? "65533" : "65534";
    try {
      execFileSync("setfacl", ["-m", `u:${namedUser}:rw-`, dbPath], { stdio: "ignore" });
    } catch {
      return;
    }
    const aclReviewed = openReconciliationDatabaseReadOnly(dbPath);
    aclReviewed.database.close();
    expect(() =>
      assertReconciliationDatabaseGenerationCurrent(dbPath, aclReviewed.generation),
    ).toThrow(
      "Tracking database file must have a trusted owner and no group, world, or ACL-effective write access.",
    );
  });

  it("rejects an untrusted main database owner when ownership changes are permitted", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;
    const original = lstatSync(dbPath);
    const untrustedUser = original.uid === 65534 ? 65533 : 65534;
    try {
      chownSync(dbPath, untrustedUser, original.gid);
    } catch {
      return;
    }

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    expect(() =>
      assertReconciliationDatabaseGenerationCurrent(dbPath, reviewed.generation),
    ).toThrow(
      "Tracking database file must have a trusted owner and no group, world, or ACL-effective write access.",
    );
  });

  it("does not create a missing reconciliation write target", () => {
    const missingDir = join(tempDir, "missing-write-parent");
    const dbPath = join(missingDir, "tracking.db");

    expect(() =>
      withReconciliationDatabaseWritable(
        dbPath,
        { device: 1, inode: 1, size: 0, mtimeMs: 0, ctimeMs: 0 },
        () => undefined,
      ),
    ).toThrow();
    expect(existsSync(missingDir)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects a symlink swapped in after the immutable review", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const movedPath = join(tempDir, "reviewed.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    await rename(dbPath, movedPath);
    await symlink(movedPath, dbPath);

    expect(() =>
      withReconciliationDatabaseWritable(dbPath, reviewed.generation, () => undefined),
    ).toThrow("Tracking database generation changed after reconciliation review.");
  });

  it("rejects an older same-inode schema without migrating it", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    db?.close();
    db = undefined;

    openReconciliationDatabaseReadOnly(dbPath).database.close();
    const changed = new Database(dbPath, { fileMustExist: true });
    changed.prepare("UPDATE metadata SET value = '10' WHERE key = 'schema_version'").run();
    changed.close();
    const changedStats = lstatSync(dbPath);

    expect(() =>
      withReconciliationDatabaseWritable(
        dbPath,
        {
          device: changedStats.dev,
          inode: changedStats.ino,
          size: changedStats.size,
          mtimeMs: changedStats.mtimeMs,
          ctimeMs: changedStats.ctimeMs,
        },
        () => undefined,
      ),
    ).toThrow("Database schema version 10 is not the required reconciliation version 11.");
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(getCurrentSchemaVersion(probe)).toBe(10);
    probe.close();
  });

  it("rejects an oversized database before creating an in-memory snapshot", async () => {
    const oversizedPath = join(tempDir, "oversized.db");
    await writeFile(oversizedPath, "");
    await truncate(oversizedPath, READ_ONLY_DATABASE_MAX_BYTES + 1);

    expect(() => openDatabaseReadOnly(oversizedPath)).toThrow(
      `Tracking database exceeds the ${READ_ONLY_DATABASE_MAX_BYTES}-byte read-only snapshot limit.`,
    );
  });

  it("refuses an active WAL snapshot without changing its sidecars", async () => {
    const dbPath = join(tempDir, "active.db");
    await createCurrentDatabase(dbPath);
    db?.exec("CREATE TABLE active_writer_probe (id INTEGER PRIMARY KEY)");
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    const before = await databaseFilesSnapshot();

    expect(() => openDatabaseReadOnly(dbPath)).toThrow(
      "Tracking database has active SQLite sidecars and cannot be read immutably",
    );
    expect(await databaseFilesSnapshot()).toEqual(before);
  });

  it.each([
    ["older", "10", "older than required version 11"],
    ["newer", "12", "newer than supported version 11"],
  ])("rejects a %s schema without migrating it", async (_label, version, message) => {
    const dbPath = join(tempDir, `${_label}.db`);
    await createCurrentDatabase(dbPath);
    db?.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(version);
    db?.close();
    db = undefined;
    const before = await databaseFilesSnapshot();

    expect(() => openDatabaseReadOnly(dbPath)).toThrow(message);

    expect(await databaseFilesSnapshot()).toEqual(before);
  });

  it("rejects malformed SQLite and schema metadata without modifying either file", async () => {
    const invalidSqlitePath = join(tempDir, "invalid.db");
    await writeFile(invalidSqlitePath, "not a sqlite database");
    const invalidBefore = await readFile(invalidSqlitePath);

    expect(() => openDatabaseReadOnly(invalidSqlitePath)).toThrow();
    expect(await readFile(invalidSqlitePath)).toEqual(invalidBefore);

    const malformedPath = join(tempDir, "malformed.db");
    const malformed = new Database(malformedPath);
    malformed.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    malformed
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "9.0");
    malformed.close();
    const malformedBefore = await readFile(malformedPath);

    expect(() => openDatabaseReadOnly(malformedPath)).toThrow(
      "Database schema metadata is malformed: schema_version must be a positive integer",
    );
    expect(await readFile(malformedPath)).toEqual(malformedBefore);
  });

  it("returns no candidates for an empty source list", async () => {
    const dbPath = join(tempDir, "tracking.db");
    await createCurrentDatabase(dbPath);
    const readOnly = await closeWritableAndOpenReadOnly(dbPath);

    expect(getInventoryFingerprintCandidates(readOnly, [])).toEqual([]);
  });

  it("uses bound source paths and returns joined conversion identity", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const operationId = await createCurrentDatabase(dbPath);
    recordCandidate(operationId);
    const injectionLikeSource = "/music/x'); DROP TABLE inventory; --";
    recordCandidate(operationId, {
      sourcePath: injectionLikeSource,
      relativePath: "Quoted/track.flac",
      destinationPath: "/destination/Quoted/track.flac",
    });
    const readOnly = await closeWritableAndOpenReadOnly(dbPath);

    const candidates = getInventoryFingerprintCandidates(readOnly, [
      sourcePath,
      injectionLikeSource,
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.source_path).sort()).toEqual(
      [sourcePath, injectionLikeSource].sort(),
    );
    expect(candidates.every((candidate) => candidate.convert_key === "mp3")).toBe(true);
    expect(readOnly.prepare("SELECT COUNT(*) FROM inventory").pluck().get()).toBe(2);
  });

  it("preserves null and malformed digest evidence for per-file classification", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const operationId = await createCurrentDatabase(dbPath);
    recordCandidate(operationId, { relativePath: "Album/null.flac", contentHash: null });
    recordCandidate(operationId, { relativePath: "Album/invalid.flac" });
    db?.prepare("UPDATE inventory SET content_hash = ? WHERE relative_path = ?").run(
      "INVALID-DIGEST",
      "Album/invalid.flac",
    );
    const readOnly = await closeWritableAndOpenReadOnly(dbPath);

    const candidates = getInventoryFingerprintCandidates(readOnly, [sourcePath]);
    expect(candidates.map((candidate) => candidate.content_hash)).toEqual(["INVALID-DIGEST", null]);
  });

  it("returns duplicate candidates in deterministic newest-first order", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const firstOperationId = await createCurrentDatabase(dbPath);
    recordCandidate(firstOperationId);
    const secondOperationId = createOperation(db!, {
      command: "copy-filter",
      mode: "filter",
      inputFile: null,
      optionsHash: "filter-r80-second",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
    });
    recordCandidate(secondOperationId);
    db?.prepare("UPDATE inventory SET copied_at = ? WHERE operation_id = ?").run(
      2_000,
      firstOperationId,
    );
    db?.prepare("UPDATE inventory SET copied_at = ? WHERE operation_id = ?").run(
      2_000,
      secondOperationId,
    );
    const readOnly = await closeWritableAndOpenReadOnly(dbPath);

    const candidates = getInventoryFingerprintCandidates(readOnly, [sourcePath]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.operation_id)).toEqual([
      secondOperationId,
      firstOperationId,
    ]);
    expect(candidates.map((candidate) => candidate.convert_key)).toEqual([null, "mp3"]);
  });

  it.each([
    ["source_path", "relative/source", "source_path must be an absolute path"],
    ["relative_path", "../escape.flac", "relative_path must be a normalized relative path"],
    ["dest_path", "relative/destination.flac", "dest_path must be an absolute path"],
    ["mtime", "not-a-number", "mtime must be a finite non-negative number"],
    ["size", -1, "size must be a non-negative safe integer"],
    ["rating", "not-a-number", "rating must be null or a finite number"],
    ["year", 2026.5, "year must be null or a safe integer"],
    ["content_hash", Buffer.from([1, 2]), "content_hash must be null or a string"],
    ["copied_at", Number.POSITIVE_INFINITY, "copied_at must be a finite non-negative number"],
  ])("rejects a structurally invalid %s value", async (column, value, message) => {
    const dbPath = join(tempDir, "tracking.db");
    const operationId = await createCurrentDatabase(dbPath);
    recordCandidate(operationId);
    db?.prepare(`UPDATE inventory SET ${column} = ?`).run(value);
    const readOnly = await closeWritableAndOpenReadOnly(dbPath);
    const requestedSources = column === "source_path" ? [String(value)] : [sourcePath];

    expect(() => getInventoryFingerprintCandidates(readOnly, requestedSources)).toThrow(message);
  });

  it("does not change database bytes, schema, journal mode, or create sidecars", async () => {
    const dbPath = join(tempDir, "tracking.db");
    const operationId = await createCurrentDatabase(dbPath);
    recordCandidate(operationId);
    const beforeSchema = schemaSnapshot(db!);
    const beforeJournalMode = db?.pragma("journal_mode", { simple: true });
    db?.close();
    db = undefined;

    const beforeFiles = await databaseFilesSnapshot();

    const readOnly = openDatabaseReadOnly(dbPath);
    expect(getInventoryFingerprintCandidates(readOnly, [sourcePath])).toHaveLength(1);
    expect(schemaSnapshot(readOnly)).toEqual(beforeSchema);
    readOnly.close();

    expect(await databaseFilesSnapshot()).toEqual(beforeFiles);
    const persistedHeader = await readFile(dbPath);
    expect(beforeJournalMode).toBe("wal");
    expect([persistedHeader[18], persistedHeader[19]]).toEqual([2, 2]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("Reconciliation inventory access", () => {
  let tempDir: string;
  let db: DbConnection;
  let firstOperationId: number;
  let secondOperationId: number;
  let recordIndex: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-db-reconciliation-test-"));
    db = await initializeDatabase(join(tempDir, "tracking.db"));
    firstOperationId = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: null,
      optionsHash: "first-operation",
      ratingKey: null,
      rangeKey: null,
      convertKey: null,
    });
    secondOperationId = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: null,
      optionsHash: "second-operation",
      ratingKey: null,
      rangeKey: null,
      convertKey: null,
    });
    recordIndex = 0;
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function recordReconciliationCandidate(
    operationId: number,
    destPath: string,
    overrides: {
      rating?: number | null;
      mtime?: number;
      size?: number;
    } = {},
  ): void {
    recordIndex += 1;
    recordInventoryFile(db, operationId, {
      sourcePath: `/source/Artist-${recordIndex}`,
      relativePath: `Album/track-${recordIndex}.flac`,
      mtime: overrides.mtime ?? 1_000,
      size: overrides.size ?? 42,
      rating: overrides.rating === undefined ? 0.8 : overrides.rating,
      genre: "Rock",
      year: 2026,
      bpm: 120,
      artist: "Artist",
      destPath,
      contentHash: "a".repeat(64),
    });
  }

  it("selects an exact destination root and optional operation while preserving duplicates deterministically", () => {
    const root = "/library/Metadata";
    recordReconciliationCandidate(firstOperationId, `${root}/b.flac`);
    recordReconciliationCandidate(secondOperationId, `${root}/b.flac`);
    recordReconciliationCandidate(firstOperationId, `${root}/a.flac`);
    recordReconciliationCandidate(firstOperationId, "/library/Metadata2/outside.flac");

    const candidates = getReconciliationInventoryCandidates(db, root);

    expect(candidates.map(({ dest_path, operation_id }) => [dest_path, operation_id])).toEqual([
      [`${root}/a.flac`, firstOperationId],
      [`${root}/b.flac`, firstOperationId],
      [`${root}/b.flac`, secondOperationId],
    ]);
    expect(getReconciliationInventoryCandidates(db, root, secondOperationId)).toEqual([
      expect.objectContaining({
        dest_path: `${root}/b.flac`,
        operation_id: secondOperationId,
      }),
    ]);
  });

  it("treats wildcard-looking roots as literal path text", () => {
    const root = "/library/100%_Hits";
    recordReconciliationCandidate(firstOperationId, `${root}/inside.flac`);
    recordReconciliationCandidate(firstOperationId, "/library/100AB_Hits/outside.flac");

    expect(getReconciliationInventoryCandidates(db, root).map((row) => row.dest_path)).toEqual([
      `${root}/inside.flac`,
    ]);
  });

  it("returns an empty result for an unrepresented destination root", () => {
    expect(getReconciliationInventoryCandidates(db, "/library/empty")).toEqual([]);
  });

  it("reads only the exact guarded destination and preserves duplicate ambiguity", () => {
    const exactPath = "/library/exact/track.flac";
    recordReconciliationCandidate(firstOperationId, exactPath);
    recordReconciliationCandidate(secondOperationId, exactPath);
    recordReconciliationCandidate(firstOperationId, "/library/exact/other.flac");

    expect(
      getReconciliationInventoryCandidatesAtPath(db, exactPath).map(
        ({ dest_path, operation_id }) => [dest_path, operation_id],
      ),
    ).toEqual([
      [exactPath, firstOperationId],
      [exactPath, secondOperationId],
    ]);
    expect(getReconciliationInventoryCandidatesAtPath(db, exactPath, secondOperationId)).toEqual([
      expect.objectContaining({ dest_path: exactPath, operation_id: secondOperationId }),
    ]);
  });

  it("rejects non-normalized paths before an exact reconciliation guard query", () => {
    expect(() =>
      getReconciliationInventoryCandidatesAtPath(db, "/library/exact/../track.flac"),
    ).toThrow("dest_path must be normalized");
  });

  it("fails closed instead of truncating candidates at the requested hard cap", () => {
    recordReconciliationCandidate(firstOperationId, "/library/capped/first.flac");
    recordReconciliationCandidate(firstOperationId, "/library/capped/second.flac");

    expect(() => getReconciliationInventoryCandidates(db, "/library/capped", undefined, 1)).toThrow(
      "Reconciliation inventory query exceeds the 1-row limit",
    );
    expect(() =>
      getReconciliationInventoryCandidates(
        db,
        "/library/capped",
        undefined,
        RECONCILIATION_INVENTORY_MAX_CANDIDATES + 1,
      ),
    ).toThrow("Reconciliation inventory limit must be a positive safe integer");
  });

  it("validates unknown SQLite values in selected candidates", () => {
    recordReconciliationCandidate(firstOperationId, "/library/invalid/track.flac");
    db.prepare("UPDATE inventory SET size = ?").run("invalid-size");

    expect(() => getReconciliationInventoryCandidates(db, "/library/invalid")).toThrow(
      "size must be a non-negative safe integer",
    );
  });

  it("supports successful rating-only and stat-only guarded updates", () => {
    recordReconciliationCandidate(firstOperationId, "/library/updates/rating.flac");
    recordReconciliationCandidate(firstOperationId, "/library/updates/stat.flac", {
      rating: null,
    });
    const [ratingRow, statRow] = getReconciliationInventoryCandidates(db, "/library/updates");
    if (ratingRow === undefined || statRow === undefined) {
      throw new Error("Expected both reconciliation inventory fixtures");
    }

    expect(
      updateReconciliationInventory(db, {
        expected: {
          rowId: ratingRow.id,
          operationId: ratingRow.operation_id,
          destPath: ratingRow.dest_path,
          rating: ratingRow.rating,
          mtime: ratingRow.mtime,
          size: ratingRow.size,
        },
        rating: 0.9,
      }),
    ).toEqual({ status: "updated", rowId: ratingRow.id });
    expect(
      updateReconciliationInventory(db, {
        expected: {
          rowId: statRow.id,
          operationId: statRow.operation_id,
          destPath: statRow.dest_path,
          rating: statRow.rating,
          mtime: statRow.mtime,
          size: statRow.size,
        },
        stat: { mtime: 2_000, size: 84 },
      }),
    ).toEqual({ status: "updated", rowId: statRow.id });

    const updatedRows = getReconciliationInventoryCandidates(db, "/library/updates");
    expect(updatedRows).toEqual([
      expect.objectContaining({
        id: ratingRow.id,
        rating: 0.9,
        mtime: ratingRow.mtime,
        size: ratingRow.size,
        copied_at: ratingRow.copied_at,
      }),
      expect.objectContaining({
        id: statRow.id,
        rating: null,
        mtime: 2_000,
        size: 84,
        copied_at: statRow.copied_at,
      }),
    ]);
  });

  it("commits nested guarded updates, preserves stale results, and rolls back callback failures", () => {
    const dbPath = join(tempDir, "tracking.db");
    const destPath = "/library/transaction/track.flac";
    recordReconciliationCandidate(firstOperationId, destPath);
    const candidate = getReconciliationInventoryCandidates(db, "/library/transaction")[0];
    if (candidate === undefined) throw new Error("Expected reconciliation transaction fixture");
    db.close();

    const reviewed = openReconciliationDatabaseReadOnly(dbPath);
    reviewed.database.close();
    const update = {
      expected: {
        rowId: candidate.id,
        operationId: candidate.operation_id,
        destPath: candidate.dest_path,
        rating: candidate.rating,
        mtime: candidate.mtime,
        size: candidate.size,
      },
      rating: 0.9,
    } as const;

    const firstUpdate = withReconciliationDatabaseWritable(
      dbPath,
      reviewed.generation,
      (database) => updateReconciliationInventory(database, update),
    );
    expect(firstUpdate.value).toEqual({ status: "updated", rowId: candidate.id });
    const staleUpdate = withReconciliationDatabaseWritable(
      dbPath,
      firstUpdate.generation,
      (database) => updateReconciliationInventory(database, update),
    );
    expect(staleUpdate.value).toEqual({ status: "stale-evidence", rowId: candidate.id });
    expect(() =>
      withReconciliationDatabaseWritable(dbPath, staleUpdate.generation, (database) => {
        database.prepare("UPDATE inventory SET rating = ? WHERE id = ?").run(0.4, candidate.id);
        throw new Error("rollback-probe");
      }),
    ).toThrow("rollback-probe");

    db = new Database(dbPath);
    expect(db.prepare("SELECT rating FROM inventory WHERE id = ?").pluck().get(candidate.id)).toBe(
      0.9,
    );
  });

  it("returns stale evidence without overwriting a row after a captured guard changes", () => {
    const destPath = "/library/stale/track.flac";
    recordReconciliationCandidate(firstOperationId, destPath);
    const candidate = getReconciliationInventoryCandidates(db, "/library/stale")[0];
    if (candidate === undefined) {
      throw new Error("Expected a reconciliation inventory fixture");
    }
    db.prepare("UPDATE inventory SET mtime = ? WHERE id = ?").run(
      candidate.mtime + 1,
      candidate.id,
    );

    expect(
      updateReconciliationInventory(db, {
        expected: {
          rowId: candidate.id,
          operationId: candidate.operation_id,
          destPath: candidate.dest_path,
          rating: candidate.rating,
          mtime: candidate.mtime,
          size: candidate.size,
        },
        rating: 0.9,
        stat: { mtime: 2_000, size: 84 },
      }),
    ).toEqual({ status: "stale-evidence", rowId: candidate.id });
    expect(
      db.prepare("SELECT rating, mtime, size FROM inventory WHERE id = ?").get(candidate.id),
    ).toEqual({
      rating: candidate.rating,
      mtime: candidate.mtime + 1,
      size: candidate.size,
    });
  });
});
