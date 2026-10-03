/**
 * Tests for lidarr_deferred_intents row-level CRUD (schema v10, issue #195).
 *
 * Real better-sqlite3 temp-file databases (queue-db.test.ts precedent) —
 * no :memory:, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DbConnection, CreateLidarrDeferredIntentParams } from "../../types/db.js";
import {
  insertDeferredIntent,
  getDeferredIntentRow,
  selectDueDeferredIntents,
  claimDeferredIntent,
  recordDeferredIntentAttempt,
  updateDeferredIntentStatus,
  updateDeferredIntentStatusBatch,
  listDeferredIntentRows,
  clearDeferredIntentRows,
  countDeferredIntentsByStatus,
} from "./deferred-queue-db.js";
import { initializeDatabase } from "../db.js";

const ORIGIN = "https://lidarr.example.net";
const NOW = "2026-07-22T12:00:00.000Z";

function buildParams(
  overrides: Partial<CreateLidarrDeferredIntentParams> = {},
): CreateLidarrDeferredIntentParams {
  return {
    id: randomUUID(),
    origin: ORIGIN,
    operation: "lidarr add artist",
    tier: "destructive",
    payloadJson: JSON.stringify({ foreignArtistId: "mbid-1" }),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

describe("Lidarr Deferred Intent DB Operations", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-deferred-test-"));
    const dbPath = join(tempDir, "test.db");
    db = await initializeDatabase(dbPath);
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("insertDeferredIntent", () => {
    it("inserts a pending row with schema defaults", () => {
      const params = buildParams();
      const row = insertDeferredIntent(db, params, NOW);

      expect(row.id).toBe(params.id);
      expect(row.origin).toBe(ORIGIN);
      expect(row.operation).toBe("lidarr add artist");
      expect(row.tier).toBe("destructive");
      expect(row.payload_json).toBe(params.payloadJson);
      expect(row.idempotency_key).toBe(params.idempotencyKey);
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.max_attempts).toBe(5);
      expect(row.error_code).toBeNull();
      expect(row.error_message).toBeNull();
      expect(row.created_at).toBe(NOW);
      expect(row.updated_at).toBe(NOW);
      expect(row.next_attempt_at).toBeNull();
      expect(row.last_attempt_at).toBeNull();
    });

    it("honors maxAttempts and failure-seed parameters", () => {
      const row = insertDeferredIntent(
        db,
        buildParams({
          maxAttempts: 3,
          errorCode: "lidarr-unreachable",
          errorMessage: "Lidarr unreachable",
          nextAttemptAt: "2026-07-22T12:05:00.000Z",
        }),
        NOW,
      );

      expect(row.max_attempts).toBe(3);
      expect(row.error_code).toBe("lidarr-unreachable");
      expect(row.error_message).toBe("Lidarr unreachable");
      expect(row.next_attempt_at).toBe("2026-07-22T12:05:00.000Z");
    });

    it("is idempotent on (origin, idempotency_key): duplicate returns the existing row", () => {
      const key = randomUUID();
      const first = insertDeferredIntent(db, buildParams({ idempotencyKey: key }), NOW);
      const duplicate = insertDeferredIntent(
        db,
        buildParams({ idempotencyKey: key, maxAttempts: 9 }),
        "2026-07-22T13:00:00.000Z",
      );

      expect(duplicate.id).toBe(first.id);
      expect(duplicate.max_attempts).toBe(5);
      expect(duplicate.created_at).toBe(NOW);
      expect(listDeferredIntentRows(db)).toHaveLength(1);
    });

    it("scopes idempotency to the origin: same key on another origin inserts a new row", () => {
      const key = randomUUID();
      insertDeferredIntent(db, buildParams({ idempotencyKey: key }), NOW);
      const other = insertDeferredIntent(
        db,
        buildParams({ idempotencyKey: key, origin: "https://other.example.net" }),
        NOW,
      );

      expect(other.origin).toBe("https://other.example.net");
      expect(listDeferredIntentRows(db)).toHaveLength(2);
    });
  });

  describe("getDeferredIntentRow", () => {
    it("returns the row by id and undefined for unknown ids", () => {
      const row = insertDeferredIntent(db, buildParams(), NOW);

      expect(getDeferredIntentRow(db, row.id)?.id).toBe(row.id);
      expect(getDeferredIntentRow(db, "missing")).toBeUndefined();
    });
  });

  describe("selectDueDeferredIntents", () => {
    it("selects pending rows that are unscheduled or due, ordered by created_at", () => {
      const later = insertDeferredIntent(db, buildParams(), "2026-07-22T11:30:00.000Z");
      const earlier = insertDeferredIntent(db, buildParams(), "2026-07-22T11:00:00.000Z");
      const dueExactly = insertDeferredIntent(
        db,
        buildParams({ nextAttemptAt: NOW }),
        "2026-07-22T11:45:00.000Z",
      );
      insertDeferredIntent(
        db,
        buildParams({ nextAttemptAt: "2026-07-22T12:00:00.001Z" }),
        "2026-07-22T10:00:00.000Z",
      );

      const due = selectDueDeferredIntents(db, NOW);

      expect(due.map((row) => row.id)).toEqual([earlier.id, later.id, dueExactly.id]);
    });

    it("excludes non-pending rows", () => {
      const claimed = insertDeferredIntent(db, buildParams(), NOW);
      claimDeferredIntent(db, claimed.id, NOW);
      const failed = insertDeferredIntent(db, buildParams(), NOW);
      updateDeferredIntentStatus(db, failed.id, "failed", NOW);

      expect(selectDueDeferredIntents(db, NOW)).toHaveLength(0);
    });

    it("respects the limit", () => {
      const first = insertDeferredIntent(db, buildParams(), "2026-07-22T11:00:00.000Z");
      insertDeferredIntent(db, buildParams(), "2026-07-22T11:30:00.000Z");

      const due = selectDueDeferredIntents(db, NOW, 1);

      expect(due).toHaveLength(1);
      expect(due[0]?.id).toBe(first.id);
    });

    it("filters exact ids before ordering and limiting across bounded chunks", () => {
      for (let index = 0; index < 500; index += 1) {
        insertDeferredIntent(
          db,
          buildParams({ idempotencyKey: `unrelated-${index}` }),
          "2026-07-22T11:00:00.000Z",
        );
      }
      const requested = insertDeferredIntent(
        db,
        buildParams({ idempotencyKey: "requested" }),
        "2026-07-22T11:30:00.000Z",
      );
      const ids = [...Array.from({ length: 499 }, (_, index) => `missing-${index}`), requested.id];

      expect(selectDueDeferredIntents(db, NOW, 1, ids).map((row) => row.id)).toEqual([
        requested.id,
      ]);
    });

    it("returns no rows for an empty id selector and rejects ids beyond the plan cap", () => {
      insertDeferredIntent(db, buildParams(), NOW);

      expect(selectDueDeferredIntents(db, NOW, undefined, [])).toEqual([]);
      expect(() =>
        selectDueDeferredIntents(
          db,
          NOW,
          undefined,
          Array.from({ length: 1_001 }, (_, index) => `id-${index}`),
        ),
      ).toThrow(/at most 1000 entries/);
    });

    it("throws on a non-positive limit", () => {
      expect(() => selectDueDeferredIntents(db, NOW, 0)).toThrow(/positive integer/);
    });
  });

  describe("claimDeferredIntent", () => {
    it("claims a pending row exactly once (claim-race guard)", () => {
      const row = insertDeferredIntent(db, buildParams(), NOW);

      expect(claimDeferredIntent(db, row.id, NOW)).toBe(true);
      expect(getDeferredIntentRow(db, row.id)?.status).toBe("in-progress");
      expect(claimDeferredIntent(db, row.id, NOW)).toBe(false);
    });

    it("returns false for missing or terminal rows", () => {
      const row = insertDeferredIntent(db, buildParams(), NOW);
      updateDeferredIntentStatus(db, row.id, "failed", NOW);

      expect(claimDeferredIntent(db, "missing", NOW)).toBe(false);
      expect(claimDeferredIntent(db, row.id, NOW)).toBe(false);
    });
  });

  describe("recordDeferredIntentAttempt", () => {
    it("writes a failed attempt with backoff and error fields", () => {
      const row = insertDeferredIntent(db, buildParams(), NOW);
      claimDeferredIntent(db, row.id, NOW);

      recordDeferredIntentAttempt(
        db,
        row.id,
        {
          status: "pending",
          attempts: 1,
          errorCode: "timeout",
          errorMessage: "Request timed out",
          nextAttemptAt: "2026-07-22T12:01:00.000Z",
        },
        NOW,
      );

      const updated = getDeferredIntentRow(db, row.id);
      expect(updated?.status).toBe("pending");
      expect(updated?.attempts).toBe(1);
      expect(updated?.error_code).toBe("timeout");
      expect(updated?.error_message).toBe("Request timed out");
      expect(updated?.next_attempt_at).toBe("2026-07-22T12:01:00.000Z");
      expect(updated?.last_attempt_at).toBe(NOW);
      expect(updated?.updated_at).toBe(NOW);
    });

    it("clears error and backoff fields when omitted (success outcome)", () => {
      const row = insertDeferredIntent(
        db,
        buildParams({
          errorCode: "lidarr-unreachable",
          errorMessage: "seed",
          nextAttemptAt: "2026-07-22T12:05:00.000Z",
        }),
        NOW,
      );

      recordDeferredIntentAttempt(db, row.id, { status: "succeeded", attempts: 1 }, NOW);

      const updated = getDeferredIntentRow(db, row.id);
      expect(updated?.status).toBe("succeeded");
      expect(updated?.error_code).toBeNull();
      expect(updated?.error_message).toBeNull();
      expect(updated?.next_attempt_at).toBeNull();
    });

    it("throws for an unknown id", () => {
      expect(() =>
        recordDeferredIntentAttempt(db, "missing", { status: "failed", attempts: 1 }, NOW),
      ).toThrow("Deferred intent not found: missing");
    });
  });

  describe("updateDeferredIntentStatus", () => {
    it("updates the status and updated_at only", () => {
      const row = insertDeferredIntent(db, buildParams(), NOW);
      claimDeferredIntent(db, row.id, NOW);

      updateDeferredIntentStatus(db, row.id, "pending", "2026-07-22T12:30:00.000Z");

      const updated = getDeferredIntentRow(db, row.id);
      expect(updated?.status).toBe("pending");
      expect(updated?.updated_at).toBe("2026-07-22T12:30:00.000Z");
      expect(updated?.attempts).toBe(0);
    });

    it("throws for an unknown id", () => {
      expect(() => updateDeferredIntentStatus(db, "missing", "failed", NOW)).toThrow(
        "Deferred intent not found: missing",
      );
    });
  });

  describe("updateDeferredIntentStatusBatch", () => {
    it("updates all rows in one transaction", () => {
      const a = insertDeferredIntent(db, buildParams(), NOW);
      const b = insertDeferredIntent(db, buildParams(), NOW);

      updateDeferredIntentStatusBatch(db, [a.id, b.id], "cancelled", NOW);

      expect(getDeferredIntentRow(db, a.id)?.status).toBe("cancelled");
      expect(getDeferredIntentRow(db, b.id)?.status).toBe("cancelled");
    });

    it("rolls back the whole batch when an id is missing", () => {
      const row = insertDeferredIntent(db, buildParams(), NOW);

      expect(() =>
        updateDeferredIntentStatusBatch(db, [row.id, "missing"], "cancelled", NOW),
      ).toThrow("Deferred intents not found: missing");
      expect(getDeferredIntentRow(db, row.id)?.status).toBe("pending");
    });

    it("is a no-op for an empty id list", () => {
      expect(() => updateDeferredIntentStatusBatch(db, [], "cancelled", NOW)).not.toThrow();
    });
  });

  describe("listDeferredIntentRows", () => {
    it("lists all rows in enqueue order and filters by status, origin, operation, and limit", () => {
      const second = insertDeferredIntent(db, buildParams(), "2026-07-22T11:30:00.000Z");
      const first = insertDeferredIntent(db, buildParams(), "2026-07-22T11:00:00.000Z");
      const other = insertDeferredIntent(
        db,
        buildParams({ origin: "https://other.example.net" }),
        "2026-07-22T11:45:00.000Z",
      );
      updateDeferredIntentStatus(db, second.id, "failed", NOW);

      expect(listDeferredIntentRows(db).map((row) => row.id)).toEqual([
        first.id,
        second.id,
        other.id,
      ]);
      expect(listDeferredIntentRows(db, { status: "failed" }).map((row) => row.id)).toEqual([
        second.id,
      ]);
      expect(listDeferredIntentRows(db, { origin: ORIGIN })).toHaveLength(2);
      expect(listDeferredIntentRows(db, { operation: "lidarr add artist" })).toHaveLength(3);
      expect(listDeferredIntentRows(db, { operation: "lidarr refresh artist" })).toEqual([]);
      expect(listDeferredIntentRows(db, { limit: 1 }).map((row) => row.id)).toEqual([first.id]);
    });

    it("chunks bounded idempotency keys and applies limit after every exact filter", () => {
      const later = insertDeferredIntent(
        db,
        buildParams({ idempotencyKey: "later" }),
        "2026-07-22T11:30:00.000Z",
      );
      const wrongOperation = insertDeferredIntent(
        db,
        buildParams({
          operation: "lidarr refresh artist",
          idempotencyKey: "wrong-operation",
        }),
        "2026-07-22T10:30:00.000Z",
      );
      const first = insertDeferredIntent(
        db,
        buildParams({ idempotencyKey: "first" }),
        "2026-07-22T11:00:00.000Z",
      );
      const keys = [
        later.idempotency_key,
        wrongOperation.idempotency_key,
        ...Array.from({ length: 495 }, (_, index) => `missing-${index}`),
        first.idempotency_key,
      ];

      expect(
        listDeferredIntentRows(db, {
          status: "pending",
          origin: ORIGIN,
          operation: "lidarr add artist",
          idempotencyKeys: keys,
          limit: 1,
        }).map((row) => row.id),
      ).toEqual([first.id]);
    });

    it("returns no rows for empty or unknown idempotency-key selectors", () => {
      insertDeferredIntent(db, buildParams({ idempotencyKey: "existing" }), NOW);

      expect(listDeferredIntentRows(db, { idempotencyKeys: [] })).toEqual([]);
      expect(listDeferredIntentRows(db, { idempotencyKeys: ["missing"] })).toEqual([]);
    });

    it("throws on a non-positive limit", () => {
      expect(() => listDeferredIntentRows(db, { limit: -1 })).toThrow(/positive integer/);
    });

    it("rejects more idempotency keys than a bounded plan can contain", () => {
      const keys = Array.from({ length: 1_001 }, (_, index) => `key-${index}`);

      expect(() => listDeferredIntentRows(db, { idempotencyKeys: keys })).toThrow(
        /at most 1000 entries/,
      );
    });
  });

  describe("clearDeferredIntentRows", () => {
    it("deletes by statuses", () => {
      const failed = insertDeferredIntent(db, buildParams(), NOW);
      updateDeferredIntentStatus(db, failed.id, "failed", NOW);
      insertDeferredIntent(db, buildParams(), NOW);

      const removed = clearDeferredIntentRows(db, { statuses: ["failed", "cancelled"] });

      expect(removed).toBe(1);
      expect(listDeferredIntentRows(db)).toHaveLength(1);
    });

    it("deletes by ids", () => {
      const a = insertDeferredIntent(db, buildParams(), NOW);
      const b = insertDeferredIntent(db, buildParams(), NOW);

      const removed = clearDeferredIntentRows(db, { ids: [a.id] });

      expect(removed).toBe(1);
      expect(getDeferredIntentRow(db, a.id)).toBeUndefined();
      expect(getDeferredIntentRow(db, b.id)?.id).toBe(b.id);
    });

    it("combines ids and statuses with AND semantics", () => {
      const pending = insertDeferredIntent(db, buildParams(), NOW);
      const failed = insertDeferredIntent(db, buildParams(), NOW);
      updateDeferredIntentStatus(db, failed.id, "failed", NOW);

      const removed = clearDeferredIntentRows(db, {
        ids: [pending.id, failed.id],
        statuses: ["failed"],
      });

      expect(removed).toBe(1);
      expect(getDeferredIntentRow(db, pending.id)?.id).toBe(pending.id);
      expect(getDeferredIntentRow(db, failed.id)).toBeUndefined();
    });

    it("returns 0 for an explicitly empty selector without deleting", () => {
      insertDeferredIntent(db, buildParams(), NOW);

      expect(clearDeferredIntentRows(db, { ids: [] })).toBe(0);
      expect(clearDeferredIntentRows(db, { statuses: [] })).toBe(0);
      expect(listDeferredIntentRows(db)).toHaveLength(1);
    });

    it("throws when neither ids nor statuses is provided", () => {
      expect(() => clearDeferredIntentRows(db, {})).toThrow(
        "clearDeferredIntentRows requires at least one of ids or statuses",
      );
    });
  });

  describe("countDeferredIntentsByStatus", () => {
    it("returns zero counts for every status on an empty table", () => {
      expect(countDeferredIntentsByStatus(db)).toEqual({
        pending: 0,
        "in-progress": 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      });
    });

    it("counts rows per status", () => {
      insertDeferredIntent(db, buildParams(), NOW);
      insertDeferredIntent(db, buildParams(), NOW);
      const claimed = insertDeferredIntent(db, buildParams(), NOW);
      claimDeferredIntent(db, claimed.id, NOW);
      const failed = insertDeferredIntent(db, buildParams(), NOW);
      updateDeferredIntentStatus(db, failed.id, "failed", NOW);

      expect(countDeferredIntentsByStatus(db)).toEqual({
        pending: 2,
        "in-progress": 1,
        succeeded: 0,
        failed: 1,
        cancelled: 0,
      });
    });

    it("scopes counts to an origin when provided", () => {
      const otherOrigin = "https://other.example.net";
      insertDeferredIntent(db, buildParams(), NOW);
      insertDeferredIntent(db, buildParams({ origin: otherOrigin }), NOW);
      const otherFailed = insertDeferredIntent(db, buildParams({ origin: otherOrigin }), NOW);
      updateDeferredIntentStatus(db, otherFailed.id, "failed", NOW);

      expect(countDeferredIntentsByStatus(db, ORIGIN)).toEqual({
        pending: 1,
        "in-progress": 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      });
      expect(countDeferredIntentsByStatus(db, otherOrigin)).toEqual({
        pending: 1,
        "in-progress": 0,
        succeeded: 0,
        failed: 1,
        cancelled: 0,
      });
      // Unscoped counting still sees every origin.
      expect(countDeferredIntentsByStatus(db)).toEqual({
        pending: 2,
        "in-progress": 0,
        succeeded: 0,
        failed: 1,
        cancelled: 0,
      });
    });
  });
});
