/**
 * Tests for generation snapshot operations.
 *
 * Uses a real in-memory SQLite database with the actual schema so the
 * per-service numbering, ordering, and time-based lookups are verified
 * against real SQL behavior rather than mocks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

vi.mock("@rfmedia/common", () => ({
  logDebug: vi.fn(),
}));

import {
  createGeneration,
  getGenerations,
  findGenerationByNumber,
  findLatestGenerationByImageId,
  findGenerationAtTime,
  getGenerationCount,
} from "./generations.js";
import { runMigrations } from "./migrations.js";
import type { DbConnection } from "./db.js";
import type { GenerationInput } from "../types/state.js";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");

function createTestDb(): DbConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}

function makeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    service: "traefik",
    timestamp: "2026-01-01T00:00:00.000Z",
    imageTag: "traefik:v3.0",
    configSnapshot: JSON.stringify({ image: "traefik:v3.0" }),
    createdByAction: "deploy",
    ...overrides,
  };
}

describe("generations", () => {
  let db: DbConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
  });

  describe("createGeneration", () => {
    it("assigns per-service generation numbers starting at 1", () => {
      expect(createGeneration(db, makeInput())).toBe(1);
      expect(createGeneration(db, makeInput({ timestamp: "2026-01-02T00:00:00.000Z" }))).toBe(2);
      expect(createGeneration(db, makeInput({ service: "plex" }))).toBe(1);
      expect(createGeneration(db, makeInput({ timestamp: "2026-01-03T00:00:00.000Z" }))).toBe(3);
    });

    it("stores nullable fields as null and reads them back as undefined", () => {
      createGeneration(db, {
        service: "plex",
        timestamp: "2026-01-01T00:00:00.000Z",
        createdByAction: "rebuild",
      });

      const entry = findGenerationByNumber(db, "plex", 1);
      expect(entry).toEqual({
        id: 1,
        service: "plex",
        generation: 1,
        deploymentId: undefined,
        timestamp: "2026-01-01T00:00:00.000Z",
        imageTag: undefined,
        imageId: undefined,
        imageDigest: undefined,
        configSnapshot: undefined,
        createdByAction: "rebuild",
      });
    });

    it("persists immutable image identity for exact-restore-eligible update generations", () => {
      const imageId = `sha256:${"1".repeat(64)}`;
      const imageDigest = `traefik@sha256:${"2".repeat(64)}`;

      createGeneration(
        db,
        makeInput({
          imageId,
          imageDigest,
          createdByAction: "update",
        }),
      );

      expect(findGenerationByNumber(db, "traefik", 1)).toMatchObject({
        imageId,
        imageDigest,
        createdByAction: "update",
      });
    });

    it("links generations to their originating deployment", () => {
      const deployment = db
        .prepare("INSERT INTO deployments (timestamp, service, action, status) VALUES (?, ?, ?, ?)")
        .run("2026-01-01T00:00:00.000Z", "traefik", "deploy", "success");
      const deploymentId = Number(deployment.lastInsertRowid);

      createGeneration(db, makeInput({ deploymentId }));

      const entry = findGenerationByNumber(db, "traefik", 1);
      expect(entry?.deploymentId).toBe(deploymentId);
    });
  });

  describe("getGenerations", () => {
    beforeEach(() => {
      createGeneration(db, makeInput({ timestamp: "2026-01-01T00:00:00.000Z" }));
      createGeneration(db, makeInput({ timestamp: "2026-01-02T00:00:00.000Z" }));
      createGeneration(db, makeInput({ service: "plex", timestamp: "2026-01-03T00:00:00.000Z" }));
    });

    it("lists generations for a service newest first", () => {
      const entries = getGenerations(db, { service: "traefik" });
      expect(entries.map((e) => e.generation)).toEqual([2, 1]);
      expect(entries.every((e) => e.service === "traefik")).toBe(true);
    });

    it("lists generations across services by timestamp descending", () => {
      const entries = getGenerations(db, {});
      expect(entries.map((e) => e.service)).toEqual(["plex", "traefik", "traefik"]);
    });

    it("applies the limit option", () => {
      const entries = getGenerations(db, { service: "traefik", limit: 1 });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.generation).toBe(2);
    });
  });

  describe("findGenerationByNumber", () => {
    it("returns undefined for missing generations", () => {
      expect(findGenerationByNumber(db, "traefik", 1)).toBeUndefined();

      createGeneration(db, makeInput());
      expect(findGenerationByNumber(db, "traefik", 99)).toBeUndefined();
      expect(findGenerationByNumber(db, "plex", 1)).toBeUndefined();
    });
  });

  describe("findLatestGenerationByImageId", () => {
    it("returns only the newest exact service and image identity match", () => {
      const imageId = `sha256:${"a".repeat(64)}`;
      createGeneration(db, makeInput({ imageId, imageTag: "traefik:v1" }));
      createGeneration(
        db,
        makeInput({ imageId, imageTag: "traefik:v2", timestamp: "2026-01-02T00:00:00.000Z" }),
      );
      createGeneration(db, makeInput({ service: "plex", imageId, imageTag: "plex:v1" }));
      createGeneration(
        db,
        makeInput({ imageId: `sha256:${"b".repeat(64)}`, imageTag: "traefik:other" }),
      );

      expect(findLatestGenerationByImageId(db, "traefik", imageId)).toMatchObject({
        service: "traefik",
        generation: 2,
        imageTag: "traefik:v2",
      });
      expect(findLatestGenerationByImageId(db, "missing", imageId)).toBeUndefined();
    });

    it("uses the composite exact-recovery lookup index", () => {
      const detail = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT id FROM generations
           WHERE service = ? AND image_id = ?
           ORDER BY generation DESC LIMIT 1`,
        )
        .all("traefik", `sha256:${"a".repeat(64)}`) as { detail: string }[];

      expect(detail.map((row) => row.detail).join(" ")).toContain(
        "idx_generations_service_image_id_generation",
      );
    });
  });

  describe("findGenerationAtTime", () => {
    beforeEach(() => {
      createGeneration(
        db,
        makeInput({ timestamp: "2026-01-01T00:00:00.000Z", imageTag: "traefik:v1" }),
      );
      createGeneration(
        db,
        makeInput({ timestamp: "2026-02-01T00:00:00.000Z", imageTag: "traefik:v2" }),
      );
      createGeneration(
        db,
        makeInput({ timestamp: "2026-03-01T00:00:00.000Z", imageTag: "traefik:v3" }),
      );
    });

    it("returns the generation active at the given time", () => {
      const entry = findGenerationAtTime(db, "traefik", "2026-02-15T00:00:00.000Z");
      expect(entry?.generation).toBe(2);
      expect(entry?.imageTag).toBe("traefik:v2");
    });

    it("returns the generation created exactly at the given time", () => {
      const entry = findGenerationAtTime(db, "traefik", "2026-02-01T00:00:00.000Z");
      expect(entry?.generation).toBe(2);
    });

    it("returns the newest generation for a time in the future", () => {
      const entry = findGenerationAtTime(db, "traefik", "2027-01-01T00:00:00.000Z");
      expect(entry?.generation).toBe(3);
    });

    it("returns undefined when no generation existed at that time", () => {
      expect(findGenerationAtTime(db, "traefik", "2025-12-31T00:00:00.000Z")).toBeUndefined();
      expect(findGenerationAtTime(db, "plex", "2026-06-01T00:00:00.000Z")).toBeUndefined();
    });

    it("selects by timestamp order even when a later-inserted generation has an older timestamp", () => {
      // Insert a generation with an older timestamp (2026-01-15) after the three
      // beforeEach generations already exist. Its generation number will be 4 (highest),
      // but its timestamp places it between gen 1 and gen 2.
      createGeneration(
        db,
        makeInput({ timestamp: "2026-01-15T00:00:00.000Z", imageTag: "traefik:v1-backfill" }),
      );

      // Query at 2026-02-15: the newest snapshot by timestamp at or before that point
      // is the 2026-02-01 one (gen 2, traefik:v2), not the backfilled gen 4.
      const entry = findGenerationAtTime(db, "traefik", "2026-02-15T00:00:00.000Z");
      expect(entry?.imageTag).toBe("traefik:v2");
      expect(entry?.timestamp).toBe("2026-02-01T00:00:00.000Z");
    });
  });

  describe("getGenerationCount", () => {
    it("counts generations with and without a service filter", () => {
      expect(getGenerationCount(db, {})).toBe(0);

      createGeneration(db, makeInput());
      createGeneration(db, makeInput({ timestamp: "2026-01-02T00:00:00.000Z" }));
      createGeneration(db, makeInput({ service: "plex" }));

      expect(getGenerationCount(db, {})).toBe(3);
      expect(getGenerationCount(db, { service: "traefik" })).toBe(2);
      expect(getGenerationCount(db, { service: "missing" })).toBe(0);
    });
  });
});
