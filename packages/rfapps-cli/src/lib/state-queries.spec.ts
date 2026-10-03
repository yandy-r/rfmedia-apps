import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const commonMocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

vi.mock("@rfmedia/common", () => commonMocks);

import {
  findDeploymentById,
  findRollbackTarget,
  getDeploymentCount,
  getDeploymentHistory,
  getSuccessfulDeploymentCount,
} from "./state-queries.js";
import type { DbConnection } from "./db.js";
import type { StateEntryRow } from "../types/state.js";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");

function createDb(rows: StateEntryRow[] = [], count = 0) {
  const statement = {
    all: vi.fn(() => rows),
    get: vi.fn(() => rows[0] ?? { count }),
  };
  return {
    db: {
      prepare: vi.fn(() => statement),
    },
    statement,
  };
}

const ordinaryDeployment: Omit<StateEntryRow, "id"> = {
  timestamp: "2026-01-01T00:00:00.000Z",
  service: "plex",
  action: "deploy",
  image_tag: "plex:latest",
  image_id: null,
  image_digest: null,
  config_snapshot: null,
  status: "success",
  plan_id: "plan-1",
  error_message: null,
};

const row: StateEntryRow = { id: 1, ...ordinaryDeployment };

describe("state queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds filtered deployment history queries and maps rows", () => {
    const { db, statement } = createDb([row]);

    expect(
      getDeploymentHistory(db as never, {
        service: "plex",
        action: "deploy",
        since: "2025-01-01",
        limit: 5,
      }),
    ).toEqual([
      {
        id: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        service: "plex",
        action: "deploy",
        imageTag: "plex:latest",
        imageId: undefined,
        imageDigest: undefined,
        configSnapshot: undefined,
        status: "success",
        planId: "plan-1",
        errorMessage: undefined,
      },
    ]);
    expect(statement.all).toHaveBeenCalledWith("plex", "deploy", "2025-01-01", 5);
    expect((db.prepare.mock.calls[0] as unknown as [string])[0]).toContain(
      "WHERE service = ? AND action = ? AND timestamp >= ?",
    );
  });

  it("uses the default history limit when no filters are supplied", () => {
    const { db, statement } = createDb([]);

    expect(getDeploymentHistory(db as never, {})).toEqual([]);
    expect(statement.all).toHaveBeenCalledWith(10);
    expect((db.prepare.mock.calls[0] as unknown as [string])[0]).not.toContain("WHERE service");
  });

  it("finds rollback targets and rejects invalid step counts", () => {
    const { db, statement } = createDb([row]);

    expect(findRollbackTarget(db as never, "plex", 1)?.id).toBe(1);
    expect(statement.get).toHaveBeenCalledWith("plex", 1);
    expect(findRollbackTarget(db as never, "plex", 0)).toBeUndefined();
  });

  it("finds deployment IDs only when the CLI value is numeric and present", () => {
    const { db, statement } = createDb([row]);

    expect(findDeploymentById(db as never, "42")?.id).toBe(1);
    expect(statement.get).toHaveBeenCalledWith(42);
    expect(findDeploymentById(db as never, "42abc")).toBeUndefined();
    expect(findDeploymentById(db as never, "abc")).toBeUndefined();

    const missing = createDb([]);
    missing.statement.get.mockReturnValue(undefined as never);
    expect(findDeploymentById(missing.db as never, "99")).toBeUndefined();
  });

  it("counts successful deployments and filtered deployment totals", () => {
    const { db, statement } = createDb([], 3);

    expect(getSuccessfulDeploymentCount(db as never, "plex")).toBe(3);
    expect(statement.get).toHaveBeenCalledWith("plex");

    const countDb = createDb([], 7);
    expect(
      getDeploymentCount(countDb.db as never, {
        service: "plex",
        action: "deploy",
        since: "2025-01-01",
      }),
    ).toBe(7);
    expect(countDb.statement.get).toHaveBeenCalledWith("plex", "deploy", "2025-01-01");
  });

  describe("backward-compatible deployment reads", () => {
    let db: DbConnection;

    beforeEach(() => {
      db = new Database(":memory:");
      db.exec(SCHEMA);
    });

    function insertDeployment(entry: Omit<StateEntryRow, "id">): number {
      const result = db
        .prepare(
          `
            INSERT INTO deployments (
              timestamp, service, action, image_tag, image_id, image_digest,
              config_snapshot, status, plan_id, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          entry.timestamp,
          entry.service,
          entry.action,
          entry.image_tag,
          entry.image_id ?? null,
          entry.image_digest ?? null,
          entry.config_snapshot,
          entry.status,
          entry.plan_id,
          entry.error_message,
        );

      return Number(result.lastInsertRowid);
    }

    it("maps update identities and applies filters in newest-first order", () => {
      const olderUpdateId = insertDeployment({
        ...ordinaryDeployment,
        timestamp: "2026-01-03T00:00:00.000Z",
        action: "update",
        image_tag: "plex:1.1",
        image_id: "sha256:plex-image-1",
        image_digest: "plex@sha256:plex-digest-1",
        config_snapshot: '{"image":"plex:1.1"}',
        plan_id: "update-plan-1",
      });
      insertDeployment({
        ...ordinaryDeployment,
        timestamp: "2026-01-04T00:00:00.000Z",
        service: "sonarr",
        action: "update",
        image_tag: "sonarr:4.0",
        image_id: "sha256:sonarr-image",
        image_digest: "sonarr@sha256:sonarr-digest",
        plan_id: "update-plan-2",
      });
      const newerUpdateId = insertDeployment({
        ...ordinaryDeployment,
        timestamp: "2026-01-05T00:00:00.000Z",
        action: "update",
        image_tag: "plex:1.2",
        image_id: "sha256:plex-image-2",
        image_digest: "plex@sha256:plex-digest-2",
        config_snapshot: '{"image":"plex:1.2"}',
        plan_id: "update-plan-3",
      });

      const history = getDeploymentHistory(db, {
        service: "plex",
        action: "update",
        since: "2026-01-02T00:00:00.000Z",
        limit: 10,
      });

      expect(history.map((entry) => entry.id)).toEqual([newerUpdateId, olderUpdateId]);
      expect(history[0]).toEqual({
        id: newerUpdateId,
        timestamp: "2026-01-05T00:00:00.000Z",
        service: "plex",
        action: "update",
        imageTag: "plex:1.2",
        imageId: "sha256:plex-image-2",
        imageDigest: "plex@sha256:plex-digest-2",
        configSnapshot: '{"image":"plex:1.2"}',
        status: "success",
        planId: "update-plan-3",
        errorMessage: undefined,
      });
      expect(findDeploymentById(db, String(newerUpdateId))).toMatchObject({
        imageId: "sha256:plex-image-2",
        imageDigest: "plex@sha256:plex-digest-2",
      });
      expect(findRollbackTarget(db, "plex", 1)).toMatchObject({
        id: olderUpdateId,
        imageId: "sha256:plex-image-1",
        imageDigest: "plex@sha256:plex-digest-1",
      });
      expect(
        getDeploymentCount(db, {
          service: "plex",
          action: "update",
          since: "2026-01-02T00:00:00.000Z",
        }),
      ).toBe(2);
    });

    it("keeps ordinary deployment history with legacy null identities readable", () => {
      const deploymentId = insertDeployment({
        ...ordinaryDeployment,
        timestamp: "2025-12-31T00:00:00.000Z",
      });

      expect(getDeploymentHistory(db, { action: "deploy" })).toEqual([
        {
          id: deploymentId,
          timestamp: "2025-12-31T00:00:00.000Z",
          service: "plex",
          action: "deploy",
          imageTag: "plex:latest",
          imageId: undefined,
          imageDigest: undefined,
          configSnapshot: undefined,
          status: "success",
          planId: "plan-1",
          errorMessage: undefined,
        },
      ]);
    });
  });
});
