import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLoadedLidarrConfig = vi.hoisted(() => vi.fn());
const mockCreateLidarrResilienceContext = vi.hoisted(() => vi.fn());
const mockCreateLidarrSchedulerPreflight = vi.hoisted(() => vi.fn());

vi.mock("../loaded-config.js", () => ({
  getLoadedLidarrConfig: mockGetLoadedLidarrConfig,
}));
vi.mock("../logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("./resilience.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resilience.js")>();
  mockCreateLidarrResilienceContext.mockImplementation(actual.createLidarrResilienceContext);
  return {
    ...actual,
    createLidarrResilienceContext: mockCreateLidarrResilienceContext,
  };
});
vi.mock("./scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scheduler.js")>();
  mockCreateLidarrSchedulerPreflight.mockImplementation(actual.createLidarrSchedulerPreflight);
  return {
    ...actual,
    createLidarrSchedulerPreflight: mockCreateLidarrSchedulerPreflight,
  };
});

import * as lidarrBarrel from "./index.js";
import {
  createLidarrClient,
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrExecutionContext,
  resolveRequiredLidarrOrigin,
  resolveRequiredLidarrOriginWithoutCredentials,
} from "./index.js";
import { LidarrClient, type LidarrClientApi } from "./client.js";
import { LidarrValidationError } from "./errors.js";
import type { LidarrResilienceContext, ScopedBreakers } from "./resilience.js";

function projectStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function createExecutionContextSeams(): {
  readonly context: LidarrResilienceContext;
  readonly client: LidarrClientApi;
  readonly breakers: ScopedBreakers;
  readonly getBreakers: ReturnType<typeof vi.fn>;
  readonly writeLookupCache: LidarrResilienceContext["writeLookupCache"];
  readonly tryServeStale: LidarrResilienceContext["tryServeStale"];
} {
  const client = Object.freeze({}) as LidarrClientApi;
  const breakers = Object.freeze({
    lidarr: Object.freeze({ scope: "lidarr" }),
    metadata: Object.freeze({ scope: "metadata" }),
  }) as ScopedBreakers;
  const getBreakers = vi.fn(async (): Promise<ScopedBreakers> => breakers);
  const writeLookupCache = vi.fn(async (): Promise<void> => undefined);
  const tryServeStale = vi.fn(async () => ({ served: false as const }));
  return {
    context: Object.freeze({
      client,
      getBreakers,
      writeLookupCache,
      tryServeStale: tryServeStale as LidarrResilienceContext["tryServeStale"],
    }),
    client,
    breakers,
    getBreakers,
    writeLookupCache,
    tryServeStale: tryServeStale as LidarrResilienceContext["tryServeStale"],
  };
}

