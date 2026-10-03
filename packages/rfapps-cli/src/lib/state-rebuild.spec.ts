/**
 * Tests for the state-database reconstruction primitives.
 *
 * Uses REAL better-sqlite3 throughout: mocking SQLite here would prove nothing
 * about the SQL semantics these primitives depend on (legacy column sets,
 * constraint violations, id preservation). In-memory databases cover the pure
 * SQL cases; temp files cover the cases that need a real path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("@rfmedia/common", () => ({
  logDebug: vi.fn(),
}));

import {
  backupStateDatabase,
  buildReplacementDatabasePath,
  carryOverState,
  readLatestRecordedImageIds,
  swapStateDatabase,
} from "./state-rebuild.js";
import { GENERATION_ACTIONS } from "./state-storage.js";
import { closeDatabase, initializeDatabase } from "./db.js";
import type { DbConnection } from "./db.js";

const CURRENT_SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");

/**
 * Schema as it existed at version 1: no generations table, and deployments
 * without the immutable identity columns added by migration v3.
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
 * A v3-shaped source whose generations table lacks UNIQUE(service, generation),
 * so a duplicate pair can exist in the input the way a damaged file would.
 */
const UNCONSTRAINED_SCHEMA = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    image_tag TEXT,
    image_id TEXT,
    image_digest TEXT,
    config_snapshot TEXT,
    status TEXT NOT NULL,
    plan_id TEXT,
    error_message TEXT
  );

  CREATE TABLE generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    generation INTEGER NOT NULL,
    deployment_id INTEGER,
    timestamp TEXT NOT NULL,
    image_tag TEXT,
    image_id TEXT,
    image_digest TEXT,
    config_snapshot TEXT,
    created_by_action TEXT NOT NULL
  );

  INSERT INTO metadata (key, value) VALUES ('schema_version', '3');
`;

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rfapps-state-rebuild-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createMemoryTarget(): DbConnection {
  const target = new Database(":memory:");
  target.pragma("foreign_keys = ON");
  target.exec(CURRENT_SCHEMA);
  return target;
}

function insertLegacyDeployment(
  db: DbConnection,
  entry: { id: number; timestamp: string; service: string; action: string; status: string },
): void {
  db.prepare(
    `INSERT INTO deployments (id, timestamp, service, action, image_tag, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.timestamp,
    entry.service,
    entry.action,
    `${entry.service}:latest`,
    entry.status,
  );
}

