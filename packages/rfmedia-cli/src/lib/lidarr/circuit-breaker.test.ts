/**
 * Tests for the Lidarr circuit breaker (issue #195).
 *
 * Pure-function transition matrix with injected `nowIso` (windowed failure
 * counting, Retry-After cooldown floor, crashed-probe self-heal), SQLite
 * store round-trips on a real temp-file database, and store-backed handle
 * persistence ordering (persist `next` before returning; write only on
 * change).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { DbConnection } from "../../types/db.js";
import { initializeDatabase } from "../db.js";
import {
  LidarrUnreachableError,
  MetadataProviderUnavailableError,
  RateLimitedError,
} from "./errors.js";
import type { CircuitPolicy, CircuitScope, CircuitState, CircuitStore } from "./circuit-breaker.js";
import {
  HALF_OPEN_PROBE_TIMEOUT_MS,
  createCircuitBreaker,
  createSqliteCircuitStore,
  evaluateCircuit,
  recordCircuitFailure,
  recordCircuitSuccess,
} from "./circuit-breaker.js";

const POLICY: CircuitPolicy = {
  failureThreshold: 3,
  failureWindowMs: 300_000,
  cooldownMs: 60_000,
};

const T0 = "2026-07-22T12:00:00.000Z";
const T0_MS = Date.parse(T0);

/** ISO timestamp offset from T0 by the given milliseconds. */
function at(offsetMs: number): string {
  return new Date(T0_MS + offsetMs).toISOString();
}

const ORIGIN = "http://lidarr.local:8686";

const UNREACHABLE = { code: "lidarr-unreachable", retryable: true } as const;
const TIMEOUT = { code: "timeout", retryable: true } as const;

function closedWith(recentFailures: readonly string[]): CircuitState {
  return { state: "closed", recentFailures };
}

describe("evaluateCircuit", () => {
  it("allows closed circuits without probing and without a state change", () => {
    const state = closedWith([at(-1_000)]);

    const decision = evaluateCircuit(state, POLICY, at(0));

    expect(decision).toEqual({ allowed: true, probe: false, next: state });
  });

  it.each([
    ["immediately after opening", 0, 60_000],
    ["mid-cooldown", 30_000, 30_000],
    ["one millisecond before expiry", 59_999, 1],
  ])("rejects while open %s with the remaining cooldown", (_label, elapsedMs, remainingMs) => {
    const state: CircuitState = {
      state: "open",
      openedAt: at(0),
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    };

    const decision = evaluateCircuit(state, POLICY, at(elapsedMs));

    expect(decision).toEqual({
      allowed: false,
      next: state,
      retryAtIso: at(60_000),
      retryAfterMs: remainingMs,
      reason: "lidarr-unreachable",
    });
  });

  it.each([
    ["exactly at cooldown expiry", 60_000],
    ["after cooldown expiry", 90_000],
  ])("transitions open to half-open %s, making this call the probe", (_label, elapsedMs) => {
    const state: CircuitState = {
      state: "open",
      openedAt: at(0),
      cooldownMs: 60_000,
      reason: "timeout",
    };

    const decision = evaluateCircuit(state, POLICY, at(elapsedMs));

    expect(decision).toEqual({
      allowed: true,
      probe: true,
      next: { state: "half-open", probeStartedAt: at(elapsedMs), reason: "timeout" },
    });
  });

  it.each([
    ["just started", 0],
    ["mid-window", 60_000],
    ["exactly at the probe timeout", HALF_OPEN_PROBE_TIMEOUT_MS],
  ])("rejects half-open when the probe is %s (presumed in flight)", (_label, elapsedMs) => {
    const state: CircuitState = {
      state: "half-open",
      probeStartedAt: at(0),
      reason: "lidarr-unreachable",
    };

    const decision = evaluateCircuit(state, POLICY, at(elapsedMs));

    expect(decision).toEqual({
      allowed: false,
      next: state,
      retryAtIso: at(HALF_OPEN_PROBE_TIMEOUT_MS),
      retryAfterMs: HALF_OPEN_PROBE_TIMEOUT_MS - elapsedMs,
      reason: "lidarr-unreachable",
    });
  });

  it("self-heals a crashed probe: past the timeout this call becomes a fresh probe", () => {
    const state: CircuitState = {
      state: "half-open",
      probeStartedAt: at(0),
      reason: "lidarr-unreachable",
    };
    const nowIso = at(HALF_OPEN_PROBE_TIMEOUT_MS + 1);

    const decision = evaluateCircuit(state, POLICY, nowIso);

    expect(decision).toEqual({
      allowed: true,
      probe: true,
      next: { state: "half-open", probeStartedAt: nowIso, reason: "lidarr-unreachable" },
    });
  });
});

