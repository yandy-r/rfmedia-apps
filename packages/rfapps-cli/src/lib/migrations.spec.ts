/**
 * Tests for the database migration system.
 *
 * Uses a real in-memory SQLite database so the v2 generations backfill SQL
 * (window-function numbering, action/status filtering) is verified against
 * real SQL behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@rfmedia/common", () => ({
  logDebug: vi.fn(),
}));

import { CURRENT_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import {
  closeDatabase,
  getCurrentSchemaVersion,
  initializeDatabase,
  updateSchemaVersion,
} from "./db.js";
import type { DbConnection } from "./db.js";

const CURRENT_SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");

/**
 * Schema as it existed at version 1, before the generations table.
 * Used to simulate databases created by older CLI versions.
 */
const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    image_tag TEXT,
    config_snapshot TEXT,
    status TEXT NOT NULL,
    plan_id TEXT,
    error_message TEXT
  );

  INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '1');
`;

/**
 * Schema as it existed at version 2, before immutable image identity fields.
 * Used to verify the exact supported v2-to-v3 upgrade path.
 */
const V2_SCHEMA = `
  CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    image_tag TEXT,
    config_snapshot TEXT,
    status TEXT NOT NULL,
    plan_id TEXT,
    error_message TEXT
  );

  CREATE INDEX idx_deployments_service ON deployments(service);
  CREATE INDEX idx_deployments_timestamp ON deployments(timestamp);
  CREATE INDEX idx_deployments_action ON deployments(action);

  CREATE TABLE generations (
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

  CREATE INDEX idx_generations_service ON generations(service);
  CREATE INDEX idx_generations_timestamp ON generations(timestamp);

  INSERT INTO metadata (key, value) VALUES ('schema_version', '2');
`;

function createV1Db(): DbConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(V1_SCHEMA);
  return db;
}

function createV2Db(): DbConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(V2_SCHEMA);
  return db;
}

function getColumnNames(db: DbConnection, table: "deployments" | "generations"): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function getIndexNames(db: DbConnection, table: "deployments" | "generations"): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map(
    (entry) => entry.name,
  );
}

function insertDeployment(
  db: DbConnection,
  entry: {
    timestamp: string;
    service: string;
    action: string;
    status: string;
    imageTag?: string;
    configSnapshot?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO deployments (timestamp, service, action, image_tag, config_snapshot, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.timestamp,
      entry.service,
      entry.action,
      entry.imageTag ?? null,
      entry.configSnapshot ?? null,
      entry.status,
    );
  return Number(result.lastInsertRowid);
}

describe("migrations", () => {
  let db: DbConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createV1Db();
  });

  it("initializes a clean database at schema version 3 with nullable identity columns", () => {
    const freshDb = new Database(":memory:");
    freshDb.pragma("foreign_keys = ON");

    freshDb.exec(CURRENT_SCHEMA);
    runMigrations(freshDb);

    expect(getCurrentSchemaVersion(freshDb)).toBe(3);
    expect(getColumnNames(freshDb, "deployments")).toEqual(
      expect.arrayContaining(["image_id", "image_digest"]),
    );
    expect(getColumnNames(freshDb, "generations")).toEqual(
      expect.arrayContaining(["image_id", "image_digest"]),
    );
    expect(getIndexNames(freshDb, "generations")).toContain(
      "idx_generations_service_image_id_generation",
    );

    const insertDeploymentSql = `INSERT INTO deployments (service, action, status)
VALUES ('traefik', 'deploy', 'success')
RETURNING image_id, image_digest`;
    const deployment = freshDb.prepare(insertDeploymentSql).get();
    expect(deployment).toEqual({ image_id: null, image_digest: null });
  });

  it("upgrades a real v2 database to v3 without backfilling legacy identity fields", () => {
    const v2Db = createV2Db();
    const deploymentId = insertDeployment(v2Db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "success",
      imageTag: "traefik:v3",
    });
    const insertGenerationSql = `INSERT INTO generations (
service, generation, deployment_id, timestamp, image_tag, created_by_action
) VALUES (?, ?, ?, ?, ?, ?)`;
    v2Db
      .prepare(insertGenerationSql)
      .run("traefik", 1, deploymentId, "2026-01-01T00:00:00.000Z", "traefik:v3", "deploy");

    runMigrations(v2Db);

    expect(getCurrentSchemaVersion(v2Db)).toBe(3);
    expect(
      v2Db.prepare("SELECT image_id, image_digest FROM deployments WHERE id = ?").get(deploymentId),
    ).toEqual({ image_id: null, image_digest: null });
    const generation = v2Db
      .prepare("SELECT image_id, image_digest FROM generations WHERE deployment_id = ?")
      .get(deploymentId);
    expect(generation).toEqual({ image_id: null, image_digest: null });
  });

  it("initializes and upgrades an on-disk v1 database through the schema-first path", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "rfapps-v1-migration-"));
    const fixturePath = join(fixtureDirectory, "state.db");
    const legacyDb = new Database(fixturePath);
    legacyDb.exec(V1_SCHEMA);
    legacyDb.close();

    let upgradedDb: DbConnection | undefined;
    try {
      upgradedDb = await initializeDatabase(fixturePath);

      expect(getCurrentSchemaVersion(upgradedDb)).toBe(CURRENT_SCHEMA_VERSION);
      expect(getColumnNames(upgradedDb, "deployments")).toEqual(
        expect.arrayContaining(["image_id", "image_digest"]),
      );
      expect(getColumnNames(upgradedDb, "generations")).toEqual(
        expect.arrayContaining(["image_id", "image_digest"]),
      );
    } finally {
      if (upgradedDb) {
        closeDatabase(upgradedDb);
      }
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("initializes and upgrades an on-disk v2 database before creating the identity index", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "rfapps-v2-migration-"));
    const fixturePath = join(fixtureDirectory, "state.db");
    const legacyDb = new Database(fixturePath);
    legacyDb.exec(V2_SCHEMA);
    legacyDb
      .prepare(
        `INSERT INTO generations
          (service, generation, timestamp, image_tag, created_by_action)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("traefik", 1, "2026-01-01T00:00:00.000Z", "traefik:v2", "deploy");
    legacyDb.close();

    let upgradedDb: DbConnection | undefined;
    try {
      upgradedDb = await initializeDatabase(fixturePath);

      expect(getCurrentSchemaVersion(upgradedDb)).toBe(CURRENT_SCHEMA_VERSION);
      expect(getColumnNames(upgradedDb, "generations")).toEqual(
        expect.arrayContaining(["image_id", "image_digest"]),
      );
      expect(getIndexNames(upgradedDb, "generations")).toContain(
        "idx_generations_service_image_id_generation",
      );
      expect(
        upgradedDb
          .prepare(
            `SELECT generation, image_id, image_digest
             FROM generations WHERE service = ?`,
          )
          .get("traefik"),
      ).toEqual({ generation: 1, image_id: null, image_digest: null });
    } finally {
      if (upgradedDb) closeDatabase(upgradedDb);
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back every v3 schema change when migration fails", () => {
    const incompleteV2Db = new Database(":memory:");
    incompleteV2Db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE deployments (
id INTEGER PRIMARY KEY AUTOINCREMENT,
timestamp TEXT NOT NULL DEFAULT (datetime('now')),
service TEXT NOT NULL,
action TEXT NOT NULL,
image_tag TEXT,
config_snapshot TEXT,
status TEXT NOT NULL,
plan_id TEXT,
error_message TEXT
      );
      INSERT INTO metadata (key, value) VALUES ('schema_version', '2');
    `);

    expect(() => runMigrations(incompleteV2Db)).toThrow(/no such table: generations/);

    expect(getCurrentSchemaVersion(incompleteV2Db)).toBe(2);
    expect(getColumnNames(incompleteV2Db, "deployments")).not.toEqual(
      expect.arrayContaining(["image_id", "image_digest"]),
    );
  });

  it("supports repeated schema initialization without duplicate columns or metadata", () => {
    const freshDb = new Database(":memory:");

    freshDb.exec(CURRENT_SCHEMA);
    runMigrations(freshDb);
    freshDb.exec(CURRENT_SCHEMA);
    runMigrations(freshDb);

    expect(
      getColumnNames(freshDb, "deployments").filter((name) => name === "image_id"),
    ).toHaveLength(1);
    expect(
      getColumnNames(freshDb, "generations").filter((name) => name === "image_digest"),
    ).toHaveLength(1);
    expect(
      freshDb.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key = 'schema_version'").get(),
    ).toEqual({ count: 1 });
    expect(getIndexNames(freshDb, "generations")).toContain(
      "idx_generations_service_image_id_generation",
    );
  });

  it("upgrades a v1 database to the current schema version", () => {
    expect(getCurrentSchemaVersion(db)).toBe(1);

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // generations table exists and is queryable
    const count = db.prepare("SELECT COUNT(*) as count FROM generations").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("backfills generations from successful deploy-like deployments", () => {
    const d1 = insertDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "success",
      imageTag: "traefik:v1",
      configSnapshot: JSON.stringify({ image: "traefik:v1" }),
    });
    insertDeployment(db, {
      timestamp: "2026-01-02T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "failed", // excluded: not successful
    });
    const d3 = insertDeployment(db, {
      timestamp: "2026-01-03T00:00:00.000Z",
      service: "traefik",
      action: "rebuild",
      status: "success",
      imageTag: "traefik:v2",
    });
    insertDeployment(db, {
      timestamp: "2026-01-04T00:00:00.000Z",
      service: "traefik",
      action: "delete", // excluded: destructive action
      status: "success",
    });
    const d5 = insertDeployment(db, {
      timestamp: "2026-01-05T00:00:00.000Z",
      service: "plex",
      action: "apply",
      status: "success",
      imageTag: "plex:latest",
    });

    runMigrations(db);

    const rows = db
      .prepare(
        "SELECT service, generation, deployment_id, image_tag, created_by_action FROM generations ORDER BY service, generation",
      )
      .all() as {
      service: string;
      generation: number;
      deployment_id: number;
      image_tag: string | null;
      created_by_action: string;
    }[];

    expect(rows).toEqual([
      {
        service: "plex",
        generation: 1,
        deployment_id: d5,
        image_tag: "plex:latest",
        created_by_action: "apply",
      },
      {
        service: "traefik",
        generation: 1,
        deployment_id: d1,
        image_tag: "traefik:v1",
        created_by_action: "deploy",
      },
      {
        service: "traefik",
        generation: 2,
        deployment_id: d3,
        image_tag: "traefik:v2",
        created_by_action: "rebuild",
      },
    ]);
  });

  it("is idempotent: re-running migrations does not duplicate generations", () => {
    insertDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "success",
    });

    runMigrations(db);
    runMigrations(db);

    const count = db.prepare("SELECT COUNT(*) as count FROM generations").get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it("does not backfill when the generations table already has rows", () => {
    // Simulate a v1 database where schema.sql already created the table
    // (db.ts executes schema.sql before runMigrations) and a generation
    // was already recorded.
    db.exec(`
      CREATE TABLE generations (
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
      INSERT INTO generations (service, generation, timestamp, created_by_action)
      VALUES ('traefik', 1, '2026-01-01T00:00:00.000Z', 'deploy');
    `);
    insertDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "success",
    });

    runMigrations(db);

    const count = db.prepare("SELECT COUNT(*) as count FROM generations").get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it("throws when the database schema is newer than the CLI supports", () => {
    updateSchemaVersion(db, CURRENT_SCHEMA_VERSION + 1);

    expect(() => runMigrations(db)).toThrow(/newer than supported version/);
  });

  it("is a no-op when the database is already up to date", () => {
    runMigrations(db);
    expect(getCurrentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    expect(() => runMigrations(db)).not.toThrow();
    expect(getCurrentSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