afterEach(async () => {
  vi.clearAllMocks();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("carryOverState", () => {
  it("carries a v1-shaped source and re-derives generations with the current action vocabulary", () => {
    const source = new Database(":memory:");
    source.exec(V1_SCHEMA);
    insertLegacyDeployment(source, {
      id: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "success",
    });
    insertLegacyDeployment(source, {
      id: 2,
      timestamp: "2026-01-02T00:00:00.000Z",
      service: "traefik",
      action: "update",
      status: "success",
    });
    insertLegacyDeployment(source, {
      id: 3,
      timestamp: "2026-01-03T00:00:00.000Z",
      service: "plex",
      action: "import",
      status: "success",
    });
    insertLegacyDeployment(source, {
      id: 4,
      timestamp: "2026-01-04T00:00:00.000Z",
      service: "plex",
      action: "delete",
      status: "success",
    });

    const target = createMemoryTarget();

    const counts = carryOverState(source, target, GENERATION_ACTIONS);

    expect(counts.deploymentsCarried).toBe(4);
    expect(counts.deploymentsDiscarded).toBe(0);
    expect(counts.generationsCarried).toBe(0);
    expect(counts.generationsDerived).toBeGreaterThan(0);

    // `update` and `import` are in the current GENERATION_ACTIONS set but absent
    // from the v2 migration's frozen literal; `delete` is in neither.
    expect(
      target
        .prepare(
          "SELECT service, generation, created_by_action FROM generations ORDER BY service, generation",
        )
        .all(),
    ).toEqual([
      { service: "plex", generation: 1, created_by_action: "import" },
      { service: "traefik", generation: 1, created_by_action: "deploy" },
      { service: "traefik", generation: 2, created_by_action: "update" },
    ]);

    source.close();
    target.close();
  });

  it("preserves deployment ids and generation numbers and normalizes legacy timestamps", async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "source.db");
    const targetPath = join(directory, "target.db");

    const seed = new Database(sourcePath);
    // The seed intentionally records a dangling deployment_id, which is exactly
    // the damage carry-over has to repair.
    seed.pragma("foreign_keys = OFF");
    seed.exec(CURRENT_SCHEMA);
    const seedDeployment = seed.prepare(
      `INSERT INTO deployments (id, timestamp, service, action, image_tag, image_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'success')`,
    );
    seedDeployment.run(
      5,
      "2026-01-01T00:00:00.000Z",
      "traefik",
      "deploy",
      "traefik:v3",
      "sha256:a",
    );
    // Written by SQLite's DEFAULT (datetime('now')), which is UTC and not ISO 8601.
    seedDeployment.run(9, "2026-01-02 03:04:05", "traefik", "rebuild", "traefik:v4", "sha256:b");
    seedDeployment.run(40, "2026-01-03T00:00:00.000Z", "plex", "deploy", "plex:latest", "sha256:c");
    const seedGeneration = seed.prepare(
      `INSERT INTO generations (service, generation, deployment_id, timestamp, image_tag, image_id, created_by_action)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    seedGeneration.run(
      "traefik",
      3,
      5,
      "2026-01-01T00:00:00.000Z",
      "traefik:v3",
      "sha256:a",
      "deploy",
    );
    seedGeneration.run(
      "traefik",
      7,
      9,
      "2026-01-02T03:04:05.000Z",
      "traefik:v4",
      "sha256:b",
      "rebuild",
    );
    seedGeneration.run(
      "plex",
      2,
      404,
      "2026-01-03T00:00:00.000Z",
      "plex:latest",
      "sha256:c",
      "deploy",
    );
    seed.close();

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const target = await initializeDatabase(targetPath);
    try {
      const counts = carryOverState(source, target, GENERATION_ACTIONS);

      expect(counts.deploymentsCarried).toBe(3);
      expect(counts.generationsCarried).toBe(3);
      expect(counts.generationsDerived).toBe(0);
      expect(counts.deploymentsDiscarded).toBe(0);
      expect(counts.generationsDiscarded).toBe(0);

      expect(target.prepare("SELECT id FROM deployments ORDER BY id").all()).toEqual([
        { id: 5 },
        { id: 9 },
        { id: 40 },
      ]);

      // Generation numbers survive verbatim; an unresolvable deployment_id
      // becomes NULL so the FK stays valid under foreign_keys = ON.
      expect(
        target
          .prepare(
            "SELECT service, generation, deployment_id FROM generations ORDER BY service, generation",
          )
          .all(),
      ).toEqual([
        { service: "plex", generation: 2, deployment_id: null },
        { service: "traefik", generation: 3, deployment_id: 5 },
        { service: "traefik", generation: 7, deployment_id: 9 },
      ]);
      expect(target.pragma("foreign_key_check")).toEqual([]);

      expect(target.prepare("SELECT timestamp FROM deployments WHERE id = 9").get()).toEqual({
        timestamp: "2026-01-02T03:04:05.000Z",
      });
    } finally {
      source.close();
      closeDatabase(target);
    }
  });

  it("discards and counts a duplicate (service, generation) row without aborting", () => {
    const source = new Database(":memory:");
    source.exec(UNCONSTRAINED_SCHEMA);
    insertLegacyDeployment(source, {
      id: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "traefik",
      action: "deploy",
      status: "success",
    });
    insertLegacyDeployment(source, {
      id: 2,
      timestamp: "2026-01-02T00:00:00.000Z",
      service: "plex",
      action: "deploy",
      status: "success",
    });
    const seedGeneration = source.prepare(
      `INSERT INTO generations (service, generation, deployment_id, timestamp, created_by_action)
       VALUES (?, ?, ?, ?, 'deploy')`,
    );
    seedGeneration.run("traefik", 1, 1, "2026-01-01T00:00:00.000Z");
    seedGeneration.run("traefik", 1, 1, "2026-01-01T00:00:01.000Z");
    seedGeneration.run("plex", 1, 2, "2026-01-02T00:00:00.000Z");

    const target = createMemoryTarget();

    const counts = carryOverState(source, target, GENERATION_ACTIONS);

    expect(counts.generationsCarried).toBe(2);
    expect(counts.generationsDiscarded).toBe(1);
    // The transaction was not rolled back: everything else still landed.
    expect(counts.deploymentsCarried).toBe(2);
    expect(target.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({ count: 2 });
    expect(
      target.prepare("SELECT service, generation FROM generations ORDER BY service").all(),
    ).toEqual([
      { service: "plex", generation: 1 },
      { service: "traefik", generation: 1 },
    ]);

    source.close();
    target.close();
  });
});

describe("backupStateDatabase and swapStateDatabase", () => {
  it("falls back to a raw byte copy for an unparseable database and swaps atomically", async () => {
    const directory = await createTemporaryDirectory();
    const dbPath = join(directory, "state.db");
    await writeFile(dbPath, "not a database");
    // `-journal` is the sidecar this project actually produces: nothing sets
    // journal_mode, so SQLite stays in its default `delete` mode.
    await writeFile(`${dbPath}-journal`, "hot rollback journal bytes");
    await writeFile(`${dbPath}-wal`, "stale wal bytes");
    await writeFile(`${dbPath}-shm`, "stale shm bytes");
    const destination = join(directory, "backups", "state-2026-07-24T18-15-00-000Z.db");

    const backup = await backupStateDatabase(dbPath, destination);

    expect(backup.method).toBe("raw-copy");
    expect(backup.path).toBe(destination);
    expect(backup.sidecars).toEqual([
      `${destination}-journal`,
      `${destination}-wal`,
      `${destination}-shm`,
    ]);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(await readFile(destination, "utf-8")).toBe("not a database");
    expect(backup.bytes).toBe("not a database".length);
    // A crashed database is worthless without its rollback journal.
    expect(await readFile(`${destination}-journal`, "utf-8")).toBe("hot rollback journal bytes");
    expect(await readFile(`${destination}-wal`, "utf-8")).toBe("stale wal bytes");

    const targetPath = join(directory, "swap-target.db");
    const tempPath = join(directory, ".swap-target.db.tmp");
    await writeFile(targetPath, "old contents");
    await writeFile(`${targetPath}-journal`, "hot rollback journal bytes");
    await writeFile(`${targetPath}-wal`, "stale wal bytes");
    await writeFile(`${targetPath}-shm`, "stale shm bytes");
    await writeFile(tempPath, "rebuilt contents");

    await swapStateDatabase(tempPath, targetPath);

    expect(await readFile(targetPath, "utf-8")).toBe("rebuilt contents");
    expect(existsSync(tempPath)).toBe(false);
    // A surviving journal would be replayed onto the fresh database.
    expect(existsSync(`${targetPath}-journal`)).toBe(false);
    expect(existsSync(`${targetPath}-wal`)).toBe(false);
    expect(existsSync(`${targetPath}-shm`)).toBe(false);
  });
});

describe("buildReplacementDatabasePath", () => {
  it("reserves a distinct sibling path on every call", () => {
    const targetPath = join(tmpdir(), "rfapps-state-rebuild-path", "state.db");

    const first = buildReplacementDatabasePath(targetPath);
    const second = buildReplacementDatabasePath(targetPath);

    // Same directory, so rename() stays atomic; different names, so a leftover
    // replacement from a crashed run with a recycled pid is never adopted.
    expect(dirname(first)).toBe(dirname(targetPath));
    expect(dirname(second)).toBe(dirname(targetPath));
    expect(first).not.toBe(second);
  });
});

describe("readLatestRecordedImageIds", () => {
  it("merges generations with deployments instead of returning on the first hit", () => {
    const source = new Database(":memory:");
    source.exec(CURRENT_SCHEMA);
    const seedDeployment = source.prepare(
      `INSERT INTO deployments (id, timestamp, service, action, image_tag, image_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'success')`,
    );
    seedDeployment.run(
      1,
      "2026-01-01T00:00:00.000Z",
      "traefik",
      "deploy",
      "traefik:v3",
      "sha256:a",
    );
    // Only `deployments` knows about plex: its generation row is missing, which
    // is exactly the damage this command repairs.
    seedDeployment.run(2, "2026-01-02T00:00:00.000Z", "plex", "deploy", "plex:latest", "sha256:c");
    source
      .prepare(
        `INSERT INTO generations (service, generation, deployment_id, timestamp, image_tag, image_id, created_by_action)
         VALUES ('traefik', 1, 1, '2026-01-01T00:00:00.000Z', 'traefik:v3', 'sha256:a', 'deploy')`,
      )
      .run();

    const recorded = readLatestRecordedImageIds(source);

    expect([...recorded.entries()].sort()).toEqual([
      ["plex", "sha256:c"],
      ["traefik", "sha256:a"],
    ]);

    source.close();
  });
});