describe("recordCircuitFailure", () => {
  it.each([
    ["first failure stays closed", closedWith([]), 0, closedWith([at(0)])],
    [
      "second failure within the window stays closed",
      closedWith([at(-60_000)]),
      0,
      closedWith([at(-60_000), at(0)]),
    ],
    [
      "third failure within the window trips to open",
      closedWith([at(-120_000), at(-60_000)]),
      0,
      { state: "open", openedAt: at(0), cooldownMs: 60_000, reason: "lidarr-unreachable" },
    ],
    [
      "failures older than the window are pruned before counting",
      closedWith([at(-360_000), at(-330_000)]),
      0,
      closedWith([at(0)]),
    ],
    [
      "a failure exactly failureWindowMs old is pruned",
      closedWith([at(-300_000), at(-60_000)]),
      0,
      closedWith([at(-60_000), at(0)]),
    ],
  ] as const)("%s", (_label, state, nowOffsetMs, expected) => {
    const next = recordCircuitFailure(state, UNREACHABLE, POLICY, at(nowOffsetMs));

    expect(next).toEqual(expected);
  });

  it("never trips on 3 failures spread over 3 weeks (windowed counting regression)", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    let state: CircuitState = closedWith([]);

    state = recordCircuitFailure(state, UNREACHABLE, POLICY, at(0));
    state = recordCircuitFailure(state, UNREACHABLE, POLICY, at(week));
    state = recordCircuitFailure(state, UNREACHABLE, POLICY, at(2 * week));

    expect(state).toEqual(closedWith([at(2 * week)]));
  });

  it("honors Retry-After as a cooldown floor when tripping", () => {
    const state = closedWith([at(-2_000), at(-1_000)]);
    const rateLimitedUnreachable = {
      code: "lidarr-unreachable",
      retryable: true,
      retryAfterSeconds: 300,
    } as const;

    const next = recordCircuitFailure(state, rateLimitedUnreachable, POLICY, at(0));

    expect(next).toEqual({
      state: "open",
      openedAt: at(0),
      cooldownMs: 300_000,
      reason: "lidarr-unreachable",
    });
  });

  it("keeps the configured cooldown when Retry-After is below it", () => {
    const state = closedWith([at(-2_000), at(-1_000)]);
    const hintedError = { code: "timeout", retryable: true, retryAfterSeconds: 10 } as const;

    const next = recordCircuitFailure(state, hintedError, POLICY, at(0));

    expect(next).toEqual({ state: "open", openedAt: at(0), cooldownMs: 60_000, reason: "timeout" });
  });

  it("re-opens with a fresh openedAt when a half-open probe fails", () => {
    const state: CircuitState = {
      state: "half-open",
      probeStartedAt: at(-5_000),
      reason: "lidarr-unreachable",
    };

    const next = recordCircuitFailure(state, TIMEOUT, POLICY, at(0));

    expect(next).toEqual({ state: "open", openedAt: at(0), cooldownMs: 60_000, reason: "timeout" });
  });

  it("leaves an open circuit unchanged (identity)", () => {
    const state: CircuitState = {
      state: "open",
      openedAt: at(-10_000),
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    };

    const next = recordCircuitFailure(state, UNREACHABLE, POLICY, at(0));

    expect(next).toBe(state);
  });
});

