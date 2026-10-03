import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedLidarrConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
}));

vi.mock("../loaded-config.js", () => ({
  getLoadedLidarrConfig: mockLoadedConfig.getLoadedLidarrConfig,
}));

import {
  detectMetadataProviderOutage,
  ensureTierHealthy,
  readLidarrResilienceSnapshot,
  runHealthProbe,
} from "./health.js";
import {
  createCircuitBreaker,
  createSqliteCircuitStore,
  HALF_OPEN_PROBE_TIMEOUT_MS,
} from "./circuit-breaker.js";
import type {
  CircuitDecision,
  CircuitPolicy,
  CircuitScope,
  CircuitState,
  CircuitStore,
  LidarrCircuitBreaker,
} from "./circuit-breaker.js";
import {
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  MetadataProviderUnavailableError,
} from "./errors.js";
import type { LidarrError, LidarrErrorCode } from "./errors.js";
import { initializeDatabase } from "../db.js";
import type { DbConnection } from "../../types/db.js";
import { createLidarrClientMock } from "../../actions/test-helpers/lidarr-client-mocks.js";
import { createLidarrHealthCheckFixture } from "../../actions/test-helpers/lidarr-fixtures.js";

const TEST_ORIGIN = "http://localhost:8686";
const NOW_ISO = "2026-07-22T00:00:00.000Z";

const CLOSED: CircuitState = { state: "closed", recentFailures: [] };
const ALLOW: CircuitDecision = { allowed: true, probe: false, next: CLOSED };

const POLICY: CircuitPolicy = {
  failureThreshold: 3,
  failureWindowMs: 300_000,
  cooldownMs: 60_000,
};

/** Builds the rejected arm of a gate decision with a fixed retry window. */
function rejectDecision(
  retryAfterMs: number,
  reason: LidarrErrorCode = "lidarr-unreachable",
): CircuitDecision {
  return {
    allowed: false,
    next: { state: "open", openedAt: NOW_ISO, cooldownMs: 60_000, reason },
    retryAtIso: new Date(Date.parse(NOW_ISO) + retryAfterMs).toISOString(),
    retryAfterMs,
    reason,
  };
}

/** Fully-mocked breaker handle satisfying the `LidarrCircuitBreaker` shape. */
interface BreakerStub {
  readonly origin: string;
  readonly scope: CircuitScope;
  readonly gate: Mock<() => CircuitDecision>;
  readonly recordSuccess: Mock<() => void>;
  readonly recordFailure: Mock<(error: LidarrError) => void>;
  readonly getState: Mock<() => CircuitState>;
}

function createBreakerStub(
  scope: CircuitScope,
  decision: CircuitDecision = ALLOW,
  order?: string[],
): BreakerStub {
  return {
    origin: TEST_ORIGIN,
    scope,
    gate: vi.fn<() => CircuitDecision>(() => {
      order?.push(`gate:${scope}`);
      return decision;
    }),
    recordSuccess: vi.fn<() => void>(),
    recordFailure: vi.fn<(error: LidarrError) => void>(),
    getState: vi.fn<() => CircuitState>(() => CLOSED),
  };
}

