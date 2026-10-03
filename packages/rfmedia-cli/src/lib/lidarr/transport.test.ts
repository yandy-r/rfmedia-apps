import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  LidarrError,
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  RateLimitedError,
} from "./errors.js";
import { createLidarrTransport, type LidarrTransportDependencies } from "./transport.js";
import {
  StaticLidarrApiKeyProvider,
  createLidarrConnectionSettings,
  type LidarrApiKeyProvider,
} from "./types.js";

const ORIGIN = "http://localhost:8686";

function createTransport(
  apiKey = "opaque-api-key",
  dependencies: LidarrTransportDependencies = {},
  provider?: LidarrApiKeyProvider,
): ReturnType<typeof createLidarrTransport> {
  const connection = createLidarrConnectionSettings({
    origin: ORIGIN,
    apiKey,
    request: { timeoutMs: 30_000, delayMs: 0 },
  });
  return createLidarrTransport(
    connection,
    provider ?? new StaticLidarrApiKeyProvider(connection),
    dependencies,
  );
}

function request(path = "/api/v1/system/status", init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function asLidarrError(error: unknown): LidarrError {
  expect(error).toBeInstanceOf(LidarrError);
  return error as LidarrError;
}

function controlledStream(
  chunks: readonly Uint8Array[],
  holdOpen = false,
): {
  readonly cancelled: () => boolean;
  readonly stream: ReadableStream<Uint8Array>;
} {
  let index = 0;
  let wasCancelled = false;
  return {
    cancelled: () => wasCancelled,
    stream: new ReadableStream<Uint8Array>({
      cancel: () => {
        wasCancelled = true;
      },
      pull: async (controller) => {
        const chunk = chunks[index++];
        if (chunk === undefined && !holdOpen) controller.close();
        else if (chunk === undefined) await new Promise(() => {});
        else controller.enqueue(chunk);
      },
    }),
  };
}

function stalledStream(): {
  readonly cancelled: () => boolean;
  readonly stream: ReadableStream<Uint8Array>;
} {
  let wasCancelled = false;
  return {
    cancelled: () => wasCancelled,
    stream: new ReadableStream<Uint8Array>({
      cancel: () => {
        wasCancelled = true;
      },
      pull: async () => new Promise(() => {}),
    }),
  };
}

describe("Lidarr generated-client transport request confinement (SEC-194-01)", () => {
  it("validates the final Request before key access and sends header-only auth", async () => {
    const apiKey = "secret-api-key";
    const events: string[] = [];
    const provider = {
      getApiKey: async () => {
        events.push("key");
        return apiKey;
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const finalRequest = input as Request;
      events.push("fetch");
      expect(finalRequest).toBeInstanceOf(Request);
      expect(finalRequest.url).toBe(`${ORIGIN}/api/v1/system/status?page=1`);
      expect(finalRequest.redirect).toBe("error");
      expect(finalRequest.headers.get("accept")).toBe("application/json");
      expect(finalRequest.headers.get("x-api-key")).toBe(apiKey);
      expect(finalRequest.url).not.toContain(apiKey);
      expect([...finalRequest.headers.keys()].filter((key) => key === "x-api-key")).toHaveLength(1);
      return jsonResponse({ ok: true });
    });
    const transport = createTransport(apiKey, { fetch: fetchMock }, provider);

    await expect(transport(request("/api/v1/system/status?page=1"))).resolves.toBeInstanceOf(
      Response,
    );
    expect(events).toEqual(["key", "fetch"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong origin", new Request("https://attacker.example/api/v1/health")],
    ["non-HTTP protocol", new Request("ftp://localhost/api/v1/health")],
    ["fragment", request("/api/v1/health#secret")],
    ["credential query key", request("/api/v1/health?apikey=value")],
    ["credential query value", request("/api/v1/health?value=Bearer%20secret")],
    ["X-Api-Key header", request("/api/v1/health", { headers: { "X-Api-Key": "bad" } })],
    ["Authorization header", request("/api/v1/health", { headers: { Authorization: "bad" } })],
    ["Cookie header", request("/api/v1/health", { headers: { Cookie: "bad" } })],
    [
      "Proxy-Authorization header",
      request("/api/v1/health", { headers: { "Proxy-Authorization": "bad" } }),
    ],
    ["token header", request("/api/v1/health", { headers: { "X-Auth-Token": "bad" } })],
  ])("rejects %s before retrieving the key", async (_label, unsafeRequest) => {
    const provider = { getApiKey: vi.fn(async () => "secret") };
    const fetchMock = vi.fn<typeof fetch>();
    const transport = createTransport("secret", { fetch: fetchMock }, provider);

    const error = await transport(unsafeRequest).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({ code: "configuration" });
    expect(provider.getApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a query value equal to the actual key after safe late retrieval", async () => {
    const provider = { getApiKey: vi.fn(async () => "actual-secret") };
    const fetchMock = vi.fn<typeof fetch>();
    const transport = createTransport("actual-secret", { fetch: fetchMock }, provider);

    const error = await transport(request("/api/v1/health?value=actual-secret")).catch(
      (failure: unknown) => failure,
    );

    expect(asLidarrError(error).code).toBe("configuration");
    expect(provider.getApiKey).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps provider failures without exposing provider state", async () => {
    const providerSecret = "provider-internal-secret";
    const provider = {
      getApiKey: async () => {
        throw new Error(providerSecret);
      },
    };
    const transport = createTransport("unused", {}, provider);

    const error = await transport(request()).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toBeInstanceOf(LidarrValidationError);
    expect(asLidarrError(error)).toMatchObject({
      code: "configuration",
      message: "Lidarr API key is unavailable or invalid",
    });
    expect(inspect(error)).not.toContain(providerSecret);
  });

  it("keeps two clients' origins and keys isolated under concurrent requests", async () => {
    const originA = "https://lidarr-a.example.test";
    const originB = "https://lidarr-b.example.test";
    const connectionA = createLidarrConnectionSettings({ origin: originA, apiKey: "key-a" });
    const connectionB = createLidarrConnectionSettings({ origin: originB, apiKey: "key-b" });
    const seen: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const finalRequest = input as Request;
      await Promise.resolve();
      seen.push(`${new URL(finalRequest.url).origin}:${finalRequest.headers.get("x-api-key")}`);
      return jsonResponse({ ok: true });
    });
    const transportA = createLidarrTransport(
      connectionA,
      new StaticLidarrApiKeyProvider(connectionA),
      { fetch: fetchMock },
    );
    const transportB = createLidarrTransport(
      connectionB,
      new StaticLidarrApiKeyProvider(connectionB),
      { fetch: fetchMock },
    );

    await Promise.all([
      transportB(new Request(`${originB}/api/v1/artist`)),
      transportA(new Request(`${originA}/api/v1/health`)),
      transportB(new Request(`${originB}/api/v1/wanted/missing`)),
      transportA(new Request(`${originA}/api/v1/system/status`)),
    ]);

    expect(seen.sort()).toEqual([
      `${originA}:key-a`,
      `${originA}:key-a`,
      `${originB}:key-b`,
      `${originB}:key-b`,
    ]);
  });

  it("reads operation labels from a concurrency-safe provider with a generic fallback", async () => {
    const operations = new AsyncLocalStorage<string>();
    const transport = createTransport("secret", {
      fetch: vi.fn(async () => {
        await Promise.resolve();
        throw new TypeError("network failed");
      }),
      getOperation: () => operations.getStore(),
    });

    const [statusError, healthError, fallbackError] = await Promise.all([
      operations.run("lidarr system status", () =>
        transport(request()).catch((failure: unknown) => failure),
      ),
      operations.run("lidarr health", () =>
        transport(request("/api/v1/health")).catch((failure: unknown) => failure),
      ),
      transport(request("/api/v1/artist")).catch((failure: unknown) => failure),
    ]);

    expect(asLidarrError(statusError).operation).toBe("lidarr system status");
    expect(asLidarrError(healthError).operation).toBe("lidarr health");
    expect(asLidarrError(fallbackError).operation).toBe("lidarr request");
  });

  it("does not serialize or reflect credentials in transport state or errors", async () => {
    const apiKey = "reflected-super-secret";
    const transport = createTransport(apiKey, {
      fetch: vi.fn(async () => {
        throw new TypeError(`failed with X-Api-Key=${apiKey}`);
      }),
    });

    const error = await transport(request()).catch((failure: unknown) => failure);

    expect(Object.keys(transport)).toEqual([]);
    expect(JSON.stringify(transport)).toBeUndefined();
    expect(inspect(transport)).not.toContain(apiKey);
    expect(inspect(error)).not.toContain(apiKey);
    expect(asLidarrError(error)).toBeInstanceOf(LidarrUnreachableError);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("Lidarr generated-client transport body bounds (SEC-194-02)", () => {
  it.each([
    ["missing", undefined],
    ["invalid", "invalid"],
    ["understated", "1"],
  ])("counts chunked body bytes with %s Content-Length", async (_label, contentLength) => {
    const encoder = new TextEncoder();
    const { stream } = controlledStream([encoder.encode('{"ok":'), encoder.encode("true}")]);
    const headers = new Headers({
      "content-encoding": "gzip",
      "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    });
    const rawResponse = new Response(stream, { headers });
    const transport = createTransport("secret", {
      fetch: vi.fn(async () => rawResponse),
      maxSuccessBodyBytes: 11,
    });

    const bounded = await transport(request());

    expect(await bounded.json()).toEqual({ ok: true });
    expect(bounded).not.toBe(rawResponse);
    expect(bounded.headers.get("content-length")).toBe("11");
    expect(bounded.headers.get("content-encoding")).toBeNull();
    expect([...bounded.headers.keys()].sort()).toEqual(["content-length", "content-type"]);
  });

  it("cancels and rejects an oversized success stream", async () => {
    const { cancelled, stream } = controlledStream(
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      true,
    );
    const transport = createTransport("secret", {
      fetch: vi.fn(async () => new Response(stream)),
      maxSuccessBodyBytes: 4,
    });

    const error = await transport(request()).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({ code: "invalid-response" });
    expect((error as Error).message).toBe("Lidarr response exceeded the allowed size");
    expect(cancelled()).toBe(true);
  });

  it("cancels an oversized error body but preserves status classification", async () => {
    const { cancelled, stream } = controlledStream(
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      true,
    );
    const transport = createTransport("secret", {
      fetch: vi.fn(
        async () => new Response(stream, { status: 429, headers: { "retry-after": "7" } }),
      ),
      maxErrorBodyBytes: 4,
    });

    const error = await transport(request()).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toBeInstanceOf(RateLimitedError);
    expect(asLidarrError(error)).toMatchObject({
      retryAfterSeconds: 7,
      statusCode: 429,
    });
    expect(cancelled()).toBe(true);
  });

  it("rejects invalid UTF-8 before the generated parser can read it", async () => {
    const transport = createTransport("secret", {
      fetch: vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]))),
    });

    const error = await transport(request()).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({ code: "invalid-response" });
    expect((error as Error).message).toBe("Lidarr returned an invalid JSON response");
  });

  it("keeps the timeout active through a stalled body read and cleans up", async () => {
    const { cancelled, stream } = stalledStream();
    let fireTimeout: (() => void) | undefined;
    const cancelTimeout = vi.fn();
    const fetchMock = vi.fn(async () => new Response(stream));
    const transport = createTransport("secret", {
      fetch: fetchMock,
      scheduleTimeout: (callback) => {
        fireTimeout = callback;
        return 42;
      },
      cancelTimeout,
    });

    const pending = transport(request()).catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fireTimeout).toBeTypeOf("function");
    fireTimeout?.();
    const error = await pending;

    expect(asLidarrError(error)).toBeInstanceOf(LidarrTimeoutError);
    expect(cancelled()).toBe(true);
    expect(cancelTimeout).toHaveBeenCalledWith(42);
  });

  it("preserves caller abort identity through a stalled body read and cleans up", async () => {
    const { cancelled, stream } = stalledStream();
    const controller = new AbortController();
    const cancelTimeout = vi.fn();
    const fetchMock = vi.fn(async () => new Response(stream));
    const transport = createTransport("secret", { fetch: fetchMock, cancelTimeout });
    const callerReason = new DOMException("caller cancelled", "AbortError");

    const pending = transport(request("/api/v1/health", { signal: controller.signal })).catch(
      (failure: unknown) => failure,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(callerReason);
    const error = await pending;

    expect(error).toBe(callerReason);
    expect(cancelled()).toBe(true);
    expect(cancelTimeout).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted caller before key access or Fetch", async () => {
    const controller = new AbortController();
    const reason = new DOMException("already cancelled", "AbortError");
    controller.abort(reason);
    const provider = { getApiKey: vi.fn(async () => "secret") };
    const fetchMock = vi.fn<typeof fetch>();
    const transport = createTransport("secret", { fetch: fetchMock }, provider);

    const error = await transport(request("/api/v1/health", { signal: controller.signal })).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBe(reason);
    expect(provider.getApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, LidarrValidationError, "configuration", undefined],
    [403, LidarrValidationError, "configuration", undefined],
    [404, LidarrValidationError, "validation", undefined],
    [503, LidarrUnreachableError, "lidarr-unreachable", 503],
  ] as const)("maps HTTP %i after bounded draining", async (status, ctor, code, statusCode) => {
    const transport = createTransport("secret", {
      fetch: vi.fn(async () => new Response("untrusted body secret", { status })),
    });

    const error = await transport(request()).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toBeInstanceOf(ctor);
    expect(asLidarrError(error)).toMatchObject({ code, statusCode });
    expect(inspect(error)).not.toContain("untrusted body secret");
  });

  it("cleans up the timeout after successful consumption", async () => {
    const cancelTimeout = vi.fn();
    const transport = createTransport("secret", {
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      scheduleTimeout: () => "timer-handle",
      cancelTimeout,
    });

    await transport(request());

    expect(cancelTimeout).toHaveBeenCalledOnce();
    expect(cancelTimeout).toHaveBeenCalledWith("timer-handle");
  });
});
