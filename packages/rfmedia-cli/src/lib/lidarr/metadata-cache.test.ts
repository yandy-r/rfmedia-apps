/**
 * Tests for the persistent Lidarr metadata cache (schema v10, issue #195).
 *
 * Uses real better-sqlite3 temp-file databases (never :memory:) per the repo
 * DB-test pattern. TTL/staleness behavior is driven through the injected
 * `now` seam for determinism.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DbConnection, DbLidarrMetadataCacheEntry } from "../../types/db.js";
import { initializeDatabase } from "../db.js";
import {
  readLidarrCache,
  writeLidarrCache,
  purgeLidarrCache,
  createSqliteCacheSource,
} from "./metadata-cache.js";
import { createLidarrSearchDiscriminator } from "./search.js";

const ORIGIN = "http://lidarr.example.net:8686";
const OTHER_ORIGIN = "https://other.example.net";
const API_KEY = "super-secret-lidarr-api-key";
const LOOKUP_TERM = "Massive Attack";
const OTHER_LOOKUP_TERM = "Portishead";

const T0 = new Date("2026-07-22T10:00:00.000Z");

/** Deterministic clock seam offset from the fixed T0 epoch. */
function at(offsetMs: number): () => Date {
  return () => new Date(T0.getTime() + offsetMs);
}

function countRows(db: DbConnection): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM lidarr_metadata_cache").get() as {
    count: number;
  };
  return row.count;
}

function allRows(db: DbConnection): DbLidarrMetadataCacheEntry[] {
  return db
    .prepare("SELECT * FROM lidarr_metadata_cache ORDER BY id")
    .all() as DbLidarrMetadataCacheEntry[];
}