/** Pure in-memory `CircuitStore` for breaker-backed gate tests. */
function createMemoryStore(): CircuitStore {
  const rows = new Map<string, CircuitState>();
  return {
    load: (origin, scope) => rows.get(`${origin}::${scope}`) ?? CLOSED,
    save: (origin, scope, state) => {
      rows.set(`${origin}::${scope}`, state);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadedConfig.getLoadedLidarrConfig.mockReturnValue({});
});

describe("detectMetadataProviderOutage", () => {
  it.each([
    ["an error check with a metadata source", "MetadataUpdateCheck", "provider request failed"],
    ["an error check mentioning SkyHook", "ImportListStatusCheck", "Unable to reach SkyHook"],
    [
      "an error check mentioning api.lidarr.audio",
      "ImportListStatusCheck",
      "api.lidarr.audio is unavailable",
    ],
    ["a case-insensitive METADATA match", "METADATASOURCECHECK", "provider request failed"],
  ])("matches %s", (_label, source, message) => {
    const check = createLidarrHealthCheckFixture({ source, message, type: "error" });
    expect(detectMetadataProviderOutage([check])).toEqual([check]);
  });

  it.each([
    [
      "an unrelated error check",
      createLidarrHealthCheckFixture({
        source: "DownloadClientCheck",
        message: "Unable to communicate with qBittorrent",
        type: "error",
      }),
    ],
    [
      "a warning-level check with a matching source",
      createLidarrHealthCheckFixture({ source: "MetadataUpdateCheck", type: "warning" }),
    ],
    [
      "an ok-level check with a matching message",
      createLidarrHealthCheckFixture({ message: "SkyHook reachable", type: "ok" }),
    ],
  ])("does not match %s", (_label, check) => {
    expect(detectMetadataProviderOutage([check])).toEqual([]);
  });

  it("returns an empty array for an empty check list", () => {
    expect(detectMetadataProviderOutage([])).toEqual([]);
  });
});

describe("runHealthProbe", () => {
  it("classifies an empty check list as healthy", async () => {
    const client = createLidarrClientMock();
    const report = await runHealthProbe(client);
    expect(report.status).toBe("healthy");
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.metadataProvider).toEqual({ available: true, failingChecks: [] });
    expect(Number.isFinite(Date.parse(report.checkedAt))).toBe(true);
  });

  it("splits errors from warnings and classifies degraded on error-level checks", async () => {
    const errorCheck = createLidarrHealthCheckFixture({
      source: "DownloadClientCheck",
      message: "Unable to communicate with qBittorrent",
      type: "error",
    });
    const warningCheck = createLidarrHealthCheckFixture({ type: "warning" });
    const okCheck = createLidarrHealthCheckFixture({ type: "ok" });
    const client = createLidarrClientMock({
      getHealth: () => Promise.resolve([okCheck, warningCheck, errorCheck]),
    });
    const report = await runHealthProbe(client);
    expect(report.status).toBe("degraded");
    expect(report.errors).toEqual([errorCheck]);
    expect(report.warnings).toEqual([warningCheck]);
    expect(report.metadataProvider.available).toBe(true);
  });

  it("keeps warning-only reports healthy", async () => {
    const warningCheck = createLidarrHealthCheckFixture({ type: "warning" });
    const client = createLidarrClientMock({ getHealth: () => Promise.resolve([warningCheck]) });
    const report = await runHealthProbe(client);
    expect(report.status).toBe("healthy");
    expect(report.warnings).toEqual([warningCheck]);
  });

  it("flags a metadata-provider outage from matching error checks", async () => {
    const outageCheck = createLidarrHealthCheckFixture({
      source: "MetadataUpdateCheck",
      message: "api.lidarr.audio is unavailable",
      type: "error",
    });
    const client = createLidarrClientMock({ getHealth: () => Promise.resolve([outageCheck]) });
    const report = await runHealthProbe(client);
    expect(report.status).toBe("degraded");
    expect(report.metadataProvider).toEqual({ available: false, failingChecks: [outageCheck] });
  });

  it.each([
    ["lidarr-unreachable", new LidarrUnreachableError("lidarr health")],
    ["timeout", new LidarrTimeoutError("lidarr health")],
  ])("classifies a %s probe failure as unreachable", async (_code, error) => {
    const client = createLidarrClientMock({ getHealth: () => Promise.reject(error) });
    const report = await runHealthProbe(client);
    expect(report.status).toBe("unreachable");
    expect(report.errors).toEqual([]);
    expect(report.metadataProvider).toEqual({ available: true, failingChecks: [] });
  });

  it("propagates non-transport LidarrErrors unchanged", async () => {
    const error = new LidarrValidationError("lidarr health", "bad payload", "invalid-response");
    const client = createLidarrClientMock({ getHealth: () => Promise.reject(error) });
    await expect(runHealthProbe(client)).rejects.toBe(error);
  });

  it("propagates unknown errors unchanged", async () => {
    const error = new Error("boom");
    const client = createLidarrClientMock({ getHealth: () => Promise.reject(error) });
    await expect(runHealthProbe(client)).rejects.toBe(error);
  });

  it("forwards the abort signal to the health request", async () => {
    const client = createLidarrClientMock();
    const controller = new AbortController();
    await runHealthProbe(client, controller.signal);
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    expect(client.getHealth).toHaveBeenCalledWith(controller.signal);
  });
});

