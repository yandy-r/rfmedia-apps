import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MediaServerError,
  type MediaServerMetadataCapability,
  type MediaServerRatingUpdateResult,
} from "../../../types/media-server.js";
import type { PlexCacheKey, PlexResponseCache } from "./cache.js";
import type { PlexTransport } from "./client.js";
import { createPlexMetadataCapability } from "./metadata.js";
import type { PlexRequestInput } from "./types.js";

type TransportOutcome =
  | { readonly kind: "return" }
  | { readonly kind: "throw"; readonly error: unknown };

class RecordingTransport implements PlexTransport {
  readonly requests: PlexRequestInput[] = [];
  readonly #outcomes: TransportOutcome[];

  constructor(outcomes: readonly TransportOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  async request<T>(input: PlexRequestInput): Promise<T> {
    this.requests.push(input);
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) {
      throw new Error("No queued Plex transport outcome");
    }
    if (outcome.kind === "throw") {
      throw outcome.error;
    }
    return undefined as T;
  }
}

class RecordingCache implements PlexResponseCache {
  readonly enabled = true;
  readonly invalidations: PlexCacheKey["category"][] = [];

  get<T>(_key: PlexCacheKey): T | undefined {
    return undefined;
  }

  set<T>(_key: PlexCacheKey, _value: T): void {}

  delete(_key: PlexCacheKey): boolean {
    return false;
  }

  invalidate(category: PlexCacheKey["category"]): number {
    this.invalidations.push(category);
    return 0;
  }

  clear(): void {}
}

function succeeds(): TransportOutcome {
  return { kind: "return" };
}

function fails(error: unknown): TransportOutcome {
  return { kind: "throw", error };
}

function mediaServerError(
  code: ConstructorParameters<typeof MediaServerError>[1]["code"],
  message: string,
  statusCode?: number,
): MediaServerError {
  return new MediaServerError(message, {
    code,
    serverType: "plex",
    operation: "update Plex track rating",
    retryable: false,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function createSubject(outcomes: readonly TransportOutcome[]): {
  readonly capability: MediaServerMetadataCapability;
  readonly transport: RecordingTransport;
  readonly cache: RecordingCache;
} {
  const transport = new RecordingTransport(outcomes);
  const cache = new RecordingCache();
  const capability = createPlexMetadataCapability(transport, cache);
  return { capability, transport, cache };
}

describe("createPlexMetadataCapability", () => {
  it.each([
    { normalized: null, native: 0 },
    { normalized: 0, native: 0 },
    { normalized: 0.5, native: 5 },
    { normalized: 1, native: 10 },
    { normalized: 0.74, native: 7 },
    { normalized: 0.75, native: 8 },
  ] as const)(
    "converts normalized rating $normalized to Plex rating $native",
    async ({ normalized, native }) => {
      const { capability, transport, cache } = createSubject([succeeds()]);

      const result = await capability.updateTrackRating("track/1", normalized);

      expect(result).toEqual<MediaServerRatingUpdateResult>({
        success: true,
        message: "Rating updated",
      });
      expect(transport.requests).toEqual([
        {
          path: "/:/rate",
          operation: "update Plex track rating",
          options: {
            method: "PUT",
            query: {
              identifier: "com.plexapp.plugins.library",
              key: "track/1",
              rating: native,
            },
          },
        },
      ]);
      expect(cache.invalidations).toEqual(["queries"]);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01])(
    "rejects invalid normalized rating %s before a request",
    async (rating) => {
      const { capability, transport, cache } = createSubject([]);

      await expect(capability.updateTrackRating("track-1", rating)).resolves.toEqual({
        success: false,
        message: "Normalized media rating must be a finite number between 0 and 1",
      });
      expect(transport.requests).toEqual([]);
      expect(cache.invalidations).toEqual([]);
    },
  );

  it.each(["", "track\u0000id"])("rejects invalid track ID %j before a request", async (id) => {
    const { capability, transport, cache } = createSubject([]);

    await expect(capability.updateTrackRating(id, 0.5)).resolves.toEqual({
      success: false,
      message: "Track ID must be a non-empty opaque ID",
    });
    expect(transport.requests).toEqual([]);
    expect(cache.invalidations).toEqual([]);
  });

  it.each([
    {
      code: "authentication" as const,
      statusCode: 401,
      clientMessage: "Plex authentication failed (HTTP 401)",
      resultMessage: "Authentication failed (401) - check your plex token",
    },
    {
      code: "authorization" as const,
      statusCode: 403,
      clientMessage: "Plex authorization failed (HTTP 403)",
      resultMessage: "Plex authorization failed (HTTP 403)",
    },
    {
      code: "rate-limited" as const,
      statusCode: 429,
      clientMessage: "Plex request was rate limited (HTTP 429)",
      resultMessage: "Plex request was rate limited (HTTP 429)",
    },
    {
      code: "authentication" as const,
      statusCode: 498,
      clientMessage: "Plex JWT has expired (HTTP 498)",
      resultMessage: "Plex JWT has expired (HTTP 498)",
    },
  ])(
    "returns typed HTTP $statusCode failure without replay or invalidation",
    async ({ code, statusCode, clientMessage, resultMessage }) => {
      const { capability, transport, cache } = createSubject([
        fails(mediaServerError(code, clientMessage, statusCode)),
      ]);

      await expect(capability.updateTrackRating("track-1", 0.5)).resolves.toEqual({
        success: false,
        message: resultMessage,
        statusCode,
      });
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.options?.method).toBe("PUT");
      expect(cache.invalidations).toEqual([]);
    },
  );

  it.each([
    mediaServerError("timeout", "Plex request timed out"),
    mediaServerError("network", "Plex network request failed: connect ECONNREFUSED"),
    mediaServerError("network", "Plex network request failed: getaddrinfo ENOTFOUND"),
    mediaServerError("request-failed", "Plex request failed: socket closed"),
    new Error("Unexpected transport failure"),
  ])("preserves the sanitized non-HTTP failure message", async (error) => {
    const { capability, transport, cache } = createSubject([fails(error)]);

    await expect(capability.updateTrackRating("track-1", 0.5)).resolves.toEqual({
      success: false,
      message: error.message,
    });
    expect(transport.requests).toHaveLength(1);
    expect(cache.invalidations).toEqual([]);
  });

  it("normalizes a non-Error rejection without invalidating cached queries", async () => {
    const { capability, transport, cache } = createSubject([fails("transport unavailable")]);

    await expect(capability.updateTrackRating("track-1", 0.5)).resolves.toEqual({
      success: false,
      message: "transport unavailable",
    });
    expect(transport.requests).toHaveLength(1);
    expect(cache.invalidations).toEqual([]);
  });

  it("satisfies the provider-neutral metadata capability contract", () => {
    const { capability } = createSubject([]);

    expectTypeOf(capability).toEqualTypeOf<MediaServerMetadataCapability>();
    expectTypeOf(
      capability.updateTrackRating,
    ).returns.resolves.toEqualTypeOf<MediaServerRatingUpdateResult>();
  });
});
