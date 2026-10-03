import { describe, expect, it, vi } from "vitest";

import {
  LastFmProviderError,
  createLastFmClient,
  type LastFmClientDependencies,
} from "./lastfm.js";

const API_KEY = "lastfm-secret-api-key";
const QUERY = {
  artist: "radiohead",
  limit: 2,
  autocorrect: true,
} as const;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createClient(
  fetchImplementation: typeof fetch,
  dependencies: Omit<LastFmClientDependencies, "fetch"> = {},
) {
  return createLastFmClient(
    { apiKey: API_KEY, timeoutMs: 15_000 },
    {
      fetch: fetchImplementation,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
      ...dependencies,
    },
  );
}

describe("createLastFmClient", () => {
  it("uses the fixed redirect-rejecting request and returns a strict frozen projection", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
      );
      expect(requestUrl.origin).toBe("https://ws.audioscrobbler.com");
      expect(requestUrl.pathname).toBe("/2.0/");
      expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
        method: "artist.getSimilar",
        artist: "radiohead",
        limit: "2",
        autocorrect: "1",
        api_key: API_KEY,
        format: "json",
      });
      expect(init).toMatchObject({ method: "GET", redirect: "error" });

      return jsonResponse({
        similarartists: {
          "@attr": { artist: "Radiohead" },
          artist: [
            {
              name: "Thom Yorke",
              match: "0.91",
              mbid: "B7A03E8A-A9A7-40C2-8F2B-C5B7C6D73D5A",
              url: "https://www.last.fm/music/Thom+Yorke",
              image: [{ "#text": "ignored" }],
              streamable: "0",
            },
            {
              name: "Atoms for Peace",
              match: 0.8,
              mbid: "",
              url: "https://www.last.fm/music/Atoms+for+Peace",
            },
          ],
        },
      });
    });
    const client = createClient(fetchImplementation);

    const result = await client.getSimilarArtists(QUERY);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(result).toEqual({
      requestedName: "radiohead",
      resolvedName: "Radiohead",
      autocorrected: true,
      recommendations: [
        {
          name: "Thom Yorke",
          similarity: 0.91,
          musicBrainzId: "b7a03e8a-a9a7-40c2-8f2b-c5b7c6d73d5a",
          sourceUrl: "https://www.last.fm/music/Thom+Yorke",
        },
        {
          name: "Atoms for Peace",
          similarity: 0.8,
          sourceUrl: "https://www.last.fm/music/Atoms+for+Peace",
        },
      ],
      source: {
        provider: "lastfm",
        method: "artist.getSimilar",
        attribution: "Recommendations provided by Last.fm",
        url: "https://www.last.fm/",
        fetchedAt: "2026-07-25T12:00:00.000Z",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recommendations)).toBe(true);
    expect(result.recommendations.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("image");
    expect(JSON.stringify(result)).not.toContain("streamable");
  });

  it("accepts artists with an omitted or null MusicBrainz ID", async () => {
    const client = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          similarartists: {
            "@attr": { artist: "Britney Spears" },
            artist: [
              {
                name: "Ke$ha",
                match: "0.72",
                url: "https://www.last.fm/music/Ke$ha",
              },
              {
                name: "Wanessa",
                match: "0.65",
                mbid: null,
                url: "https://www.last.fm/music/Wanessa",
              },
            ],
          },
        }),
      ),
    );

    const result = await client.getSimilarArtists({
      artist: "Britney Spears",
      limit: 2,
      autocorrect: true,
    });

    expect(result.recommendations).toEqual([
      {
        name: "Ke$ha",
        similarity: 0.72,
        sourceUrl: "https://www.last.fm/music/Ke$ha",
      },
      {
        name: "Wanessa",
        similarity: 0.65,
        sourceUrl: "https://www.last.fm/music/Wanessa",
      },
    ]);
  });

  it.each([
    [
      "an off-origin catalogue URL",
      {
        name: "Unsafe",
        match: "0.5",
        mbid: "",
        url: "https://example.com/music/Unsafe",
      },
    ],
    [
      "a credential-bearing catalogue URL",
      {
        name: "Unsafe",
        match: "0.5",
        mbid: "",
        url: "https://user:password@www.last.fm/music/Unsafe",
      },
    ],
    [
      "a malformed non-empty MBID",
      {
        name: "Unsafe",
        match: "0.5",
        mbid: "not-an-mbid",
        url: "https://www.last.fm/music/Unsafe",
      },
    ],
    [
      "a grouped MBID with an invalid UUID version and variant",
      {
        name: "Unsafe",
        match: "0.5",
        mbid: "11111111-1111-0111-7111-111111111111",
        url: "https://www.last.fm/music/Unsafe",
      },
    ],
    [
      "an out-of-range similarity",
      {
        name: "Unsafe",
        match: "1.1",
        mbid: "",
        url: "https://www.last.fm/music/Unsafe",
      },
    ],
  ])("atomically rejects %s", async (_description, invalidArtist) => {
    const client = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          similarartists: {
            "@attr": { artist: "Radiohead" },
            artist: [
              {
                name: "Valid",
                match: "0.9",
                mbid: "",
                url: "https://www.last.fm/music/Valid",
              },
              invalidArtist,
            ],
          },
        }),
      ),
    );

    await expect(client.getSimilarArtists(QUERY)).rejects.toMatchObject({
      code: "invalid-response",
      retryable: false,
    });
  });

  it("maps a logical HTTP 200 error without retaining the API key or provider body", async () => {
    const client = createClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ error: 10, message: `Invalid key ${API_KEY}` })),
    );

    let thrown: unknown;
    try {
      await client.getSimilarArtists(QUERY);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LastFmProviderError);
    expect(thrown).toMatchObject({ code: "configuration", retryable: false });
    expect(JSON.stringify(thrown)).not.toContain(API_KEY);
    expect(thrown instanceof Error ? thrown.message : "").not.toContain(API_KEY);
    expect(thrown instanceof Error ? thrown.cause : undefined).toBeUndefined();
  });

  it("caps and fatally decodes success bodies without returning a partial result", async () => {
    const oversized = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          similarartists: {
            "@attr": { artist: "Radiohead" },
            artist: [],
            padding: "x".repeat(256),
          },
        }),
      ),
      { maxSuccessBodyBytes: 64 },
    );
    const invalidUtf8 = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([0xff]), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(oversized.getSimilarArtists(QUERY)).rejects.toMatchObject({
      code: "invalid-response",
      retryable: false,
    });
    await expect(invalidUtf8.getSimilarArtists(QUERY)).rejects.toMatchObject({
      code: "invalid-response",
      retryable: false,
    });
  });

  it("caps error bodies, classifies once, and never adds a transport retry loop", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(256), { status: 503 }));
    const client = createClient(fetchImplementation, { maxErrorBodyBytes: 32 });

    await expect(client.getSimilarArtists(QUERY)).rejects.toMatchObject({
      code: "discovery-provider-unavailable",
      statusCode: 503,
      retryable: true,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([
    ["17", 17],
    ["1.5", undefined],
    ["Wed, 21 Oct 2015 07:28:00 GMT", undefined],
    ["9007199254740992", undefined],
  ] as const)("accepts only safe Retry-After delta-seconds (%s)", async (header, expected) => {
    const client = createClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": header } })),
    );

    await expect(client.getSimilarArtists(QUERY)).rejects.toMatchObject({
      code: "rate-limited",
      statusCode: 429,
      retryable: true,
      retryAfterSeconds: expected,
    });
  });

  it("distinguishes caller cancellation from the provider deadline", async () => {
    const caller = new AbortController();
    const reason = new DOMException("operator cancelled", "AbortError");
    caller.abort(reason);
    const neverFetch = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const client = createClient(neverFetch);

    let callerFailure: unknown;
    try {
      await client.getSimilarArtists({ ...QUERY, signal: caller.signal });
    } catch (error) {
      callerFailure = error;
    }
    expect(callerFailure).toBe(reason);
    expect(neverFetch).not.toHaveBeenCalled();

    const timeoutClient = createClient(neverFetch, {
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return undefined;
      },
      cancelTimeout: vi.fn(),
    });
    await expect(timeoutClient.getSimilarArtists(QUERY)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(neverFetch).toHaveBeenCalledOnce();
  });

  it("redacts the API key from arbitrary transport failures", async () => {
    const client = createClient(
      vi.fn<typeof fetch>().mockRejectedValue(new Error(`failed request api_key=${API_KEY}`)),
    );

    let thrown: unknown;
    try {
      await client.getSimilarArtists(QUERY);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "discovery-provider-unavailable",
      retryable: true,
    });
    expect(thrown instanceof Error ? thrown.message : "").not.toContain(API_KEY);
    expect(thrown instanceof Error ? thrown.cause : undefined).toBeUndefined();
  });
});
