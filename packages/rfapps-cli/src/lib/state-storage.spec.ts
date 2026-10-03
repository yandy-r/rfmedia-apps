/**
 * Tests for state storage operations.
 *
 * Uses a real in-memory SQLite database with the actual schema so deployment
 * recording, status updates, and the automatic generation snapshot hook are
 * verified against real SQL behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

vi.mock("@rfmedia/common", () => ({
  logDebug: vi.fn(),
}));

import {
  getDeployment,
  getLatestDeployment,
  maskSensitiveEnvVars,
  recordDeployment,
  recordDeployments,
  updateDeploymentStatus,
} from "./state-storage.js";
import { getGenerations } from "./generations.js";
import type { DbConnection } from "./db.js";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");

function createTestDb(): DbConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

describe("state storage", () => {
  let db: DbConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
  });

  it("masks sensitive environment variables by key pattern", () => {
    expect(
      maskSensitiveEnvVars({
        PLEX_URL: "https://plex.example.com",
        PLEX_TOKEN: "secret",
        DB_PASSWORD: "password",
        API_KEY: "key",
        KEYBOARD_LAYOUT: "us",
        AWS_CREDENTIALS: "creds",
        PRIVATE_TOKEN: "private",
      }),
    ).toEqual({
      PLEX_URL: "https://plex.example.com",
      PLEX_TOKEN: "***MASKED***",
      DB_PASSWORD: "***MASKED***",
      API_KEY: "***MASKED***",
      KEYBOARD_LAYOUT: "us",
      AWS_CREDENTIALS: "***MASKED***",
      PRIVATE_TOKEN: "***MASKED***",
    });
  });

  it("records a deployment with nullable optional fields", () => {
    const id = recordDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "plex",
      action: "deploy",
      status: "success",
    });

    expect(id).toBe(1);
    expect(getDeployment(db, id)).toEqual({
      id: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "plex",
      action: "deploy",
      imageTag: undefined,
      imageId: undefined,
      imageDigest: undefined,
      configSnapshot: undefined,
      status: "success",
      planId: undefined,
      errorMessage: undefined,
    });
  });

  it("records immutable identity for successful update actions", () => {
    const id = recordDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "plex",
      action: "update",
      imageTag: "plex:latest",
      imageId: "sha256:local-image-id",
      imageDigest: "plex@sha256:repository-digest",
      status: "success",
      planId: "update-plan-1",
    });

    expect(getDeployment(db, id)).toMatchObject({
      action: "update",
      imageId: "sha256:local-image-id",
      imageDigest: "plex@sha256:repository-digest",
    });
    expect(getGenerations(db, { service: "plex" })).toMatchObject([
      {
        deploymentId: id,
        createdByAction: "update",
      },
    ]);
  });

  it("records failed update attempts without a generation", () => {
    const id = recordDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "plex",
      action: "update",
      status: "failed",
      errorMessage: "verification failed",
      planId: "update-plan-1",
    });

    expect(getDeployment(db, id)).toMatchObject({
      action: "update",
      imageId: undefined,
      imageDigest: undefined,
      status: "failed",
      errorMessage: "verification failed",
    });
    expect(getGenerations(db, { service: "plex" })).toHaveLength(0);
  });

  it("updates deployment status and error message", () => {
    const id = recordDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "plex",
      action: "deploy",
      status: "success",
    });

    updateDeploymentStatus(db, id, "failed", "container failed");

    const entry = getDeployment(db, id);
    expect(entry?.status).toBe("failed");
    expect(entry?.errorMessage).toBe("container failed");
  });

  it("returns undefined when deployment queries find no row", () => {
    expect(getDeployment(db, 1)).toBeUndefined();
    expect(getLatestDeployment(db, "missing")).toBeUndefined();
  });

  it("returns the most recent deployment for a service", () => {
    recordDeployment(db, {
      timestamp: "2026-01-01T00:00:00.000Z",
      service: "plex",
      action: "deploy",
      imageTag: "plex:1.0",
      status: "success",
    });
    recordDeployment(db, {
      timestamp: "2026-01-02T00:00:00.000Z",
      service: "plex",
      action: "rebuild",
      imageTag: "plex:2.0",
      status: "success",
    });

    const latest = getLatestDeployment(db, "plex");
    expect(latest?.imageTag).toBe("plex:2.0");
    expect(latest?.action).toBe("rebuild");
  });

  it("records multiple deployments in a batch and handles empty batches", () => {
    expect(recordDeployments(db, [])).toEqual([]);
    expect(
      recordDeployments(db, [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          service: "plex",
          action: "deploy",
          imageTag: "plex:latest",
          imageId: "sha256:plex-local-image-id",
          imageDigest: "plex@sha256:plex-repository-digest",
          configSnapshot: "{}",
          status: "success",
          planId: "plan-1",
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          service: "sonarr",
          action: "delete",
          status: "failed",
          errorMessage: "failed",
        },
      ]),
    ).toEqual([1, 2]);

    expect(getDeployment(db, 1)).toMatchObject({
      service: "plex",
      action: "deploy",
      imageTag: "plex:latest",
      imageId: "sha256:plex-local-image-id",
      imageDigest: "plex@sha256:plex-repository-digest",
      configSnapshot: "{}",
      status: "success",
      planId: "plan-1",
    });
    expect(getDeployment(db, 2)).toMatchObject({
      service: "sonarr",
      action: "delete",
      status: "failed",
      errorMessage: "failed",
    });
  });

  describe("automatic generation snapshots", () => {
    it("rolls back the deployment when generation creation fails", () => {
      db.exec(`
        CREATE TRIGGER fail_generation_insert
        BEFORE INSERT ON generations
        BEGIN
          SELECT RAISE(ABORT, 'generation write failed');
        END;
      `);

      expect(() =>
        recordDeployment(db, {
          timestamp: "2026-01-01T00:00:00.000Z",
          service: "plex",
          action: "update",
          imageId: "sha256:local-image-id",
          imageDigest: "plex@sha256:repository-digest",
          status: "success",
        }),
      ).toThrow("generation write failed");

      expect(db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM generations").get()).toEqual({ count: 0 });
    });

    it("creates a generation for successful deploy-like deployments", () => {
      const id = recordDeployment(db, {
        timestamp: "2026-01-01T00:00:00.000Z",
        service: "plex",
        action: "deploy",
        imageTag: "plex:1.0",
        configSnapshot: JSON.stringify({ image: "plex:1.0" }),
        status: "success",
      });

      const generations = getGenerations(db, { service: "plex" });
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        service: "plex",
        generation: 1,
        deploymentId: id,
        timestamp: "2026-01-01T00:00:00.000Z",
        imageTag: "plex:1.0",
        createdByAction: "deploy",
      });
    });

    it("does not create generations for failed deployments", () => {
      recordDeployment(db, {
        timestamp: "2026-01-01T00:00:00.000Z",
        service: "plex",
        action: "deploy",
        status: "failed",
        errorMessage: "boom",
      });

      expect(getGenerations(db, { service: "plex" })).toHaveLength(0);
    });

    it("does not create generations for destructive actions", () => {
      recordDeployment(db, {
        timestamp: "2026-01-01T00:00:00.000Z",
        service: "plex",
        action: "delete",
        status: "success",
      });
      recordDeployment(db, {
        timestamp: "2026-01-02T00:00:00.000Z",
        service: "plex",
        action: "prune",
        status: "success",
      });

      expect(getGenerations(db, { service: "plex" })).toHaveLength(0);
    });

    it("creates generations for rollback, rebuild, and apply actions", () => {
      for (const action of ["rebuild", "apply", "rollback"] as const) {
        recordDeployment(db, {
          timestamp: "2026-01-01T00:00:00.000Z",
          service: "plex",
          action,
          status: "success",
        });
      }

      const generations = getGenerations(db, { service: "plex" });
      expect(generations.map((g) => g.createdByAction)).toEqual(["rollback", "apply", "rebuild"]);
      expect(generations.map((g) => g.generation)).toEqual([3, 2, 1]);
    });

    it("records a baseline generation for a successful import (rfapps import)", () => {
      recordDeployment(db, {
        timestamp: "2026-01-01T00:00:00.000Z",
        service: "plex",
        action: "import",
        imageTag: "plexinc/pms-docker:1.40",
        imageId: "sha256:baseline",
        status: "success",
        configSnapshot: JSON.stringify({ image: "plexinc/pms-docker:1.40" }),
      });

      const generations = getGenerations(db, { service: "plex" });
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        service: "plex",
        generation: 1,
        createdByAction: "import",
        imageId: "sha256:baseline",
      });
    });

    it("creates generations within batch recording, skipping non-qualifying entries", () => {
      recordDeployments(db, [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          service: "plex",
          action: "deploy",
          imageTag: "plex:1.0",
          status: "success",
        },
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          service: "sonarr",
          action: "deploy",
          status: "failed",
          errorMessage: "boom",
        },
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          service: "radarr",
          action: "deploy",
          imageTag: "radarr:5.0",
          status: "success",
        },
      ]);

      expect(getGenerations(db, { service: "plex" })).toHaveLength(1);
      expect(getGenerations(db, { service: "sonarr" })).toHaveLength(0);
      expect(getGenerations(db, { service: "radarr" })).toHaveLength(1);
    });

    it("increments generation numbers across repeated deployments", () => {
      for (let i = 1; i <= 3; i++) {
        recordDeployment(db, {
          timestamp: `2026-01-0${i}T00:00:00.000Z`,
          service: "plex",
          action: "deploy",
          imageTag: `plex:${i}.0`,
          status: "success",
        });
      }

      const generations = getGenerations(db, { service: "plex" });
      expect(generations.map((g) => g.generation)).toEqual([3, 2, 1]);
      expect(generations[0]!.imageTag).toBe("plex:3.0");
    });
  });
});