/** Runs `fn` and returns whatever it throws, or `undefined` when it does not throw. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLoadedLidarrConfig.mockReturnValue({});
});

describe("resolveRequiredLidarrExecutionContext", () => {
  it("constructs one frozen credential-free context and preserves cache helpers", () => {
    const seams = createExecutionContextSeams();
    const callOptions = {
      tier: "metadata-dependent" as const,
      allowStale: true,
    };
    mockCreateLidarrResilienceContext.mockReturnValueOnce(seams.context);
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "super-secret",
      resilience: { retryAttempts: 4, cacheTtlSeconds: 321 },
    });

    const result = resolveRequiredLidarrExecutionContext(undefined, callOptions);

    expect(mockCreateLidarrResilienceContext).toHaveBeenCalledOnce();
    const [rawClient, origin, policy, passedCallOptions] =
      mockCreateLidarrResilienceContext.mock.calls[0] ?? [];
    expect(rawClient).toBeInstanceOf(LidarrClient);
    expect(origin).toBe("http://localhost:8686");
    expect(policy).toMatchObject({ retryAttempts: 4, cacheTtlSeconds: 321 });
    expect(passedCallOptions).toBe(callOptions);
    expect(result).toEqual({
      client: seams.client,
      preflight: expect.any(Function),
      writeLookupCache: seams.writeLookupCache,
      tryServeStale: seams.tryServeStale,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(seams.getBreakers).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(rawClient)).not.toContain("super-secret");
  });

  it("lazily builds one raw-client preflight with the exact shared breaker pair", async () => {
    const seams = createExecutionContextSeams();
    const runPreflight = vi.fn(async (): Promise<void> => undefined);
    mockCreateLidarrResilienceContext.mockReturnValueOnce(seams.context);
    mockCreateLidarrSchedulerPreflight.mockReturnValueOnce(runPreflight);
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
    });
    const result = resolveRequiredLidarrExecutionContext();
    const rawClient = mockCreateLidarrResilienceContext.mock.calls[0]?.[0];
    const controller = new AbortController();
    const preflightContext = {
      lane: "metadata-dependent" as const,
      signal: controller.signal,
    };

    expect(seams.getBreakers).not.toHaveBeenCalled();
    expect(mockCreateLidarrSchedulerPreflight).not.toHaveBeenCalled();

    await result.preflight(preflightContext);

    expect(seams.getBreakers).toHaveBeenCalledOnce();
    expect(mockCreateLidarrSchedulerPreflight).toHaveBeenCalledOnce();
    expect(mockCreateLidarrSchedulerPreflight).toHaveBeenCalledWith(rawClient, seams.breakers);
    expect(runPreflight).toHaveBeenCalledOnce();
    expect(runPreflight).toHaveBeenCalledWith(preflightContext);
  });

  it("forwards cancellation and preserves the exact preflight error", async () => {
    const seams = createExecutionContextSeams();
    const cancellation = new DOMException("cancelled", "AbortError");
    const controller = new AbortController();
    controller.abort(cancellation);
    const runPreflight = vi.fn(async ({ signal }: { signal?: AbortSignal }): Promise<void> => {
      throw signal?.reason;
    });
    mockCreateLidarrResilienceContext.mockReturnValueOnce(seams.context);
    mockCreateLidarrSchedulerPreflight.mockReturnValueOnce(runPreflight);
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
    });
    const result = resolveRequiredLidarrExecutionContext();

    await expect(
      result.preflight({ lane: "metadata-dependent", signal: controller.signal }),
    ).rejects.toBe(cancellation);
    expect(runPreflight).toHaveBeenCalledWith({
      lane: "metadata-dependent",
      signal: controller.signal,
    });
  });

  it("keeps the exact terminal fallback helper available after preflight failure", async () => {
    const seams = createExecutionContextSeams();
    const preflightError = new Error("metadata preflight failed");
    const cachedValue = Object.freeze(["cached"]);
    const staleResult = Object.freeze({ served: true as const, value: cachedValue });
    const tryServeStale = vi.fn(async () => staleResult);
    const context = Object.freeze({
      ...seams.context,
      tryServeStale: tryServeStale as LidarrResilienceContext["tryServeStale"],
    });
    mockCreateLidarrResilienceContext.mockReturnValueOnce(context);
    mockCreateLidarrSchedulerPreflight.mockReturnValueOnce(
      vi.fn(() => Promise.reject(preflightError)),
    );
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
    });
    const result = resolveRequiredLidarrExecutionContext(undefined, { allowStale: true });
    const staleOptions = {
      category: "lookup" as const,
      discriminator: "v1:search:digest",
      error: preflightError,
      validate: projectStringArray,
    };

    await expect(result.preflight({ lane: "metadata-dependent" })).rejects.toBe(preflightError);
    await expect(result.tryServeStale(staleOptions)).resolves.toBe(staleResult);
    expect(tryServeStale).toHaveBeenCalledWith(staleOptions);
  });

  it("retries lazy breaker initialization after an unchanged failure", async () => {
    const seams = createExecutionContextSeams();
    const initializationError = new Error("breaker database unavailable");
    const getBreakers = vi
      .fn<() => Promise<ScopedBreakers>>()
      .mockRejectedValueOnce(initializationError)
      .mockResolvedValueOnce(seams.breakers);
    const context = Object.freeze({ ...seams.context, getBreakers });
    const runPreflight = vi.fn(async (): Promise<void> => undefined);
    mockCreateLidarrResilienceContext.mockReturnValueOnce(context);
    mockCreateLidarrSchedulerPreflight.mockReturnValueOnce(runPreflight);
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
    });
    const result = resolveRequiredLidarrExecutionContext();

    await expect(result.preflight({ lane: "metadata-dependent" })).rejects.toBe(
      initializationError,
    );
    await expect(result.preflight({ lane: "metadata-dependent" })).resolves.toBeUndefined();

    expect(getBreakers).toHaveBeenCalledTimes(2);
    expect(runPreflight).toHaveBeenCalledOnce();
  });

  it("rejects missing and unsafe connection settings before context construction", () => {
    expect(() => resolveRequiredLidarrExecutionContext()).toThrow(LidarrValidationError);
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://user:secret@localhost:8686",
      apiKey: "k",
    });
    expect(() => resolveRequiredLidarrExecutionContext()).toThrow("Invalid Lidarr base URL");
    expect(mockCreateLidarrResilienceContext).not.toHaveBeenCalled();
  });
});

describe("resolveRequiredLidarrClient", () => {
  it("throws a configuration error when both base URL and API key are missing", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({});
    const error = captureThrow(() => resolveRequiredLidarrClient());
    expect(error).toBeInstanceOf(LidarrValidationError);
    expect((error as LidarrValidationError).code).toBe("configuration");
    expect((error as LidarrValidationError).message).toContain("required");
  });

  it("throws a configuration error when only the API key is missing", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({ baseUrl: "http://localhost:8686" });
    expect(() => resolveRequiredLidarrClient()).toThrow(LidarrValidationError);
  });

  it("throws a configuration error when only the base URL is missing", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({ apiKey: "k" });
    expect(() => resolveRequiredLidarrClient()).toThrow(LidarrValidationError);
  });

  it.each([
    ["embedded credentials", "http://user:pass@localhost:8686"],
    ["a path component", "http://localhost:8686/lidarr"],
    ["a query string", "http://localhost:8686/?x=1"],
    ["a fragment", "http://localhost:8686/#frag"],
    ["a non-http protocol", "ftp://localhost:8686"],
    ["an unparseable value", "not a url"],
  ])("rejects a base URL with %s", (_label, baseUrl) => {
    mockGetLoadedLidarrConfig.mockReturnValue({ baseUrl, apiKey: "k" });
    const error = captureThrow(() => resolveRequiredLidarrClient());
    expect(error).toBeInstanceOf(LidarrValidationError);
    expect((error as LidarrValidationError).code).toBe("configuration");
    expect((error as LidarrValidationError).message).toContain("Invalid Lidarr base URL");
  });

  it("returns a resilience-decorated client for a valid config", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({ baseUrl: "http://localhost:8686", apiKey: "k" });
    const client = resolveRequiredLidarrClient();

    // The decorator is a frozen plain object, not the concrete class.
    expect(client).not.toBeInstanceOf(LidarrClient);
    expect(Object.isFrozen(client)).toBe(true);
    expect(JSON.stringify(client)).toBe("{}");
    expect(typeof client.getSystemStatus).toBe("function");
    expect(typeof client.getHealth).toBe("function");
    expect(typeof client.listArtists).toBe("function");
    expect(typeof client.getWantedMissing).toBe("function");
  });

  it("remains a compatibility projection of the shared execution context", () => {
    const seams = createExecutionContextSeams();
    mockCreateLidarrResilienceContext.mockReturnValueOnce(seams.context);
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
    });

    expect(resolveRequiredLidarrClient()).toBe(seams.client);
    expect(mockCreateLidarrResilienceContext).toHaveBeenCalledOnce();
    expect(seams.getBreakers).not.toHaveBeenCalled();
  });

  it("accepts an optional resilience argument and defaults it when omitted", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({ baseUrl: "http://localhost:8686", apiKey: "k" });

    // Omitted second argument: defaults apply (local-only tier, no stale consent).
    expect(() => resolveRequiredLidarrClient()).not.toThrow();

    // Explicit second argument with every option populated.
    const onStaleServe = vi.fn();
    const client = resolveRequiredLidarrClient(undefined, {
      tier: "local-only",
      allowStale: true,
      onStaleServe,
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(JSON.stringify(client)).toBe("{}");
    // Construction alone never serves stale data or opens the database.
    expect(onStaleServe).not.toHaveBeenCalled();
  });

  it("resolves the policy from the loaded lidarr.resilience config", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
      resilience: { retryAttempts: 0, cacheTtlSeconds: 0 },
    });
    const client = resolveRequiredLidarrClient();
    expect(mockGetLoadedLidarrConfig).toHaveBeenCalled();
    expect(Object.isFrozen(client)).toBe(true);
  });

  it("throws unchanged when the config is missing even with a resilience argument", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({});
    const error = captureThrow(() => resolveRequiredLidarrClient(undefined, { allowStale: true }));
    expect(error).toBeInstanceOf(LidarrValidationError);
    expect((error as LidarrValidationError).code).toBe("configuration");
  });

  it("prefers CLI overrides over configured values", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://config:8686",
      apiKey: "config-key",
    });
    // Override just the URL; the API key still resolves from config.
    const overridden = resolveRequiredLidarrClient({ lidarrUrl: "http://override:8686" });
    expect(typeof overridden.listArtists).toBe("function");
    expect(Object.isFrozen(overridden)).toBe(true);

    // With no config at all, overrides alone are sufficient.
    mockGetLoadedLidarrConfig.mockReturnValue({});
    const fromOverrides = resolveRequiredLidarrClient({
      lidarrUrl: "http://override:8686",
      lidarrApiKey: "k",
    });
    expect(typeof fromOverrides.listArtists).toBe("function");
    expect(Object.isFrozen(fromOverrides)).toBe(true);
  });
});

describe("createLidarrClient", () => {
  it("returns undefined when the connection cannot be resolved", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({});
    expect(createLidarrClient()).toBeUndefined();
  });

  it("returns undefined for an unsafe base URL rather than throwing", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://user:pass@localhost:8686",
      apiKey: "k",
    });
    expect(createLidarrClient()).toBeUndefined();
  });

  it("constructs a client for a valid config, exercising the timeout branch", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
      apiKey: "k",
      timeoutMs: 5_000,
    });
    expect(createLidarrClient()).toBeInstanceOf(LidarrClient);
  });
});

describe("resolveRequiredLidarrOriginWithoutCredentials", () => {
  it("returns the canonical configured or overridden origin", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "https://configured.example:443/",
    });
    const overrides = { lidarrUrl: "http://override.example:8686/" };

    expect(resolveRequiredLidarrOriginWithoutCredentials()).toBe("https://configured.example");
    expect(resolveRequiredLidarrOriginWithoutCredentials(overrides)).toBe(
      "http://override.example:8686",
    );
  });

  it("rejects a missing URL with a typed configuration error", () => {
    const error = captureThrow(() => resolveRequiredLidarrOriginWithoutCredentials());

    expect(error).toBeInstanceOf(LidarrValidationError);
    expect((error as LidarrValidationError).code).toBe("configuration");
    expect((error as LidarrValidationError).message).toContain("base URL is required");
  });

  it.each([
    ["embedded credentials", "http://user:pass@localhost:8686"],
    ["a path component", "http://localhost:8686/lidarr"],
    ["a query string", "http://localhost:8686/?x=1"],
    ["a fragment", "http://localhost:8686/#frag"],
    ["a non-http protocol", "ftp://localhost:8686"],
    ["an unparseable value", "not a url"],
  ])("rejects %s", (_label, lidarrUrl) => {
    expect(() => resolveRequiredLidarrOriginWithoutCredentials({ lidarrUrl })).toThrow(
      "Invalid Lidarr base URL",
    );
  });

  it("resolves an offline origin without an API key while the online resolver still requires it", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      baseUrl: "http://localhost:8686",
    });

    expect(resolveRequiredLidarrOriginWithoutCredentials()).toBe("http://localhost:8686");
    expect(() => resolveRequiredLidarrOrigin()).toThrow("Lidarr base URL and API key are required");
  });
});

describe("resolveLidarrScheduler", () => {
  it("uses safe defaults when scheduler config is absent", () => {
    const scheduler = resolveLidarrScheduler();

    expect(scheduler.policy["local-only"]).toMatchObject({
      concurrency: 8,
      operationBudget: 1_000,
      retryAttempts: 1,
    });
    expect(scheduler.policy.destructive).toMatchObject({ concurrency: 1, retryAttempts: 0 });
    expect(Object.isFrozen(scheduler)).toBe(true);
  });

  it("resolves partial scheduler overrides from loaded config", () => {
    mockGetLoadedLidarrConfig.mockReturnValue({
      scheduler: {
        lanes: {
          "local-only": { concurrency: 3 },
          discovery: { operationBudget: 12 },
        },
      },
    });

    const scheduler = resolveLidarrScheduler();
    expect(scheduler.policy["local-only"].concurrency).toBe(3);
    expect(scheduler.policy["local-only"].operationBudget).toBe(1_000);
    expect(scheduler.policy.discovery.operationBudget).toBe(12);
  });

  it("shares one scheduler while the scheduler config object is unchanged", () => {
    const schedulerConfig = {
      lanes: { "local-only": { concurrency: 3 } },
    };
    mockGetLoadedLidarrConfig.mockReturnValue({ scheduler: schedulerConfig });

    const first = resolveLidarrScheduler();
    const second = resolveLidarrScheduler();

    expect(second).toBe(first);
  });

  it("rebuilds the scheduler when the scheduler config object changes", () => {
    const firstConfig = {
      lanes: { "local-only": { concurrency: 3 } },
    };
    mockGetLoadedLidarrConfig.mockReturnValue({ scheduler: firstConfig });
    const first = resolveLidarrScheduler();

    const secondConfig = {
      lanes: { "local-only": { concurrency: 5 } },
    };
    mockGetLoadedLidarrConfig.mockReturnValue({ scheduler: secondConfig });
    const second = resolveLidarrScheduler();

    expect(second).not.toBe(first);
    expect(second.policy["local-only"].concurrency).toBe(5);
  });
});

describe("barrel re-export surface", () => {
  it("re-exports the circuit-breaker module", () => {
    expect(typeof lidarrBarrel.evaluateCircuit).toBe("function");
    expect(typeof lidarrBarrel.recordCircuitSuccess).toBe("function");
    expect(typeof lidarrBarrel.recordCircuitFailure).toBe("function");
    expect(typeof lidarrBarrel.createSqliteCircuitStore).toBe("function");
    expect(typeof lidarrBarrel.createCircuitBreaker).toBe("function");
    expect(lidarrBarrel.HALF_OPEN_PROBE_TIMEOUT_MS).toBe(120_000);
  });

  it("re-exports the health module", () => {
    expect(typeof lidarrBarrel.runHealthProbe).toBe("function");
    expect(typeof lidarrBarrel.detectMetadataProviderOutage).toBe("function");
    expect(typeof lidarrBarrel.ensureTierHealthy).toBe("function");
    expect(typeof lidarrBarrel.readLidarrResilienceSnapshot).toBe("function");
  });

  it("re-exports the deferred-queue domain and CRUD modules", () => {
    expect(typeof lidarrBarrel.enqueueDeferredIntent).toBe("function");
    expect(typeof lidarrBarrel.listDeferredIntents).toBe("function");
    expect(typeof lidarrBarrel.clearDeferredIntents).toBe("function");
    expect(typeof lidarrBarrel.replayDeferredIntents).toBe("function");
    expect(typeof lidarrBarrel.insertDeferredIntent).toBe("function");
    expect(typeof lidarrBarrel.selectDueDeferredIntents).toBe("function");
    expect(typeof lidarrBarrel.claimDeferredIntent).toBe("function");
    expect(typeof lidarrBarrel.countDeferredIntentsByStatus).toBe("function");
  });

  it("re-exports the metadata-cache module", () => {
    expect(typeof lidarrBarrel.readLidarrCache).toBe("function");
    expect(typeof lidarrBarrel.writeLidarrCache).toBe("function");
    expect(typeof lidarrBarrel.purgeLidarrCache).toBe("function");
    expect(typeof lidarrBarrel.createSqliteCacheSource).toBe("function");
  });

  it("re-exports the resilience decorator module", () => {
    expect(typeof lidarrBarrel.createResilientLidarrClient).toBe("function");
    expect(typeof lidarrBarrel.resolveResiliencePolicy).toBe("function");
    expect(lidarrBarrel.LIDARR_IN_PLACE_RETRY_ALLOWLIST).toBeInstanceOf(Set);
    expect(lidarrBarrel.RETRY_BASE_DELAY_MS).toBe(500);
    expect(lidarrBarrel.TIMEOUT_RETRY_BASE_DELAY_MS).toBe(2_000);
  });

  it("re-exports the scheduler module", () => {
    expect(typeof lidarrBarrel.createLidarrScheduler).toBe("function");
    expect(typeof lidarrBarrel.resolveLidarrSchedulerPolicy).toBe("function");
    expect(typeof lidarrBarrel.readLidarrExecutionMetadata).toBe("function");
    expect(lidarrBarrel.DEFAULT_LIDARR_SCHEDULER_POLICY.destructive.retryAttempts).toBe(0);
  });

  it("re-exports the command-facing resilience types", () => {
    // Compile-time assertions: these names must resolve as types via the barrel.
    const cacheStatus: lidarrBarrel.LidarrCacheStatus = {
      source: "stale-cache",
      fetchedAt: "2026-07-22T00:00:00.000Z",
      ageSeconds: 60,
    };
    const snapshot: lidarrBarrel.LidarrResilienceSnapshot = {
      circuits: [],
      deferredIntents: { pending: 0, failed: 0 },
    };
    expect(cacheStatus.source).toBe("stale-cache");
    expect(snapshot.deferredIntents.pending).toBe(0);
  });

  it("keeps the pre-#195 client/error/tier surface exported", () => {
    expect(typeof lidarrBarrel.LidarrClient).toBe("function");
    expect(typeof lidarrBarrel.LidarrValidationError).toBe("function");
    expect(typeof lidarrBarrel.classifyLidarrStatus).toBe("function");
    expect(typeof lidarrBarrel.parseRetryAfter).toBe("function");
    expect(typeof lidarrBarrel.runHealthGate).toBe("function");
    expect(lidarrBarrel.LIDARR_TIER_DESCRIPTORS).toBeDefined();
  });
});