describe("Lidarr Metadata Cache", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-cache-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readLidarrCache", () => {
    it("returns undefined for a missing row", () => {
      const hit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(0));
      expect(hit).toBeUndefined();
    });

    it("returns a fresh hit within the TTL with age computed at read time", () => {
      const payload = [{ id: 1, artistName: "Fixture Artist" }];
      writeLidarrCache(db, ORIGIN, "artists", "", payload, undefined, at(0));

      const hit = readLidarrCache<typeof payload>(
        db,
        ORIGIN,
        "artists",
        "",
        900_000,
        86_400_000,
        at(100_000),
      );

      expect(hit).toBeDefined();
      expect(hit?.value).toEqual(payload);
      expect(hit?.fetchedAt).toBe(T0.toISOString());
      expect(hit?.ageSeconds).toBe(100);
      expect(hit?.fresh).toBe(true);
    });

    it("treats age exactly at the TTL boundary as fresh", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { ok: true }, undefined, at(0));

      const hit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(900_000));

      expect(hit?.fresh).toBe(true);
    });

    it("returns a stale (fresh: false) hit past the TTL but within the stale ceiling", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { ok: true }, undefined, at(0));

      const hit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(3_600_000));

      expect(hit).toBeDefined();
      expect(hit?.fresh).toBe(false);
      expect(hit?.ageSeconds).toBe(3600);
    });

    it("returns undefined past staleMaxAgeMs", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { ok: true }, undefined, at(0));

      const hit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(86_400_001));

      expect(hit).toBeUndefined();
    });

    it("still serves an entry exactly at the stale ceiling boundary", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { ok: true }, undefined, at(0));

      const hit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(86_400_000));

      expect(hit).toBeDefined();
      expect(hit?.fresh).toBe(false);
    });

    it("clamps a future fetched_at to age zero (fresh)", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { ok: true }, undefined, at(60_000));

      const hit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(0));

      expect(hit?.ageSeconds).toBe(0);
      expect(hit?.fresh).toBe(true);
    });

    it("computes staleness from the policy supplied at read time, not at write time", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { ok: true }, undefined, at(0));

      const generous = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(60_000));
      const strict = readLidarrCache(db, ORIGIN, "artists", "", 30_000, 86_400_000, at(60_000));

      expect(generous?.fresh).toBe(true);
      expect(strict?.fresh).toBe(false);
    });

    it("throws on a malformed payload_json row", () => {
      db.prepare(
        `INSERT INTO lidarr_metadata_cache (origin, category, discriminator, payload_json, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ORIGIN, "artists", "", "{not-json", T0.toISOString());

      expect(() => readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(0))).toThrow(
        /Malformed payload_json/,
      );
    });

    it("throws on a malformed fetched_at row", () => {
      db.prepare(
        `INSERT INTO lidarr_metadata_cache (origin, category, discriminator, payload_json, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ORIGIN, "artists", "", "{}", "not-a-timestamp");

      expect(() => readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, at(0))).toThrow(
        /Malformed fetched_at/,
      );
    });
  });

  describe("writeLidarrCache", () => {
    it("upserts via ON CONFLICT DO UPDATE, overwriting payload and timestamp", () => {
      writeLidarrCache(db, ORIGIN, "system-status", "", { version: "1.0.0" }, undefined, at(0));
      writeLidarrCache(
        db,
        ORIGIN,
        "system-status",
        "",
        { version: "2.0.0" },
        undefined,
        at(60_000),
      );

      expect(countRows(db)).toBe(1);
      const hit = readLidarrCache<{ version: string }>(
        db,
        ORIGIN,
        "system-status",
        "",
        900_000,
        86_400_000,
        at(60_000),
      );
      expect(hit?.value).toEqual({ version: "2.0.0" });
      expect(hit?.fetchedAt).toBe(new Date(T0.getTime() + 60_000).toISOString());
      expect(hit?.ageSeconds).toBe(0);
    });

    it("keeps distinct origins, categories, and discriminators as separate rows", () => {
      writeLidarrCache(db, ORIGIN, "artists", "", { key: "a" }, undefined, at(0));
      writeLidarrCache(db, ORIGIN, "system-status", "", { key: "b" }, undefined, at(0));
      writeLidarrCache(db, ORIGIN, "artists", "page-2", { key: "c" }, undefined, at(0));
      writeLidarrCache(db, OTHER_ORIGIN, "artists", "", { key: "d" }, undefined, at(0));

      expect(countRows(db)).toBe(4);
      const hit = readLidarrCache<{ key: string }>(
        db,
        ORIGIN,
        "artists",
        "page-2",
        900_000,
        86_400_000,
        at(0),
      );
      expect(hit?.value).toEqual({ key: "c" });
    });

    it("throws a TypeError for values that are not JSON-serializable", () => {
      expect(() =>
        writeLidarrCache(db, ORIGIN, "artists", "", undefined, undefined, at(0)),
      ).toThrow(TypeError);
      expect(countRows(db)).toBe(0);
    });

    it("opportunistically prunes rows past staleMaxAgeMs when provided", () => {
      writeLidarrCache(db, ORIGIN, "artists", "old", { key: "old" }, undefined, at(0));

      // 25h later with a 24h stale ceiling: the old row is expired and pruned.
      writeLidarrCache(
        db,
        ORIGIN,
        "artists",
        "new",
        { key: "new" },
        86_400_000,
        at(25 * 3_600_000),
      );

      const rows = allRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.discriminator).toBe("new");
    });

    it("keeps rows within the stale ceiling during the opportunistic prune", () => {
      writeLidarrCache(db, ORIGIN, "artists", "recent", { key: "recent" }, undefined, at(0));

      // 23h later with a 24h stale ceiling: the earlier row is still servable.
      writeLidarrCache(
        db,
        ORIGIN,
        "artists",
        "new",
        { key: "new" },
        86_400_000,
        at(23 * 3_600_000),
      );

      expect(countRows(db)).toBe(2);
    });

    it("does not prune when staleMaxAgeMs is omitted", () => {
      writeLidarrCache(db, ORIGIN, "artists", "ancient", { key: "ancient" }, undefined, at(0));

      writeLidarrCache(
        db,
        ORIGIN,
        "artists",
        "new",
        { key: "new" },
        undefined,
        at(365 * 24 * 3_600_000),
      );

      expect(countRows(db)).toBe(2);
    });
  });

  describe("lookup category", () => {
    it("isolates rows by category, origin, mode, term, and projection version", () => {
      const search = createLidarrSearchDiscriminator("search", LOOKUP_TERM);
      const artist = createLidarrSearchDiscriminator("artist", LOOKUP_TERM);
      const album = createLidarrSearchDiscriminator("album", LOOKUP_TERM);
      const otherTerm = createLidarrSearchDiscriminator("search", OTHER_LOOKUP_TERM);
      const nextVersion = search.replace(/^v1:/u, "v2:");
      const rows = [
        { origin: ORIGIN, category: "lookup", discriminator: search, value: 1 },
        { origin: ORIGIN, category: "lookup", discriminator: artist, value: 2 },
        { origin: ORIGIN, category: "lookup", discriminator: album, value: 3 },
        { origin: ORIGIN, category: "lookup", discriminator: otherTerm, value: 4 },
        { origin: OTHER_ORIGIN, category: "lookup", discriminator: search, value: 5 },
        { origin: ORIGIN, category: "lookup", discriminator: nextVersion, value: 6 },
        { origin: ORIGIN, category: "artists", discriminator: search, value: 7 },
      ] as const;

      for (const row of rows) {
        writeLidarrCache(
          db,
          row.origin,
          row.category,
          row.discriminator,
          { value: row.value },
          undefined,
          at(0),
        );
      }

      expect(countRows(db)).toBe(rows.length);
      for (const row of rows) {
        expect(
          readLidarrCache<{ value: number }>(
            db,
            row.origin,
            row.category,
            row.discriminator,
            900_000,
            86_400_000,
            at(0),
          )?.value,
        ).toEqual({ value: row.value });
      }
    });

    it("stores and retrieves a complete empty lookup projection", () => {
      const discriminator = createLidarrSearchDiscriminator("album", "No Such Album");

      writeLidarrCache(db, ORIGIN, "lookup", discriminator, [], undefined, at(0));

      expect(
        readLidarrCache<readonly unknown[]>(
          db,
          ORIGIN,
          "lookup",
          discriminator,
          900_000,
          86_400_000,
          at(0),
        )?.value,
      ).toEqual([]);
      expect(allRows(db)[0]?.payload_json).toBe("[]");
    });

    it("applies lookup TTL and stale-ceiling boundaries at read time", () => {
      const discriminator = createLidarrSearchDiscriminator("artist", LOOKUP_TERM);
      writeLidarrCache(db, ORIGIN, "lookup", discriminator, [{ rank: 1 }], undefined, at(0));

      const stale = readLidarrCache(
        db,
        ORIGIN,
        "lookup",
        discriminator,
        900_000,
        86_400_000,
        at(900_001),
      );
      const atCeiling = readLidarrCache(
        db,
        ORIGIN,
        "lookup",
        discriminator,
        900_000,
        86_400_000,
        at(86_400_000),
      );
      const expired = readLidarrCache(
        db,
        ORIGIN,
        "lookup",
        discriminator,
        900_000,
        86_400_000,
        at(86_400_001),
      );

      expect(stale?.fresh).toBe(false);
      expect(atCeiling).toBeDefined();
      expect(expired).toBeUndefined();
    });

    it("reports corrupted lookup payloads without exposing query text or credentials", () => {
      const discriminator = createLidarrSearchDiscriminator("search", LOOKUP_TERM);
      db.prepare(
        `INSERT INTO lidarr_metadata_cache (origin, category, discriminator, payload_json, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ORIGIN, "lookup", discriminator, "{not-json", T0.toISOString());

      expect(() =>
        readLidarrCache(db, ORIGIN, "lookup", discriminator, 900_000, 86_400_000, at(0)),
      ).toThrow(/Malformed payload_json/u);
      try {
        readLidarrCache(db, ORIGIN, "lookup", discriminator, 900_000, 86_400_000, at(0));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(LOOKUP_TERM);
        expect(message).not.toContain(API_KEY);
      }
    });

    it("prunes expired lookup rows while retaining rows within the stale ceiling", () => {
      const expired = createLidarrSearchDiscriminator("search", "Expired");
      const recent = createLidarrSearchDiscriminator("artist", "Recent");
      const current = createLidarrSearchDiscriminator("album", "Current");
      writeLidarrCache(db, ORIGIN, "lookup", expired, [], undefined, at(0));
      writeLidarrCache(db, ORIGIN, "lookup", recent, [], undefined, at(2 * 3_600_000));

      writeLidarrCache(db, ORIGIN, "lookup", current, [], 86_400_000, at(25 * 3_600_000));

      expect(allRows(db).map((row) => row.discriminator)).toEqual([recent, current]);
    });

    it("stores only hashed query identity and projection data", () => {
      const discriminator = createLidarrSearchDiscriminator("search", LOOKUP_TERM);
      const projection = [
        {
          kind: "artist",
          foreignId: "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c",
          name: "Unrelated fixture",
          rank: 1,
        },
      ];

      writeLidarrCache(db, ORIGIN, "lookup", discriminator, projection, undefined, at(0));

      const dump = JSON.stringify(allRows(db));
      expect(discriminator).toMatch(/^v1:search:[0-9a-f]{64}$/u);
      expect(dump).not.toContain(LOOKUP_TERM);
      expect(dump).not.toContain(API_KEY);
      expect(dump).toContain(discriminator);
      expect(dump).toContain("Unrelated fixture");
    });
  });

  describe("purgeLidarrCache", () => {
    beforeEach(() => {
      writeLidarrCache(db, ORIGIN, "artists", "", { key: "a" }, undefined, at(0));
      writeLidarrCache(db, ORIGIN, "system-status", "", { key: "b" }, undefined, at(0));
      writeLidarrCache(db, OTHER_ORIGIN, "artists", "", { key: "c" }, undefined, at(0));
    });

    it("purges every category for one origin without touching other origins", () => {
      const removed = purgeLidarrCache(db, ORIGIN);

      expect(removed).toBe(2);
      const rows = allRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origin).toBe(OTHER_ORIGIN);
    });

    it("purges only the requested category when one is given", () => {
      const removed = purgeLidarrCache(db, ORIGIN, "artists");

      expect(removed).toBe(1);
      expect(countRows(db)).toBe(2);
      expect(
        readLidarrCache(db, ORIGIN, "system-status", "", 900_000, 86_400_000, at(0)),
      ).toBeDefined();
    });

    it("returns 0 when nothing matches", () => {
      expect(purgeLidarrCache(db, "http://unknown.example.net", "artists")).toBe(0);
    });
  });

  describe("key hygiene", () => {
    it("scopes rows by credential-free origin and never stores the API key", () => {
      writeLidarrCache(
        db,
        ORIGIN,
        "artists",
        "",
        [{ id: 7, artistName: "Fixture" }],
        undefined,
        at(0),
      );

      const dump = JSON.stringify(allRows(db));
      expect(dump).toContain(ORIGIN);
      expect(dump).not.toContain(API_KEY);
    });
  });

  describe("createSqliteCacheSource", () => {
    it("exposes the sqlite-cache id on a frozen source", () => {
      const source = createSqliteCacheSource(async () => db, {
        ttlMs: 900_000,
        staleMaxAgeMs: 86_400_000,
      });

      expect(source.id).toBe("sqlite-cache");
      expect(Object.isFrozen(source)).toBe(true);
    });

    it("opens the database lazily, only on lookup", async () => {
      const openDb = vi.fn(async () => db);
      const source = createSqliteCacheSource(openDb, {
        ttlMs: 900_000,
        staleMaxAgeMs: 86_400_000,
      });

      expect(openDb).not.toHaveBeenCalled();
      await source.lookup(ORIGIN, "artists", "");
      expect(openDb).toHaveBeenCalledTimes(1);
    });

    it("returns a hit within the stale ceiling using its constructed policy", async () => {
      const payload = { version: "2.13.3.4711" };
      // Backdate the write one hour so the real-clock lookup sees a stale row.
      writeLidarrCache(
        db,
        ORIGIN,
        "system-status",
        "",
        payload,
        undefined,
        () => new Date(Date.now() - 3_600_000),
      );

      const source = createSqliteCacheSource(async () => db, {
        ttlMs: 900_000,
        staleMaxAgeMs: 86_400_000,
      });
      const hit = await source.lookup<typeof payload>(ORIGIN, "system-status", "");

      expect(hit).toBeDefined();
      expect(hit?.value).toEqual(payload);
      expect(hit?.fresh).toBe(false);
      expect(hit?.ageSeconds).toBeGreaterThanOrEqual(3599);
      expect(hit?.ageSeconds).toBeLessThanOrEqual(3610);
    });

    it("returns undefined for entries past its stale ceiling", async () => {
      writeLidarrCache(
        db,
        ORIGIN,
        "system-status",
        "",
        { version: "old" },
        undefined,
        () => new Date(Date.now() - 3_600_000),
      );

      const source = createSqliteCacheSource(async () => db, {
        ttlMs: 900_000,
        staleMaxAgeMs: 1_000,
      });

      await expect(source.lookup(ORIGIN, "system-status", "")).resolves.toBeUndefined();
    });

    it("returns undefined for a miss", async () => {
      const source = createSqliteCacheSource(async () => db, {
        ttlMs: 900_000,
        staleMaxAgeMs: 86_400_000,
      });

      await expect(source.lookup(ORIGIN, "artists", "missing")).resolves.toBeUndefined();
    });
  });
});
