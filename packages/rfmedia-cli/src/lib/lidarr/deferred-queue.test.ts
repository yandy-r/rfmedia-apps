/**
 * Tests for the Lidarr deferred-intent queue domain API (issue #195).
 *
 * Real better-sqlite3 temp-file databases (queue-db.test.ts precedent) —
 * no :memory:, no DB mocks. Replay is exercised with a test-provided
 * executor map, a typed client mock, and store-backed breakers from
 * circuit-breaker.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { DbConnection } from "../../types/db.js";
import { initializeDatabase } from "../db.js";
import { getDeferredIntentRow } from "./deferred-queue-db.js";
import {
  enqueueDeferredIntent,
  listDeferredIntents,
  clearDeferredIntents,
  replayDeferredIntents,
  type EnqueueDeferredIntentInput,
  type LidarrIntentExecutor,
} from "./deferred-queue.js";
import {
  createCircuitBreaker,
  createSqliteCircuitStore,
  type CircuitDecision,
  type CircuitPolicy,
  type CircuitScope,
  type LidarrCircuitBreaker,
} from "./circuit-breaker.js";
import { LidarrUnreachableError, LidarrValidationError, RateLimitedError } from "./errors.js";
import { createLidarrClientMock } from "../../actions/test-helpers/lidarr-client-mocks.js";

const ORIGIN = "https://lidarr.example.net";
const OPERATION = "lidarr add artist";
const NOW = "2026-07-22T12:00:00.000Z";

const POLICY: CircuitPolicy = {
  failureThreshold: 3,
  failureWindowMs: 300_000,
  cooldownMs: 60_000,
};

function isoPlus(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

/** Recorded breaker spies for one fake breaker handle. */
interface FakeBreakerSpies {
  readonly recordSuccess: Mock<LidarrCircuitBreaker["recordSuccess"]>;
  readonly recordFailure: Mock<LidarrCircuitBreaker["recordFailure"]>;
}

/** Rejects with an `AbortError`-named error after aborting `controller` (Ctrl-C mid-executor). */
function abortingImpl(controller: AbortController): () => Promise<void> {
  return () => {
    controller.abort();
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    return Promise.reject(abortError);
  };
}