describe("recordCircuitSuccess", () => {
  it.each([
    ["closed with failures", closedWith([at(-1_000), at(-500)])],
    ["open", { state: "open", openedAt: at(-10_000), cooldownMs: 60_000, reason: "timeout" }],
    ["half-open", { state: "half-open", probeStartedAt: at(-1_000), reason: "timeout" }],
  ] as const satisfies readonly (readonly [string, CircuitState])[])(
    "collapses %s to closed with an empty window",
    (_label, state) => {
      expect(recordCircuitSuccess(state)).toEqual(closedWith([]));
    },
  );
});

describe("CircuitState exhaustiveness", () => {
  it("covers every union arm with a compile-time never check", () => {
    const describeState = (state: CircuitState): string => {
      switch (state.state) {
        case "closed":
          return `closed(${state.recentFailures.length})`;
        case "open":
          return `open(${state.reason})`;
        case "half-open":
          return `half-open(${state.reason})`;
        default: {
          const exhaustive: never = state;
          throw new Error(`Unhandled circuit state: ${String(exhaustive)}`);
        }
      }
    };

    expect(describeState(closedWith([]))).toBe("closed(0)");
    expect(
      describeState({ state: "open", openedAt: at(0), cooldownMs: 1, reason: "timeout" }),
    ).toBe("open(timeout)");
    expect(describeState({ state: "half-open", probeStartedAt: at(0), reason: "timeout" })).toBe(
      "half-open(timeout)",
    );
  });
});