describe("ensureTierHealthy", () => {
  it.each(["local-only", "discovery", "destructive"] as const)(
    "returns immediately with zero I/O for ungated tier %s",
    async (tier) => {
      const client = createLidarrClientMock();
      const lidarr = createBreakerStub("lidarr");
      const metadata = createBreakerStub("metadata");

      await expect(ensureTierHealthy(client, tier, { lidarr, metadata })).resolves.toBeUndefined();

      expect(client.getHealth).not.toHaveBeenCalled();
      expect(client.getSystemStatus).not.toHaveBeenCalled();
      expect(client.listArtists).not.toHaveBeenCalled();
      expect(client.getWantedMissing).not.toHaveBeenCalled();
      expect(lidarr.gate).not.toHaveBeenCalled();
      expect(metadata.gate).not.toHaveBeenCalled();
    },
  );

  it("gates lidarr, then metadata, then runs a fresh probe for metadata-dependent", async () => {
    const order: string[] = [];
    const client = createLidarrClientMock({
      getHealth: () => {
        order.push("probe");
        return Promise.resolve([]);
      },
    });
    const lidarr = createBreakerStub("lidarr", ALLOW, order);
    const metadata = createBreakerStub("metadata", ALLOW, order);

    const report = await ensureTierHealthy(client, "metadata-dependent", { lidarr, metadata });

    expect(order).toEqual(["gate:lidarr", "gate:metadata", "probe"]);
    expect(report?.status).toBe("healthy");
    // A passing probe closes any half-open claim on both gated scopes.
    expect(lidarr.recordSuccess).toHaveBeenCalledTimes(1);
    expect(metadata.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("runs a fresh probe on every call — results are never cached", async () => {
    const client = createLidarrClientMock();
    const breakers = {
      lidarr: createBreakerStub("lidarr"),
      metadata: createBreakerStub("metadata"),
    };

    await ensureTierHealthy(client, "metadata-dependent", breakers);
    await ensureTierHealthy(client, "metadata-dependent", breakers);

    expect(client.getHealth).toHaveBeenCalledTimes(2);
    expect(breakers.lidarr.gate).toHaveBeenCalledTimes(2);
    expect(breakers.metadata.gate).toHaveBeenCalledTimes(2);
  });

  it("throws LidarrUnreachableError with zero network I/O when the lidarr circuit rejects", async () => {
    const client = createLidarrClientMock();
    const lidarr = createBreakerStub("lidarr", rejectDecision(60_000));
    const metadata = createBreakerStub("metadata");

    let caught: unknown;
    try {
      await ensureTierHealthy(client, "metadata-dependent", { lidarr, metadata });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LidarrUnreachableError);
    expect((caught as LidarrUnreachableError).retryAfterSeconds).toBe(60);
    expect(client.getHealth).not.toHaveBeenCalled();
    expect(metadata.gate).not.toHaveBeenCalled();
    // A circuit-open rejection is not a probe outcome — it never feeds the breaker.
    expect(lidarr.recordFailure).not.toHaveBeenCalled();
    expect(metadata.recordFailure).not.toHaveBeenCalled();
  });

  it("throws MetadataProviderUnavailableError with a ceiled retry when the metadata circuit rejects", async () => {
    const client = createLidarrClientMock();
    const lidarr = createBreakerStub("lidarr");
    const metadata = createBreakerStub(
      "metadata",
      rejectDecision(30_500, "metadata-provider-unavailable"),
    );

    let caught: unknown;
    try {
      await ensureTierHealthy(client, "metadata-dependent", { lidarr, metadata });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MetadataProviderUnavailableError);
    expect((caught as MetadataProviderUnavailableError).retryAfterSeconds).toBe(31);
    expect(client.getHealth).not.toHaveBeenCalled();
    // A circuit-open rejection is not a probe outcome — it never feeds the breaker.
    expect(lidarr.recordFailure).not.toHaveBeenCalled();
    expect(metadata.recordFailure).not.toHaveBeenCalled();
  });

  it("rejects through a real open breaker built from the circuit-breaker module", async () => {
    const client = createLidarrClientMock();
    const store = createMemoryStore();
    store.save(TEST_ORIGIN, "lidarr", {
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
    const lidarr = createCircuitBreaker({
      store,
      origin: TEST_ORIGIN,
      scope: "lidarr",
      policy: POLICY,
      now: () => new Date(NOW_ISO),
    });
    const metadata = createBreakerStub("metadata");

    let caught: unknown;
    try {
      await ensureTierHealthy(client, "metadata-dependent", { lidarr, metadata });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LidarrUnreachableError);
    expect((caught as LidarrUnreachableError).retryAfterSeconds).toBe(60);
    expect(client.getHealth).not.toHaveBeenCalled();
  });

  it("throws LidarrUnreachableError when the probe finds the instance unreachable", async () => {
    const client = createLidarrClientMock({
      getHealth: () => Promise.reject(new LidarrUnreachableError("lidarr health")),
    });
    const breakers = {
      lidarr: createBreakerStub("lidarr"),
      metadata: createBreakerStub("metadata"),
    };

    await expect(ensureTierHealthy(client, "metadata-dependent", breakers)).rejects.toBeInstanceOf(
      LidarrUnreachableError,
    );
  });

  it("throws MetadataProviderUnavailableError when the outage detector matches", async () => {
    const outageCheck = createLidarrHealthCheckFixture({
      source: "MetadataUpdateCheck",
      message: "api.lidarr.audio is unavailable",
      type: "error",
    });
    const client = createLidarrClientMock({ getHealth: () => Promise.resolve([outageCheck]) });
    const breakers = {
      lidarr: createBreakerStub("lidarr"),
      metadata: createBreakerStub("metadata"),
    };

    let caught: unknown;
    try {
      await ensureTierHealthy(client, "metadata-dependent", breakers);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MetadataProviderUnavailableError);
    expect((caught as MetadataProviderUnavailableError).message).toContain("MetadataUpdateCheck");
  });

  it("returns the degraded report without throwing for non-metadata error checks", async () => {
    const errorCheck = createLidarrHealthCheckFixture({
      source: "DownloadClientCheck",
      message: "Unable to communicate with qBittorrent",
      type: "error",
    });
    const client = createLidarrClientMock({ getHealth: () => Promise.resolve([errorCheck]) });
    const breakers = {
      lidarr: createBreakerStub("lidarr"),
      metadata: createBreakerStub("metadata"),
    };

    const report = await ensureTierHealthy(client, "metadata-dependent", breakers);

    expect(report?.status).toBe("degraded");
    expect(report?.errors).toEqual([errorCheck]);
  });
});

describe("ensureTierHealthy breaker feed (real breakers)", () => {
  const OPEN_LIDARR: CircuitState = {
    state: "open",
    openedAt: NOW_ISO,
    cooldownMs: 60_000,
    reason: "lidarr-unreachable",
  };

  function unreachableClient(): ReturnType<typeof createLidarrClientMock> {
    return createLidarrClientMock({
      getHealth: () => Promise.reject(new LidarrUnreachableError("lidarr health")),
    });
  }

  function realBreakers(store: CircuitStore): {
    readonly lidarr: LidarrCircuitBreaker;
    readonly metadata: LidarrCircuitBreaker;
  } {
    const shared = {
      store,
      origin: TEST_ORIGIN,
      policy: POLICY,
      now: () => new Date(NOW_ISO),
    } as const;
    return {
      lidarr: createCircuitBreaker({ ...shared, scope: "lidarr" }),
      metadata: createCircuitBreaker({ ...shared, scope: "metadata" }),
    };
  }

  it("counts closed-state probe failures in the window and trips at the threshold", async () => {
    const client = unreachableClient();
    const store = createMemoryStore();
    const breakers = realBreakers(store);

    for (let call = 0; call < 2; call += 1) {
      await expect(
        ensureTierHealthy(client, "metadata-dependent", breakers),
      ).rejects.toBeInstanceOf(LidarrUnreachableError);
    }
    // Exactly one window entry per failed probe (no double feed).
    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual({
      state: "closed",
      recentFailures: [NOW_ISO, NOW_ISO],
    });

    await expect(ensureTierHealthy(client, "metadata-dependent", breakers)).rejects.toBeInstanceOf(
      LidarrUnreachableError,
    );

    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual(OPEN_LIDARR);
    // lidarr-unreachable does not feed the metadata scope.
    expect(store.load(TEST_ORIGIN, "metadata")).toEqual(CLOSED);
    expect(client.getHealth).toHaveBeenCalledTimes(3);
  });

  it("rejects while open without probing or recording a failure", async () => {
    const client = unreachableClient();
    const store = createMemoryStore();
    store.save(TEST_ORIGIN, "lidarr", OPEN_LIDARR);
    const breakers = realBreakers(store);

    await expect(ensureTierHealthy(client, "metadata-dependent", breakers)).rejects.toBeInstanceOf(
      LidarrUnreachableError,
    );

    expect(client.getHealth).not.toHaveBeenCalled();
    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual(OPEN_LIDARR);
  });

  it("re-opens with a fresh openedAt when the half-open probe fails — never wedged", async () => {
    const client = unreachableClient();
    const store = createMemoryStore();
    const staleOpenedAt = new Date(Date.parse(NOW_ISO) - 120_000).toISOString();
    store.save(TEST_ORIGIN, "lidarr", { ...OPEN_LIDARR, openedAt: staleOpenedAt });
    const breakers = realBreakers(store);

    await expect(ensureTierHealthy(client, "metadata-dependent", breakers)).rejects.toBeInstanceOf(
      LidarrUnreachableError,
    );

    // This call was the half-open probe; its failure re-opens the circuit
    // with a fresh openedAt (design §7d) instead of leaving it half-open
    // until HALF_OPEN_PROBE_TIMEOUT_MS.
    expect(client.getHealth).toHaveBeenCalledTimes(1);
    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual(OPEN_LIDARR);
  });

  it("closes the circuit when the post-cooldown probe passes", async () => {
    const client = createLidarrClientMock();
    const store = createMemoryStore();
    const staleOpenedAt = new Date(Date.parse(NOW_ISO) - 120_000).toISOString();
    store.save(TEST_ORIGIN, "lidarr", { ...OPEN_LIDARR, openedAt: staleOpenedAt });
    const breakers = realBreakers(store);

    const report = await ensureTierHealthy(client, "metadata-dependent", breakers);

    expect(report?.status).toBe("healthy");
    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual(CLOSED);
    expect(store.load(TEST_ORIGIN, "metadata")).toEqual(CLOSED);
  });

  it("feeds a detected provider outage to the metadata scope only", async () => {
    const outageCheck = createLidarrHealthCheckFixture({
      source: "MetadataUpdateCheck",
      message: "api.lidarr.audio is unavailable",
      type: "error",
    });
    const client = createLidarrClientMock({ getHealth: () => Promise.resolve([outageCheck]) });
    const store = createMemoryStore();
    const breakers = realBreakers(store);

    await expect(ensureTierHealthy(client, "metadata-dependent", breakers)).rejects.toBeInstanceOf(
      MetadataProviderUnavailableError,
    );

    expect(store.load(TEST_ORIGIN, "metadata")).toEqual({
      state: "closed",
      recentFailures: [NOW_ISO],
    });
    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual(CLOSED);
  });

  it("records nothing for probe errors that feed no circuit scope", async () => {
    const error = new LidarrValidationError("lidarr health", "bad payload", "invalid-response");
    const client = createLidarrClientMock({ getHealth: () => Promise.reject(error) });
    const store = createMemoryStore();
    const breakers = realBreakers(store);

    await expect(ensureTierHealthy(client, "metadata-dependent", breakers)).rejects.toBe(error);

    expect(store.load(TEST_ORIGIN, "lidarr")).toEqual(CLOSED);
    expect(store.load(TEST_ORIGIN, "metadata")).toEqual(CLOSED);
  });
});

describe("readLidarrResilienceSnapshot", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-health-test-"));
    dbPath = join(tempDir, "test.db");
    mockLoadedConfig.getLoadedLidarrConfig.mockReturnValue({
      baseUrl: TEST_ORIGIN,
      apiKey: "secret-api-key",
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedIntent(
    db: DbConnection,
    id: string,
    status: "pending" | "failed",
    origin: string = TEST_ORIGIN,
  ): void {
    db.prepare(
      `INSERT INTO lidarr_deferred_intents
         (id, origin, operation, tier, payload_json, idempotency_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      origin,
      "lidarr add artist",
      "metadata-dependent",
      "{}",
      `key-${id}`,
      status,
      NOW_ISO,
      NOW_ISO,
    );
  }

  it("reads circuit state and deferred-intent counts from the tracking database", async () => {
    const seedDb = await initializeDatabase(dbPath);
    createSqliteCircuitStore(seedDb).save(TEST_ORIGIN, "lidarr", {
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
    seedIntent(seedDb, "intent-1", "pending");
    seedIntent(seedDb, "intent-2", "pending");
    seedIntent(seedDb, "intent-3", "failed");
    seedDb.close();

    const openDb = vi.fn(() => initializeDatabase(dbPath));
    const snapshot = await readLidarrResilienceSnapshot(undefined, { openDb });

    expect(openDb).toHaveBeenCalledTimes(1);
    expect(snapshot.circuits).toHaveLength(2);
    const lidarrEntry = snapshot.circuits.find((entry) => entry.scope === "lidarr");
    expect(lidarrEntry?.state).toEqual({
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
    expect(lidarrEntry?.retryAtIso).toBe(new Date(Date.parse(NOW_ISO) + 60_000).toISOString());
    const metadataEntry = snapshot.circuits.find((entry) => entry.scope === "metadata");
    expect(metadataEntry?.state).toEqual({ state: "closed", recentFailures: [] });
    expect(metadataEntry?.retryAtIso).toBeUndefined();
    expect(snapshot.deferredIntents).toEqual({ pending: 2, failed: 1 });
  });

  it("derives retryAtIso for a persisted half-open circuit from the probe timeout", async () => {
    const seedDb = await initializeDatabase(dbPath);
    createSqliteCircuitStore(seedDb).save(TEST_ORIGIN, "metadata", {
      state: "half-open",
      probeStartedAt: NOW_ISO,
      reason: "metadata-provider-unavailable",
    });
    seedDb.close();

    const snapshot = await readLidarrResilienceSnapshot(undefined, {
      openDb: () => initializeDatabase(dbPath),
    });

    const metadataEntry = snapshot.circuits.find((entry) => entry.scope === "metadata");
    expect(metadataEntry?.state).toEqual({
      state: "half-open",
      probeStartedAt: NOW_ISO,
      reason: "metadata-provider-unavailable",
    });
    expect(metadataEntry?.retryAtIso).toBe(
      new Date(Date.parse(NOW_ISO) + HALF_OPEN_PROBE_TIMEOUT_MS).toISOString(),
    );
  });

  it("scopes deferred-intent counts to the resolved origin", async () => {
    const seedDb = await initializeDatabase(dbPath);
    seedIntent(seedDb, "intent-mine", "pending");
    seedIntent(seedDb, "intent-other-1", "pending", "http://other-host:8686");
    seedIntent(seedDb, "intent-other-2", "failed", "http://other-host:8686");
    seedDb.close();

    const snapshot = await readLidarrResilienceSnapshot(undefined, {
      openDb: () => initializeDatabase(dbPath),
    });

    expect(snapshot.deferredIntents).toEqual({ pending: 1, failed: 0 });
  });

  it("prefers CLI overrides and normalizes the base URL to its canonical origin", async () => {
    mockLoadedConfig.getLoadedLidarrConfig.mockReturnValue({});
    const overrideOrigin = "http://other-host:8686";
    const seedDb = await initializeDatabase(dbPath);
    createSqliteCircuitStore(seedDb).save(overrideOrigin, "lidarr", {
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "timeout",
    });
    seedDb.close();

    const snapshot = await readLidarrResilienceSnapshot(
      { lidarrUrl: `${overrideOrigin}/`, lidarrApiKey: "override-key" },
      { openDb: () => initializeDatabase(dbPath) },
    );

    const lidarrEntry = snapshot.circuits.find((entry) => entry.scope === "lidarr");
    expect(lidarrEntry?.state).toEqual({
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "timeout",
    });
  });

  it("reports every circuit as unknown when the database cannot be opened", async () => {
    const openDb = vi.fn(() => Promise.reject(new Error("disk exploded")));

    const snapshot = await readLidarrResilienceSnapshot(undefined, { openDb });

    expect(snapshot.circuits).toEqual([
      {
        scope: "lidarr",
        state: { state: "unknown", reason: expect.stringContaining("disk exploded") as string },
      },
      {
        scope: "metadata",
        state: { state: "unknown", reason: expect.stringContaining("disk exploded") as string },
      },
    ]);
    expect(snapshot.deferredIntents).toEqual({ pending: 0, failed: 0 });
  });

  it("reports unknown without touching the database when no origin can be resolved", async () => {
    mockLoadedConfig.getLoadedLidarrConfig.mockReturnValue({});
    const openDb = vi.fn(() => initializeDatabase(dbPath));

    const snapshot = await readLidarrResilienceSnapshot(undefined, { openDb });

    expect(openDb).not.toHaveBeenCalled();
    for (const entry of snapshot.circuits) {
      expect(entry.state).toEqual({
        state: "unknown",
        reason: expect.stringContaining("not configured") as string,
      });
    }
  });

  it("isolates a malformed persisted state to its own scope", async () => {
    const seedDb = await initializeDatabase(dbPath);
    seedDb
      .prepare(
        `INSERT INTO lidarr_circuit_state (origin, scope, state, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(TEST_ORIGIN, "lidarr", "closed", "{not json", NOW_ISO);
    seedIntent(seedDb, "intent-1", "pending");
    seedDb.close();

    const snapshot = await readLidarrResilienceSnapshot(undefined, {
      openDb: () => initializeDatabase(dbPath),
    });

    const lidarrEntry = snapshot.circuits.find((entry) => entry.scope === "lidarr");
    expect(lidarrEntry?.state).toEqual({
      state: "unknown",
      reason: expect.stringContaining("Malformed circuit state") as string,
    });
    const metadataEntry = snapshot.circuits.find((entry) => entry.scope === "metadata");
    expect(metadataEntry?.state).toEqual({ state: "closed", recentFailures: [] });
    expect(snapshot.deferredIntents).toEqual({ pending: 1, failed: 0 });
  });

  it("never leaks the API key into the snapshot", async () => {
    const snapshot = await readLidarrResilienceSnapshot(undefined, {
      openDb: () => initializeDatabase(dbPath),
    });

    expect(inspect(snapshot)).not.toContain("secret-api-key");
  });
});