describe("Lidarr Deferred Queue Domain API", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-deferred-domain-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function enqueue(overrides: Partial<EnqueueDeferredIntentInput> = {}, nowIso: string = NOW) {
    return enqueueDeferredIntent(
      db,
      {
        origin: ORIGIN,
        operation: OPERATION,
        tier: "destructive",
        payload: { foreignArtistId: randomUUID() },
        ...overrides,
      },
      nowIso,
    );
  }

  function buildExecutor(
    operation: string = OPERATION,
    impl?: () => Promise<void>,
  ): { executor: LidarrIntentExecutor; execute: Mock<LidarrIntentExecutor["execute"]> } {
    const execute = vi.fn<LidarrIntentExecutor["execute"]>(impl ?? (() => Promise.resolve()));
    return { executor: { operation, execute }, execute };
  }

  function buildBreakers(nowIso: string = NOW): {
    lidarr: LidarrCircuitBreaker;
    metadata: LidarrCircuitBreaker;
  } {
    const store = createSqliteCircuitStore(db);
    const now = (): Date => new Date(nowIso);
    return {
      lidarr: createCircuitBreaker({ store, origin: ORIGIN, scope: "lidarr", policy: POLICY, now }),
      metadata: createCircuitBreaker({
        store,
        origin: ORIGIN,
        scope: "metadata",
        policy: POLICY,
        now,
      }),
    };
  }

  describe("enqueueDeferredIntent", () => {
    it("inserts a pending intent and maps the row to the domain shape", () => {
      const payload = { foreignArtistId: "mbid-1", monitored: true };
      const intent = enqueue({ payload });

      expect(intent.origin).toBe(ORIGIN);
      expect(intent.operation).toBe(OPERATION);
      expect(intent.tier).toBe("destructive");
      expect(intent.payload).toEqual(payload);
      expect(Object.isFrozen(intent.payload)).toBe(true);
      expect(intent.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(intent.status).toBe("pending");
      expect(intent.attempts).toBe(0);
      expect(intent.maxAttempts).toBe(5);
      expect(intent.errorCode).toBeNull();
      expect(intent.errorMessage).toBeNull();
      expect(intent.createdAt).toBe(NOW);
      expect(intent.updatedAt).toBe(NOW);
      expect(intent.nextAttemptAt).toBeNull();
      expect(intent.lastAttemptAt).toBeNull();
    });

    it("derives the same key regardless of payload key order (double-enqueue idempotency)", () => {
      const first = enqueue({ payload: { a: 1, b: { c: 2, d: [1, 2] } } });
      const duplicate = enqueue(
        { payload: { b: { d: [1, 2], c: 2 }, a: 1 } },
        "2026-07-22T13:00:00.000Z",
      );

      expect(duplicate.idempotencyKey).toBe(first.idempotencyKey);
      expect(duplicate.id).toBe(first.id);
      expect(duplicate.createdAt).toBe(NOW);
      expect(listDeferredIntents(db)).toHaveLength(1);
    });

    it("scopes derived-key idempotency by operation", () => {
      const payload = { foreignArtistId: "mbid-1" };
      enqueue({ payload });
      enqueue({ payload, operation: "lidarr refresh artist" });

      expect(listDeferredIntents(db)).toHaveLength(2);
    });

    it("honors an explicit idempotency key and maxAttempts", () => {
      const intent = enqueue({ idempotencyKey: "explicit-key", maxAttempts: 2 });

      expect(intent.idempotencyKey).toBe("explicit-key");
      expect(intent.maxAttempts).toBe(2);
    });

    it("seeds error fields and the Retry-After schedule from the deferring failure", () => {
      const intent = enqueue({ error: new RateLimitedError(OPERATION, 120) });

      expect(intent.errorCode).toBe("rate-limited");
      expect(intent.errorMessage).toBe("Lidarr rate-limited (retry after 120s)");
      expect(intent.nextAttemptAt).toBe(isoPlus(NOW, 120_000));
    });

    it("seeds error fields without a schedule when the failure has no Retry-After", () => {
      const intent = enqueue({ error: new LidarrUnreachableError(OPERATION) });

      expect(intent.errorCode).toBe("lidarr-unreachable");
      expect(intent.errorMessage).toBe("Lidarr is unreachable");
      expect(intent.nextAttemptAt).toBeNull();
    });
  });

  describe("listDeferredIntents", () => {
    it("lists intents in enqueue order and filters by status and limit", () => {
      const second = enqueue({}, "2026-07-22T11:30:00.000Z");
      const first = enqueue({}, "2026-07-22T11:00:00.000Z");

      expect(listDeferredIntents(db).map((intent) => intent.id)).toEqual([first.id, second.id]);
      expect(listDeferredIntents(db, { status: "pending" })).toHaveLength(2);
      expect(listDeferredIntents(db, { status: "failed" })).toHaveLength(0);
      expect(listDeferredIntents(db, { limit: 1 }).map((intent) => intent.id)).toEqual([first.id]);
    });

    it("filters by exact origin, operation, and idempotency keys before applying limit", () => {
      const wrongOrigin = enqueue(
        { origin: "https://other.example.net", idempotencyKey: "wrong-origin" },
        "2026-07-22T10:00:00.000Z",
      );
      const target = enqueue({ idempotencyKey: "target" }, "2026-07-22T11:00:00.000Z");
      const wrongOperation = enqueue(
        { operation: "lidarr refresh artist", idempotencyKey: "wrong-operation" },
        "2026-07-22T10:30:00.000Z",
      );

      expect(
        listDeferredIntents(db, {
          status: "pending",
          origin: ORIGIN,
          operation: OPERATION,
          idempotencyKeys: [wrongOrigin.idempotencyKey, wrongOperation.idempotencyKey, "target"],
          limit: 1,
        }).map((intent) => intent.id),
      ).toEqual([target.id]);
      expect(listDeferredIntents(db, { idempotencyKeys: ["missing"] })).toEqual([]);
      expect(listDeferredIntents(db, { idempotencyKeys: [] })).toEqual([]);
    });
  });

  describe("clearDeferredIntents", () => {
    it("clears by ids and by statuses, returning the removed count", () => {
      const first = enqueue();
      const second = enqueue();

      expect(clearDeferredIntents(db, { ids: [second.id] })).toBe(1);
      expect(clearDeferredIntents(db, { statuses: ["pending"] })).toBe(1);
      expect(getDeferredIntentRow(db, first.id)).toBeUndefined();
      expect(getDeferredIntentRow(db, second.id)).toBeUndefined();
    });
  });

  function buildFakeBreakers(
    gateDecision: CircuitDecision = {
      allowed: true,
      probe: false,
      next: { state: "closed", recentFailures: [] },
    },
  ): {
    breakers: { lidarr: LidarrCircuitBreaker; metadata: LidarrCircuitBreaker };
    lidarr: FakeBreakerSpies;
    metadata: FakeBreakerSpies;
  } {
    const make = (
      scope: CircuitScope,
    ): { breaker: LidarrCircuitBreaker; spies: FakeBreakerSpies } => {
      const recordSuccess = vi.fn<LidarrCircuitBreaker["recordSuccess"]>();
      const recordFailure = vi.fn<LidarrCircuitBreaker["recordFailure"]>();
      return {
        breaker: {
          origin: ORIGIN,
          scope,
          gate: () => gateDecision,
          recordSuccess,
          recordFailure,
          getState: () => ({ state: "closed", recentFailures: [] }),
        },
        spies: { recordSuccess, recordFailure },
      };
    };
    const lidarr = make("lidarr");
    const metadata = make("metadata");
    return {
      breakers: { lidarr: lidarr.breaker, metadata: metadata.breaker },
      lidarr: lidarr.spies,
      metadata: metadata.spies,
    };
  }

  describe("replayDeferredIntents", () => {
    it("succeeded: executes due intents and passes the client instance to the executor", async () => {
      const payload = { foreignArtistId: "mbid-1" };
      const intent = enqueue({ payload });
      const client = createLidarrClientMock();
      const { executor, execute } = buildExecutor();

      const report = await replayDeferredIntents(
        db,
        client,
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.attempted).toBe(1);
      expect(report.outcomes).toEqual([
        { id: intent.id, operation: OPERATION, outcome: "succeeded" },
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toEqual(payload);
      expect(execute.mock.calls[0]?.[1]).toBe(client);

      const row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("succeeded");
      expect(row?.attempts).toBe(1);
      expect(row?.error_code).toBeNull();
      expect(row?.last_attempt_at).toBe(NOW);
    });

    it("retried-later: reschedules a retryable failure with exponential backoff", async () => {
      const intent = enqueue();
      const { executor } = buildExecutor(OPERATION, () =>
        Promise.reject(new LidarrUnreachableError(OPERATION)),
      );
      const executors = new Map([[OPERATION, executor]]);

      const first = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        executors,
        buildBreakers(),
        {
          now: () => new Date(NOW),
        },
      );

      expect(first.attempted).toBe(1);
      expect(first.outcomes[0]).toEqual({
        id: intent.id,
        operation: OPERATION,
        outcome: "retried-later",
        errorCode: "lidarr-unreachable",
        message: "Lidarr is unreachable",
      });
      let row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(1);
      expect(row?.error_code).toBe("lidarr-unreachable");
      expect(row?.next_attempt_at).toBe(isoPlus(NOW, 30_000));

      // Second pass after the backoff elapses: the delay doubles (30s x 2^1).
      const secondNow = isoPlus(NOW, 31_000);
      const second = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        executors,
        buildBreakers(secondNow),
        { now: () => new Date(secondNow) },
      );

      expect(second.outcomes[0]?.outcome).toBe("retried-later");
      row = getDeferredIntentRow(db, intent.id);
      expect(row?.attempts).toBe(2);
      expect(row?.next_attempt_at).toBe(isoPlus(secondNow, 60_000));
    });

    it("retried-later: honors exact Retry-After over the exponential schedule", async () => {
      const intent = enqueue();
      const { executor } = buildExecutor(OPERATION, () =>
        Promise.reject(new RateLimitedError(OPERATION, 120)),
      );

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.outcomes[0]?.outcome).toBe("retried-later");
      expect(getDeferredIntentRow(db, intent.id)?.next_attempt_at).toBe(isoPlus(NOW, 120_000));
    });

    it("failed: a retryable failure at maxAttempts exhausts the intent", async () => {
      const intent = enqueue({ maxAttempts: 1 });
      const { executor } = buildExecutor(OPERATION, () =>
        Promise.reject(new LidarrUnreachableError(OPERATION)),
      );

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.outcomes[0]).toEqual({
        id: intent.id,
        operation: OPERATION,
        outcome: "failed",
        errorCode: "lidarr-unreachable",
        message: "Lidarr is unreachable",
      });
      const row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("failed");
      expect(row?.attempts).toBe(1);
      expect(row?.next_attempt_at).toBeNull();
    });

    it("failed: a non-retryable failure fails immediately regardless of maxAttempts", async () => {
      const intent = enqueue({ maxAttempts: 5 });
      const { executor } = buildExecutor(OPERATION, () =>
        Promise.reject(new LidarrValidationError(OPERATION, "Bad payload")),
      );

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.outcomes[0]).toEqual({
        id: intent.id,
        operation: OPERATION,
        outcome: "failed",
        errorCode: "validation",
        message: "Bad payload",
      });
      const row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("failed");
      expect(row?.attempts).toBe(1);
    });

    it("failed: a non-Lidarr error fails immediately without a taxonomy code", async () => {
      const intent = enqueue();
      const { executor } = buildExecutor(OPERATION, () => Promise.reject(new Error("boom")));

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.outcomes[0]).toEqual({
        id: intent.id,
        operation: OPERATION,
        outcome: "failed",
        message: "boom",
      });
      const row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("failed");
      expect(row?.error_code).toBeNull();
      expect(row?.error_message).toBe("boom");
    });

    it("no-executor: resets the claimed row to pending untouched", async () => {
      const intent = enqueue();

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map<string, LidarrIntentExecutor>(),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.attempted).toBe(0);
      expect(report.outcomes).toEqual([
        {
          id: intent.id,
          operation: OPERATION,
          outcome: "no-executor",
          message: `No executor registered for operation '${OPERATION}'`,
        },
      ]);
      const row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(0);
      expect(row?.last_attempt_at).toBeNull();
    });

    it("skipped-circuit-open: an open lidarr breaker skips rows untouched, zero executor calls", async () => {
      const intent = enqueue();
      const store = createSqliteCircuitStore(db);
      store.save(ORIGIN, "lidarr", {
        state: "open",
        openedAt: NOW,
        cooldownMs: 60_000,
        reason: "lidarr-unreachable",
      });
      const { executor, execute } = buildExecutor();

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.attempted).toBe(0);
      expect(report.outcomes).toEqual([
        {
          id: intent.id,
          operation: OPERATION,
          outcome: "skipped-circuit-open",
          errorCode: "lidarr-unreachable",
          message: `Circuit open [lidarr]; replay resumes at ${isoPlus(NOW, 60_000)}`,
        },
      ]);
      expect(execute).not.toHaveBeenCalled();
      const row = getDeferredIntentRow(db, intent.id);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(0);
    });

    it("gates once per distinct tier and only consults metadata for tiers that require it", async () => {
      enqueue();
      enqueue();
      enqueue({ tier: "metadata-dependent" });
      const allowed: CircuitDecision = {
        allowed: true,
        probe: false,
        next: { state: "closed", recentFailures: [] },
      };
      const fakeBreaker = (
        scope: CircuitScope,
        gate: Mock<() => CircuitDecision>,
      ): LidarrCircuitBreaker => ({
        origin: ORIGIN,
        scope,
        gate,
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        getState: () => ({ state: "closed", recentFailures: [] }),
      });
      const lidarrGate = vi.fn(() => allowed);
      const metadataGate = vi.fn(() => allowed);
      const { executor } = buildExecutor();

      await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        {
          lidarr: fakeBreaker("lidarr", lidarrGate),
          metadata: fakeBreaker("metadata", metadataGate),
        },
        { now: () => new Date(NOW) },
      );

      expect(lidarrGate).toHaveBeenCalledTimes(1);
      expect(metadataGate).toHaveBeenCalledTimes(1);

      lidarrGate.mockClear();
      metadataGate.mockClear();
      enqueue();

      await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        {
          lidarr: fakeBreaker("lidarr", lidarrGate),
          metadata: fakeBreaker("metadata", metadataGate),
        },
        { now: () => new Date(NOW) },
      );

      expect(lidarrGate).toHaveBeenCalledTimes(1);
      expect(metadataGate).not.toHaveBeenCalled();
    });

    it("skips rows that are not yet due", async () => {
      enqueue({ error: new RateLimitedError(OPERATION, 120) });
      const { executor, execute } = buildExecutor();

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { now: () => new Date(NOW) },
      );

      expect(report.attempted).toBe(0);
      expect(report.outcomes).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    it("restricts replay to requested ids and honors the limit", async () => {
      const first = enqueue({}, "2026-07-22T11:00:00.000Z");
      const second = enqueue({}, "2026-07-22T11:30:00.000Z");
      const { executor, execute } = buildExecutor();

      const byIds = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { ids: [second.id], now: () => new Date(NOW) },
      );

      expect(byIds.outcomes.map((outcome) => outcome.id)).toEqual([second.id]);
      expect(execute).toHaveBeenCalledTimes(1);

      const byLimit = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { limit: 1, now: () => new Date(NOW) },
      );

      expect(byLimit.outcomes.map((outcome) => outcome.id)).toEqual([first.id]);
    });

    it("replays a requested later id without selecting unrelated earlier due rows", async () => {
      const unrelated = Array.from({ length: 500 }, (_, index) =>
        enqueue({ idempotencyKey: `unrelated-${index}` }, "2026-07-22T11:00:00.000Z"),
      );
      const requested = enqueue({ idempotencyKey: "requested" }, "2026-07-22T11:30:00.000Z");
      const { executor, execute } = buildExecutor();

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { ids: [requested.id], limit: 1, now: () => new Date(NOW) },
      );

      expect(report.outcomes.map((outcome) => outcome.id)).toEqual([requested.id]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(getDeferredIntentRow(db, unrelated[0]!.id)?.status).toBe("pending");
    });

    it("stops before processing further rows once the signal is aborted", async () => {
      enqueue();
      const { executor, execute } = buildExecutor();
      const controller = new AbortController();
      controller.abort();

      const report = await replayDeferredIntents(
        db,
        createLidarrClientMock(),
        new Map([[OPERATION, executor]]),
        buildBreakers(),
        { signal: controller.signal, now: () => new Date(NOW) },
      );

      expect(report.attempted).toBe(0);
      expect(report.outcomes).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    describe("breaker feedback (design §7d)", () => {
      it("closes a gated circuit when a successful replay resolves the half-open probe claim", async () => {
        const intent = enqueue();
        const store = createSqliteCircuitStore(db);
        store.save(ORIGIN, "lidarr", {
          state: "open",
          openedAt: isoPlus(NOW, -61_000),
          cooldownMs: 60_000,
          reason: "lidarr-unreachable",
        });
        const { executor } = buildExecutor();

        const report = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          buildBreakers(),
          { now: () => new Date(NOW) },
        );

        expect(report.outcomes).toEqual([
          { id: intent.id, operation: OPERATION, outcome: "succeeded" },
        ]);
        expect(store.load(ORIGIN, "lidarr")).toEqual({ state: "closed", recentFailures: [] });
      });

      it("re-opens a gated circuit when the replay probe fails with a retryable error", async () => {
        enqueue();
        const store = createSqliteCircuitStore(db);
        store.save(ORIGIN, "lidarr", {
          state: "open",
          openedAt: isoPlus(NOW, -61_000),
          cooldownMs: 60_000,
          reason: "lidarr-unreachable",
        });
        const { executor } = buildExecutor(OPERATION, () =>
          Promise.reject(new LidarrUnreachableError(OPERATION)),
        );

        const report = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          buildBreakers(),
          { now: () => new Date(NOW) },
        );

        expect(report.outcomes[0]?.outcome).toBe("retried-later");
        expect(store.load(ORIGIN, "lidarr")).toEqual({
          state: "open",
          openedAt: NOW,
          cooldownMs: 60_000,
          reason: "lidarr-unreachable",
        });
      });

      it("feeds retryable executor failures only to the scope the error code maps to", async () => {
        enqueue();
        const store = createSqliteCircuitStore(db);
        const { executor } = buildExecutor(OPERATION, () =>
          Promise.reject(new LidarrUnreachableError(OPERATION)),
        );

        await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          buildBreakers(),
          { now: () => new Date(NOW) },
        );

        expect(store.load(ORIGIN, "lidarr")).toEqual({ state: "closed", recentFailures: [NOW] });
        expect(store.load(ORIGIN, "metadata")).toEqual({ state: "closed", recentFailures: [] });
      });

      it("records success once per gated scope, including metadata for metadata-dependent tiers", async () => {
        enqueue();
        enqueue();
        enqueue({ tier: "metadata-dependent" });
        const fake = buildFakeBreakers();
        const { executor } = buildExecutor();

        await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          fake.breakers,
          { now: () => new Date(NOW) },
        );

        expect(fake.lidarr.recordSuccess).toHaveBeenCalledTimes(1);
        expect(fake.metadata.recordSuccess).toHaveBeenCalledTimes(1);
        expect(fake.lidarr.recordFailure).not.toHaveBeenCalled();
        expect(fake.metadata.recordFailure).not.toHaveBeenCalled();
      });

      it("does not feed breakers for skipped-circuit-open or no-executor outcomes", async () => {
        enqueue();
        const blocked = buildFakeBreakers({
          allowed: false,
          next: { state: "open", openedAt: NOW, cooldownMs: 60_000, reason: "lidarr-unreachable" },
          retryAtIso: isoPlus(NOW, 60_000),
          retryAfterMs: 60_000,
          reason: "lidarr-unreachable",
        });

        await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, buildExecutor().executor]]),
          blocked.breakers,
          { now: () => new Date(NOW) },
        );

        expect(blocked.lidarr.recordSuccess).not.toHaveBeenCalled();
        expect(blocked.lidarr.recordFailure).not.toHaveBeenCalled();

        const allowed = buildFakeBreakers();

        await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map<string, LidarrIntentExecutor>(),
          allowed.breakers,
          { now: () => new Date(NOW) },
        );

        expect(allowed.lidarr.recordSuccess).not.toHaveBeenCalled();
        expect(allowed.lidarr.recordFailure).not.toHaveBeenCalled();
      });

      it("does not feed breakers for non-retryable or non-Lidarr failures", async () => {
        enqueue();
        enqueue();
        let call = 0;
        const { executor } = buildExecutor(OPERATION, () => {
          call += 1;
          return Promise.reject(
            call === 1 ? new LidarrValidationError(OPERATION, "Bad payload") : new Error("boom"),
          );
        });
        const fake = buildFakeBreakers();

        const report = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          fake.breakers,
          { now: () => new Date(NOW) },
        );

        expect(report.outcomes.map((outcome) => outcome.outcome)).toEqual(["failed", "failed"]);
        expect(fake.lidarr.recordSuccess).not.toHaveBeenCalled();
        expect(fake.lidarr.recordFailure).not.toHaveBeenCalled();
        expect(fake.metadata.recordFailure).not.toHaveBeenCalled();
      });
    });

    describe("cancelled (abort mid-executor)", () => {
      it("restores the row to pending, stops the pass, and feeds no breaker", async () => {
        const first = enqueue({}, "2026-07-22T11:00:00.000Z");
        const second = enqueue({}, "2026-07-22T11:30:00.000Z");
        const controller = new AbortController();
        const { executor, execute } = buildExecutor(OPERATION, abortingImpl(controller));
        const fake = buildFakeBreakers();

        const report = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          fake.breakers,
          { signal: controller.signal, now: () => new Date(NOW) },
        );

        expect(report.attempted).toBe(1);
        expect(report.outcomes).toEqual([
          {
            id: first.id,
            operation: OPERATION,
            outcome: "cancelled",
            message: "Replay cancelled; intent restored to pending",
          },
        ]);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(fake.lidarr.recordSuccess).not.toHaveBeenCalled();
        expect(fake.lidarr.recordFailure).not.toHaveBeenCalled();
        expect(fake.metadata.recordFailure).not.toHaveBeenCalled();

        const row = getDeferredIntentRow(db, first.id);
        expect(row?.status).toBe("pending");
        expect(row?.attempts).toBe(0);
        expect(row?.error_code).toBeNull();
        expect(row?.error_message).toBeNull();
        expect(row?.last_attempt_at).toBeNull();
        const untouched = getDeferredIntentRow(db, second.id);
        expect(untouched?.status).toBe("pending");
        expect(untouched?.attempts).toBe(0);
      });

      it("a subsequent replay picks the restored intent up again", async () => {
        const intent = enqueue();
        const controller = new AbortController();
        const { executor: abortingExecutor } = buildExecutor(OPERATION, abortingImpl(controller));

        const firstPass = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, abortingExecutor]]),
          buildBreakers(),
          { signal: controller.signal, now: () => new Date(NOW) },
        );

        expect(firstPass.outcomes[0]?.outcome).toBe("cancelled");

        const { executor } = buildExecutor();
        const secondNow = isoPlus(NOW, 1_000);
        const secondPass = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          buildBreakers(secondNow),
          { now: () => new Date(secondNow) },
        );

        expect(secondPass.outcomes).toEqual([
          { id: intent.id, operation: OPERATION, outcome: "succeeded" },
        ]);
        const row = getDeferredIntentRow(db, intent.id);
        expect(row?.status).toBe("succeeded");
        expect(row?.attempts).toBe(1);
      });

      it("treats a non-abort error thrown while the signal is aborted as cancellation", async () => {
        const intent = enqueue();
        const controller = new AbortController();
        const { executor } = buildExecutor(OPERATION, () => {
          controller.abort();
          return Promise.reject(new Error("interrupted"));
        });

        const report = await replayDeferredIntents(
          db,
          createLidarrClientMock(),
          new Map([[OPERATION, executor]]),
          buildBreakers(),
          { signal: controller.signal, now: () => new Date(NOW) },
        );

        expect(report.outcomes[0]?.outcome).toBe("cancelled");
        const row = getDeferredIntentRow(db, intent.id);
        expect(row?.status).toBe("pending");
        expect(row?.attempts).toBe(0);
        expect(row?.error_message).toBeNull();
      });
    });
  });
});