describe("createSqliteCircuitStore", () => {
  let tempDir: string;
  let db: DbConnection;
  let store: CircuitStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-circuit-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
    store = createSqliteCircuitStore(db);
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads a missing row as the closed state", () => {
    expect(store.load(ORIGIN, "lidarr")).toEqual(closedWith([]));
  });

  it("round-trips each state shape per scope independently", () => {
    const openState: CircuitState = {
      state: "open",
      openedAt: at(0),
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    };
    const halfOpenState: CircuitState = {
      state: "half-open",
      probeStartedAt: at(1_000),
      reason: "metadata-provider-unavailable",
    };

    store.save(ORIGIN, "lidarr", openState);
    store.save(ORIGIN, "metadata", halfOpenState);

    expect(store.load(ORIGIN, "lidarr")).toEqual(openState);
    expect(store.load(ORIGIN, "metadata")).toEqual(halfOpenState);
  });

  it("upserts a single row per origin/scope and keeps the summary column in sync", () => {
    store.save(ORIGIN, "lidarr", closedWith([at(-1_000)]));
    store.save(ORIGIN, "lidarr", {
      state: "open",
      openedAt: at(0),
      cooldownMs: 60_000,
      reason: "timeout",
    });

    const rows = db
      .prepare("SELECT state FROM lidarr_circuit_state WHERE origin = ? AND scope = ?")
      .all(ORIGIN, "lidarr") as { state: string }[];

    expect(rows).toEqual([{ state: "open" }]);
    expect(store.load(ORIGIN, "lidarr")).toEqual({
      state: "open",
      openedAt: at(0),
      cooldownMs: 60_000,
      reason: "timeout",
    });
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["valid JSON that is not a CircuitState", JSON.stringify({ state: "exploded" })],
    [
      "closed state with non-string failures",
      JSON.stringify({ state: "closed", recentFailures: [42] }),
    ],
    [
      "open state with an unknown reason",
      JSON.stringify({ state: "open", openedAt: T0, cooldownMs: 1, reason: "bogus" }),
    ],
  ])("throws on malformed state_json (%s)", (_label, stateJson) => {
    db.prepare(
      `INSERT INTO lidarr_circuit_state (origin, scope, state, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ORIGIN, "lidarr", "closed", stateJson, T0);

    expect(() => store.load(ORIGIN, "lidarr")).toThrow(/Malformed circuit state JSON/);
  });
});

describe("createCircuitBreaker", () => {
  function createSpyStore(initial?: CircuitState): {
    store: CircuitStore;
    load: ReturnType<typeof vi.fn<CircuitStore["load"]>>;
    save: ReturnType<typeof vi.fn<CircuitStore["save"]>>;
  } {
    let current: CircuitState = initial ?? closedWith([]);
    const load = vi.fn<CircuitStore["load"]>(() => current);
    const save = vi.fn<CircuitStore["save"]>((_origin, _scope, state) => {
      current = state;
    });
    return { store: { load, save }, load, save };
  }

  function breakerAt(
    store: CircuitStore,
    scope: CircuitScope,
    nowIso: string,
  ): ReturnType<typeof createCircuitBreaker> {
    return createCircuitBreaker({
      store,
      origin: ORIGIN,
      scope,
      policy: POLICY,
      now: () => new Date(nowIso),
    });
  }

  it("gate() persists the half-open probe claim before returning", () => {
    const { store, save } = createSpyStore({
      state: "open",
      openedAt: at(0),
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
    const breaker = breakerAt(store, "lidarr", at(60_000));

    const decision = breaker.gate();

    expect(decision).toMatchObject({ allowed: true, probe: true });
    expect(save).toHaveBeenCalledExactlyOnceWith(ORIGIN, "lidarr", {
      state: "half-open",
      probeStartedAt: at(60_000),
      reason: "lidarr-unreachable",
    });
  });

  it("gate() does not write when the state is unchanged", () => {
    const { store, save } = createSpyStore(closedWith([at(-1_000)]));
    const breaker = breakerAt(store, "lidarr", at(0));

    const decision = breaker.gate();

    expect(decision.allowed).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("recordSuccess() writes only when the state actually changes", () => {
    const { store, save } = createSpyStore(closedWith([]));
    const breaker = breakerAt(store, "lidarr", at(0));

    breaker.recordSuccess();
    expect(save).not.toHaveBeenCalled();

    breaker.recordFailure(new LidarrUnreachableError("lidarr list artists"));
    breaker.recordSuccess();
    expect(save).toHaveBeenLastCalledWith(ORIGIN, "lidarr", closedWith([]));
  });

  it("recordFailure() is a no-op for codes that do not feed this scope", () => {
    const { store, load, save } = createSpyStore();
    const breaker = breakerAt(store, "lidarr", at(0));

    breaker.recordFailure(new RateLimitedError("lidarr list artists", 30));
    breaker.recordFailure(new MetadataProviderUnavailableError("lidarr wanted missing"));

    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(breaker.getState()).toEqual(closedWith([]));
  });

  it("recordFailure() feeds the metadata scope from metadata-provider-unavailable", () => {
    const { store, save } = createSpyStore();
    const breaker = breakerAt(store, "metadata", at(0));

    breaker.recordFailure(new MetadataProviderUnavailableError("lidarr wanted missing"));

    expect(save).toHaveBeenCalledExactlyOnceWith(ORIGIN, "metadata", closedWith([at(0)]));
  });

  it("shares persisted state across handles: trip, reject, probe, recover", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-circuit-test-"));
    const db = await initializeDatabase(join(tempDir, "test.db"));
    try {
      const store = createSqliteCircuitStore(db);

      const first = breakerAt(store, "lidarr", at(0));
      first.recordFailure(new LidarrUnreachableError("lidarr list artists"));
      first.recordFailure(new LidarrUnreachableError("lidarr list artists"));
      first.recordFailure(new LidarrUnreachableError("lidarr list artists"));

      // A second CLI invocation sees the tripped circuit.
      const second = breakerAt(store, "lidarr", at(30_000));
      const rejected = second.gate();
      expect(rejected).toEqual({
        allowed: false,
        next: { state: "open", openedAt: at(0), cooldownMs: 60_000, reason: "lidarr-unreachable" },
        retryAtIso: at(60_000),
        retryAfterMs: 30_000,
        reason: "lidarr-unreachable",
      });

      // After cooldown, the next invocation becomes the probe and recovery closes it.
      const third = breakerAt(store, "lidarr", at(61_000));
      expect(third.gate()).toMatchObject({ allowed: true, probe: true });
      expect(third.getState()).toEqual({
        state: "half-open",
        probeStartedAt: at(61_000),
        reason: "lidarr-unreachable",
      });
      third.recordSuccess();
      expect(third.getState()).toEqual(closedWith([]));
    } finally {
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
