import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { MediaServerError } from "../../../types/media-server.js";
import { StaticPlexTokenProvider, type PlexTokenProvider } from "./auth.js";
import { PlexClient, type PlexClientDependencies } from "./client.js";
import { createPlexConnectionSettings, type PlexRequestInput } from "./types.js";

type FetchImplementation = NonNullable<PlexClientDependencies["fetch"]>;

function createClient(
  token = "opaque-secret-token",
  dependencies: PlexClientDependencies = {},
  provider?: PlexTokenProvider,
): PlexClient {
  const connection = createPlexConnectionSettings({
    origin: "https://plex.example.com",
    token,
    clientIdentifier: "rfmedia-test-client",
    request: { timeoutMs: 30_000, delayMs: 100 },
  });
  return new PlexClient(
    connection,
    provider ?? new StaticPlexTokenProvider(connection),
    dependencies,
  );
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function asMediaServerError(error: unknown): MediaServerError {
  expect(error).toBeInstanceOf(MediaServerError);
  return error as MediaServerError;
}

describe("PlexClient request security", () => {
  it("uses a relative URL, structured query, exact auth headers, and rejected redirects", async () => {
    const token = "secret-token-value";
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse({ ok: true }));
    const delay = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = createClient(token, { fetch: fetchMock, delay });

    await expect(
      client.request<{ ok: boolean }>({
        path: "/library/sections",
        operation: "list libraries",
        options: { query: { type: 10, title: "A & B", optional: undefined } },
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl).toBeInstanceOf(URL);
    expect(String(requestUrl)).toBe(
      "https://plex.example.com/library/sections?type=10&title=A+%26+B",
    );
    expect(String(requestUrl)).not.toContain(token);
    expect(requestInit).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", "X-Plex-Token": token },
    });
    expect(Object.keys(requestInit?.headers as Record<string, string>)).toEqual([
      "Accept",
      "X-Plex-Token",
    ]);
    expect(delay).toHaveBeenCalledExactlyOnceWith(100);
  });

  it.each([
    "https://attacker.example/data",
    "//attacker.example/data",
    "/library?X-Plex-Token=leak",
    "/library#fragment",
    "library/sections",
  ])("rejects a non-relative or pre-queried path before fetch: %s", async (path) => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client
      .request({ path, operation: "unsafe request" })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error).code).toBe("configuration");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects credential-like query keys and token values before fetch", async () => {
    const token = "top/secret token";
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient(token, { fetch: fetchMock });

    for (const query of [{ token: "value" }, { harmless: token }]) {
      const error = await client
        .request({ path: "/library", operation: "unsafe query", options: { query } })
        .catch((failure: unknown) => failure);
      expect(asMediaServerError(error).code).toBe("configuration");
      expect(inspect(error)).not.toContain(token);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not confuse a short token with ordinary URL characters", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createClient("a", { fetch: fetchMock, delay: async () => undefined });

    await expect(
      client.request({
        path: "/library/metadata",
        operation: "short token request",
        options: { query: { title: "Album" } },
      }),
    ).resolves.toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://plex.example.com/library/metadata?title=Album",
    );
  });

  it("rejects a token query value before URL encoding can obscure it", async () => {
    const token = "slash/value with spaces";
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient(token, { fetch: fetchMock });

    const error = await client
      .request({
        path: "/library",
        operation: "encoded credential query",
        options: { query: { harmless: token } },
      })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error).code).toBe("configuration");
    expect(inspect(error)).not.toContain(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a fixed secret-free error when a token provider fails", async () => {
    const providerSecret = "provider-internal-secret";
    const provider: PlexTokenProvider = {
      getToken: async () => {
        throw new Error(`credential lookup failed: ${providerSecret}`);
      },
    };
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("connection-token", { fetch: fetchMock }, provider);

    const error = await client
      .request({ path: "/", operation: "provider failure" })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error)).toMatchObject({
      code: "configuration",
      message: "Plex credential is unavailable or invalid",
    });
    expect(inspect(error)).not.toContain(providerSecret);
    expect((error as Error).cause).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ timeoutMs: 0, delayMs: 100 }, "timeoutMs must be a positive safe integer"],
    [{ timeoutMs: 30_000, delayMs: -1 }, "delayMs must be a non-negative safe integer"],
  ] as const)("rejects invalid captured request settings", (request, message) => {
    const connection = createPlexConnectionSettings({
      origin: "https://plex.example.com",
      token: "secret",
      clientIdentifier: "rfmedia-test-client",
      request,
    });

    expect(() => new PlexClient(connection, new StaticPlexTokenProvider(connection))).toThrow(
      message,
    );
  });

  it("keeps credentials out of serializable client state and reflected errors", async () => {
    const token = "reflected-super-secret";
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockRejectedValue(new TypeError(`failed with X-Plex-Token=${token}\nnext`));
    const client = createClient(token, { fetch: fetchMock });

    const error = await client
      .request({ path: "/", operation: "identity" })
      .catch((failure: unknown) => failure);

    expect(Object.keys(client)).toEqual([]);
    expect(JSON.stringify(client)).toBe("{}");
    expect(inspect(client)).not.toContain(token);
    expect(inspect(error)).not.toContain(token);
    expect(asMediaServerError(error)).toMatchObject({ code: "network", operation: "identity" });
  });

  it("does not follow or retry a redirect response", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
      );
    const client = createClient("secret", { fetch: fetchMock, delay: async () => undefined });

    const error = await client
      .request({ path: "/", operation: "identity" })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error)).toMatchObject({ code: "request-failed", statusCode: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

describe("PlexClient response and error mapping", () => {
  it.each([
    [401, "authentication", false],
    [403, "authorization", false],
    [404, "not-found", false],
    [422, "authentication", false],
    [429, "rate-limited", true],
    [498, "authentication", false],
    [503, "request-failed", true],
  ] as const)("maps HTTP %i to %s", async (status, code, retryable) => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response("untrusted body", { status }));
    const client = createClient("secret", { fetch: fetchMock, delay: async () => undefined });

    const error = await client
      .request({ path: "/resource", operation: "read resource" })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error)).toMatchObject({ code, statusCode: status, retryable });
    expect((error as Error).message).not.toContain("untrusted body");
  });

  it("maps malformed and oversized success bodies to invalid-response", async () => {
    const responses = [
      new Response("not-json", { status: 200 }),
      new Response(JSON.stringify({ value: "too large" }), { status: 200 }),
    ];
    const fetchMock = vi.fn<FetchImplementation>().mockImplementation(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("missing response fixture");
      return response;
    });
    const client = createClient("secret", {
      fetch: fetchMock,
      delay: async () => undefined,
      maxSuccessBodyBytes: 10,
    });

    for (const operation of ["malformed", "oversized"]) {
      const error = await client
        .request({ path: "/resource", operation })
        .catch((failure: unknown) => failure);
      expect(asMediaServerError(error).code).toBe("invalid-response");
    }
  });

  it("bounds and cancels an oversized error body without including it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
      },
      cancel,
    });
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(body, { status: 500 }));
    const client = createClient("secret", {
      fetch: fetchMock,
      delay: async () => undefined,
      maxErrorBodyBytes: 4,
    });

    const error = await client
      .request({ path: "/resource", operation: "bounded error" })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error).code).toBe("request-failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect((error as Error).message).not.toContain("0123");
  });
});

describe("PlexClient cancellation and retry behavior", () => {
  it("composes caller cancellation and propagates its reason", async () => {
    const caller = new AbortController();
    const reason = new Error("caller stopped the operation");
    const fetchMock = vi.fn<FetchImplementation>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = createClient("secret", { fetch: fetchMock });

    const request = client.request({
      path: "/resource",
      operation: "cancelled read",
      options: { signal: caller.signal },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it("uses a stable AbortError when the caller supplies no explicit reason", async () => {
    const caller = new AbortController();
    const fetchMock = vi.fn<FetchImplementation>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = createClient("secret", { fetch: fetchMock });

    const request = client.request({
      path: "/resource",
      operation: "cancelled read",
      options: { signal: caller.signal },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    caller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("classifies the injected request timeout and clears its timer", async () => {
    let timeoutCallback: (() => void) | undefined;
    const cancelTimeout = vi.fn<(handle: unknown) => void>();
    const fetchMock = vi.fn<FetchImplementation>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = createClient("secret", {
      fetch: fetchMock,
      scheduleTimeout: (callback) => {
        timeoutCallback = callback;
        return "timer-handle";
      },
      cancelTimeout,
    });

    const request = client
      .request({ path: "/resource", operation: "timed read" })
      .catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(timeoutCallback).toBeTypeOf("function"));
    timeoutCallback?.();
    const error = await request;

    expect(asMediaServerError(error)).toMatchObject({ code: "timeout", retryable: true });
    expect(cancelTimeout).toHaveBeenCalledWith("timer-handle");
  });

  it("allows one provider-authorized retry for an idempotent read", async () => {
    let tokenIndex = 0;
    const provider: PlexTokenProvider = {
      getToken: async () => ["old-token", "new-token"][tokenIndex++] ?? "unexpected-token",
      handleAuthFailure: vi.fn(async () => "retry" as const),
    };
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ refreshed: true }));
    const client = createClient(
      "connection-token",
      {
        fetch: fetchMock,
        delay: async () => undefined,
      },
      provider,
    );

    await expect(
      client.request<{ refreshed: boolean }>({ path: "/resource", operation: "retry read" }),
    ).resolves.toEqual({ refreshed: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.handleAuthFailure).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Plex-Token": "old-token" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-Plex-Token": "new-token" });
  });

  it.each(["POST", "PUT", "DELETE"] as const)(
    "never replays or asks to recover a failed %s mutation",
    async (method) => {
      const provider: PlexTokenProvider = {
        getToken: async () => "mutation-token",
        handleAuthFailure: vi.fn(async () => "retry" as const),
      };
      const fetchMock = vi
        .fn<FetchImplementation>()
        .mockResolvedValue(new Response(null, { status: 401 }));
      const client = createClient(
        "connection-token",
        {
          fetch: fetchMock,
          delay: async () => undefined,
        },
        provider,
      );

      const error = await client
        .request({ path: "/resource", operation: `${method} mutation`, options: { method } })
        .catch((failure: unknown) => failure);

      expect(asMediaServerError(error)).toMatchObject({ code: "authentication", retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(provider.handleAuthFailure).not.toHaveBeenCalled();
    },
  );

  it("does not retry a read when the static provider declines", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 498 }));
    const client = createClient("static-token", {
      fetch: fetchMock,
      delay: async () => undefined,
    });

    const error = await client
      .request({ path: "/resource", operation: "static read" })
      .catch((failure: unknown) => failure);

    expect(asMediaServerError(error).code).toBe("authentication");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("PlexClient explicit replay intent", () => {
  const SCAN_TRIGGER: PlexRequestInput = {
    path: "/library/sections/1/refresh",
    operation: "scan Plex library",
    options: { method: "GET" },
    replayable: false,
  };

  it("never recovers or replays a GET declared unreplayable", async () => {
    const provider: PlexTokenProvider = {
      getToken: async () => "scan-token",
      handleAuthFailure: vi.fn(async () => "retry" as const),
    };
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const client = createClient(
      "connection-token",
      { fetch: fetchMock, delay: async () => undefined },
      provider,
    );

    const error = await client.request(SCAN_TRIGGER).catch((failure: unknown) => failure);

    expect(asMediaServerError(error)).toMatchObject({ code: "authentication", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.handleAuthFailure).not.toHaveBeenCalled();
  });

  it("moves the advisory retry flag in lockstep and reports Retry-After", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "287" } }));
    const client = createClient("scan-token", { fetch: fetchMock, delay: async () => undefined });

    const error = await client.request(SCAN_TRIGGER).catch((failure: unknown) => failure);

    expect(asMediaServerError(error)).toMatchObject({
      code: "rate-limited",
      retryable: false,
      retryAfterSeconds: 287,
    });
  });

  it("does not advertise retry when an unreplayable request times out", async () => {
    let timeoutCallback: (() => void) | undefined;
    const fetchMock = vi.fn<FetchImplementation>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = createClient("scan-token", {
      fetch: fetchMock,
      scheduleTimeout: (callback) => {
        timeoutCallback = callback;
        return "timer-handle";
      },
      cancelTimeout: () => undefined,
    });

    const request = client.request(SCAN_TRIGGER).catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(timeoutCallback).toBeTypeOf("function"));
    timeoutCallback?.();

    expect(asMediaServerError(await request)).toMatchObject({ code: "timeout", retryable: false });
  });

  it("does not advertise retry when an unreplayable request fails on the network", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockRejectedValue(new TypeError("socket hang up"));
    const client = createClient("scan-token", { fetch: fetchMock, delay: async () => undefined });

    const error = await client.request(SCAN_TRIGGER).catch((failure: unknown) => failure);

    expect(asMediaServerError(error)).toMatchObject({ code: "network", retryable: false });
  });
});
