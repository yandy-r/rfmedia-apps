import { describe, expect, it } from "vitest";

import {
  MediaServerError,
  type MediaPlaylist,
  type MediaTrack,
} from "../../../types/media-server.js";
import type { PlexTransport } from "./client.js";
import type { PlexCacheKey, PlexResponseCache } from "./cache.js";
import {
  createPlexPlaylistCapability,
  type PlexPlaylistCapabilityDependencies,
} from "./playlists.js";
import type { PlexRequestInput } from "./types.js";

type TransportOutcome =
  | { readonly kind: "return"; readonly value: unknown }
  | { readonly kind: "throw"; readonly error: unknown };

class QueuedTransport implements PlexTransport {
  readonly requests: PlexRequestInput[] = [];
  readonly outcomes: TransportOutcome[];

  constructor(outcomes: readonly TransportOutcome[]) {
    this.outcomes = [...outcomes];
  }

  async request<T>(input: PlexRequestInput): Promise<T> {
    this.requests.push(input);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) {
      throw new Error("No queued Plex transport outcome");
    }
    if (outcome.kind === "throw") {
      throw outcome.error;
    }
    return outcome.value as T;
  }
}

class RecordingCache implements PlexResponseCache {
  readonly enabled = true;
  readonly invalidations: string[] = [];
  readonly entries = new Map<string, unknown>();

  get<T>(key: PlexCacheKey): T | undefined {
    return this.entries.get(this.serialize(key)) as T | undefined;
  }

  set<T>(key: PlexCacheKey, value: T): void {
    this.entries.set(this.serialize(key), value);
  }

  delete(key: PlexCacheKey): boolean {
    return this.entries.delete(this.serialize(key));
  }

  invalidate(category: PlexCacheKey["category"]): number {
    this.invalidations.push(category);
    const prefix = `${category}:`;
    let deleted = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  clear(): void {
    this.entries.clear();
  }

  private serialize(key: PlexCacheKey): string {
    return `${key.category}:${JSON.stringify(key.discriminator ?? [])}`;
  }
}

const audioPlaylistWire = {
  ratingKey: "playlist-1",
  title: "Road Trip",
  smart: false,
  leafCount: 2,
  duration: 420_000,
  addedAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  playlistType: "audio",
} as const;

const trackWire = {
  ratingKey: "track-1",
  title: "First Track",
  grandparentTitle: "Artist",
  parentTitle: "Album",
  userRating: 8,
  viewCount: 3,
  duration: 180_000,
  year: 2024,
  Media: [{ Part: [{ file: "/music/track.flac" }] }],
} as const;

function returns(value: unknown): TransportOutcome {
  return { kind: "return", value };
}

function throws(error: unknown): TransportOutcome {
  return { kind: "throw", error };
}

function metadataResponse(metadata?: readonly unknown[], totalSize?: number): unknown {
  return {
    MediaContainer: {
      size: metadata?.length ?? 0,
      totalSize,
      Metadata: metadata,
    },
  };
}

function createSubject(
  outcomes: readonly TransportOutcome[],
  overrides: Partial<PlexPlaylistCapabilityDependencies> = {},
): {
  readonly capability: ReturnType<typeof createPlexPlaylistCapability>;
  readonly transport: QueuedTransport;
  readonly cache: RecordingCache;
  readonly machineIdentifierCalls: string[];
  readonly warnings: string[];
} {
  const transport = new QueuedTransport(outcomes);
  const cache = new RecordingCache();
  const machineIdentifierCalls: string[] = [];
  const warnings: string[] = [];
  const capability = createPlexPlaylistCapability({
    transport,
    cache,
    getMachineIdentifier: async () => {
      machineIdentifierCalls.push("called");
      return "machine-1";
    },
    warn: (message) => warnings.push(message),
    now: () => 1_800_000_000_000,
    ...overrides,
  });
  return { capability, transport, cache, machineIdentifierCalls, warnings };
}

describe("createPlexPlaylistCapability", () => {
  describe("list and lookup", () => {
    it("lists only audio playlists, maps generic fields, and caches the result", async () => {
      const { capability, transport } = createSubject([
        returns(
          metadataResponse([
            audioPlaylistWire,
            { ...audioPlaylistWire, ratingKey: "video-1", playlistType: "video" },
          ]),
        ),
      ]);

      const first = await capability.list();
      const second = await capability.list();

      expect(first).toEqual<readonly MediaPlaylist[]>([
        {
          id: "playlist-1",
          title: "Road Trip",
          smart: false,
          itemCount: 2,
          durationMs: 420_000,
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_100,
        },
      ]);
      expect(second).toBe(first);
      expect(transport.requests).toEqual([
        { path: "/playlists", operation: "list Plex playlists" },
      ]);
    });

    it("returns an empty list when Plex omits playlist metadata", async () => {
      const { capability } = createSubject([returns(metadataResponse())]);

      await expect(capability.list()).resolves.toEqual([]);
    });

    it("finds a playlist case-insensitively", async () => {
      const { capability } = createSubject([returns(metadataResponse([audioPlaylistWire]))]);

      await expect(capability.byName("road trip")).resolves.toMatchObject({ id: "playlist-1" });
    });

    it("throws a typed not-found error with available playlist names", async () => {
      const { capability } = createSubject([returns(metadataResponse([audioPlaylistWire]))]);

      await expect(capability.byName("Missing")).rejects.toMatchObject({
        name: "MediaServerError",
        code: "not-found",
        operation: "find Plex playlist",
        message: 'Playlist "Missing" not found. Available audio playlists: Road Trip',
      });
    });

    it("rejects malformed list responses and does not cache them", async () => {
      const { capability, cache } = createSubject([returns({ unexpected: true })]);

      await expect(capability.list()).rejects.toMatchObject({
        code: "invalid-response",
        operation: "list Plex playlists",
      });
      expect(cache.entries.size).toBe(0);
    });
  });

  describe("tracks", () => {
    it("paginates using the server-returned count and maps generic tracks", async () => {
      const secondTrack = { ...trackWire, ratingKey: "track-2", title: "Second Track" };
      const { capability, transport } = createSubject(
        [returns(metadataResponse([trackWire], 2)), returns(metadataResponse([secondTrack], 2))],
        { pageSize: 1 },
      );

      const tracks = await capability.tracks("playlist/with space");

      expect(tracks).toEqual<readonly MediaTrack[]>([
        {
          id: "track-1",
          kind: "track",
          title: "First Track",
          rating: 0.8,
          artist: "Artist",
          album: "Album",
          playCount: 3,
          durationMs: 180_000,
          year: 2024,
          moods: [],
          filePath: "/music/track.flac",
        },
        {
          id: "track-2",
          kind: "track",
          title: "Second Track",
          rating: 0.8,
          artist: "Artist",
          album: "Album",
          playCount: 3,
          durationMs: 180_000,
          year: 2024,
          moods: [],
          filePath: "/music/track.flac",
        },
      ]);
      expect(transport.requests).toEqual([
        {
          path: "/playlists/playlist%2Fwith%20space/items",
          operation: "fetch Plex playlist tracks",
          options: {
            query: {
              "X-Plex-Container-Start": 0,
              "X-Plex-Container-Size": 1,
            },
          },
        },
        {
          path: "/playlists/playlist%2Fwith%20space/items",
          operation: "fetch Plex playlist tracks",
          options: {
            query: {
              "X-Plex-Container-Start": 1,
              "X-Plex-Container-Size": 1,
            },
          },
        },
      ]);
    });

    it("stops on an empty page even when Plex reports a larger total", async () => {
      const { capability, transport } = createSubject([returns(metadataResponse([], 50))]);

      await expect(capability.tracks("playlist-1")).resolves.toEqual([]);
      expect(transport.requests).toHaveLength(1);
    });

    it("maps missing track fields to the established defaults", async () => {
      const { capability } = createSubject([
        returns(metadataResponse([{ ratingKey: "track-2", title: "Sparse" }], 1)),
      ]);

      await expect(capability.tracks("playlist-1")).resolves.toEqual([
        {
          id: "track-2",
          kind: "track",
          title: "Sparse",
          rating: null,
          artist: "Unknown Artist",
          album: "Unknown Album",
          playCount: 0,
          durationMs: 0,
          moods: [],
          filePath: "",
        },
      ]);
    });

    it("rejects malformed track responses", async () => {
      const { capability } = createSubject([
        returns(metadataResponse([{ ratingKey: 123, title: "Invalid" }], 1)),
      ]);

      await expect(capability.tracks("playlist-1")).rejects.toMatchObject({
        code: "invalid-response",
        operation: "fetch Plex playlist tracks",
      });
    });
  });

  describe("create", () => {
    it("creates a regular playlist with an encoded machine source URI", async () => {
      const { capability, transport, cache, machineIdentifierCalls } = createSubject([
        returns(metadataResponse([audioPlaylistWire])),
      ]);

      await expect(capability.create("Road & Trip")).resolves.toEqual({
        id: "playlist-1",
        title: "Road Trip",
        smart: false,
        itemCount: 2,
        durationMs: 420_000,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
      });
      expect(machineIdentifierCalls).toEqual(["called"]);
      expect(transport.requests).toEqual([
        {
          path: "/playlists",
          operation: "create Plex playlist",
          options: {
            method: "POST",
            query: {
              title: "Road & Trip",
              smart: "0",
              type: "audio",
              uri: "server://machine-1/com.plexapp.plugins.library",
            },
          },
        },
      ]);
      expect(cache.invalidations).toEqual(["playlists"]);
    });

    it("uses the requested smart value and current epoch when Plex omits create fields", async () => {
      const { capability, transport } = createSubject([
        returns(
          metadataResponse([
            {
              ratingKey: "smart-1",
              title: "Smart",
            },
          ]),
        ),
      ]);

      await expect(capability.create("Smart", { smart: true })).resolves.toMatchObject({
        smart: true,
        itemCount: 0,
        durationMs: 0,
        createdAt: 1_800_000_000,
        updatedAt: 1_800_000_000,
      });
      expect(transport.requests[0]?.options?.query).toMatchObject({ smart: "1" });
    });

    it("does not invalidate when the create response is empty or malformed", async () => {
      const empty = createSubject([returns(metadataResponse([]))]);
      const malformed = createSubject([
        returns(metadataResponse([{ ratingKey: "missing-title" }])),
      ]);

      await expect(empty.capability.create("Empty")).rejects.toMatchObject({
        code: "invalid-response",
      });
      await expect(malformed.capability.create("Malformed")).rejects.toMatchObject({
        code: "invalid-response",
      });
      expect(empty.cache.invalidations).toEqual([]);
      expect(malformed.cache.invalidations).toEqual([]);
    });
  });

  describe("addTracks", () => {
    it("adds an empty track list as a true no-op", async () => {
      const { capability, transport, cache, machineIdentifierCalls } = createSubject([]);

      await capability.addTracks("playlist-1", []);

      expect(transport.requests).toEqual([]);
      expect(machineIdentifierCalls).toEqual([]);
      expect(cache.invalidations).toEqual([]);
    });

    it("adds tracks in one PUT with a URI containing opaque IDs", async () => {
      const { capability, transport, cache } = createSubject([returns(undefined)]);

      await capability.addTracks("playlist/1", ["track 1", "track/2"]);

      expect(transport.requests).toEqual([
        {
          path: "/playlists/playlist%2F1/items",
          operation: "add tracks to Plex playlist",
          options: {
            method: "PUT",
            query: {
              uri: "server://machine-1/com.plexapp.plugins.library/library/metadata/track%201,track%2F2",
            },
          },
        },
      ]);
      expect(cache.invalidations).toEqual(["playlists"]);
    });

    it("preserves 10,000-item batching and warns when multiple PUTs are required", async () => {
      const trackIds = Array.from({ length: 10_001 }, (_, index) => `track-${index}`);
      const { capability, transport, cache, machineIdentifierCalls, warnings } = createSubject([
        returns(undefined),
        returns(undefined),
      ]);

      await capability.addTracks("playlist-1", trackIds);

      expect(transport.requests).toHaveLength(2);
      expect(transport.requests[0]?.options?.query?.["uri"]).toContain("track-9999");
      expect(transport.requests[1]?.options?.query?.["uri"]).toMatch(/\/track-10000$/u);
      expect(machineIdentifierCalls).toEqual(["called"]);
      expect(warnings).toEqual([
        "Warning: Adding 10001 tracks requires 2 batches. Due to Plex API behavior, only the last batch of 1 tracks may be retained.",
      ]);
      expect(cache.invalidations).toEqual(["playlists"]);
    });

    it("does not replay a failed later batch and invalidates after the confirmed earlier batch", async () => {
      const failure = new MediaServerError("Plex request failed (HTTP 400)", {
        code: "request-failed",
        serverType: "plex",
        operation: "add tracks to Plex playlist",
        statusCode: 400,
        retryable: false,
      });
      const trackIds = Array.from({ length: 10_001 }, (_, index) => `track-${index}`);
      const { capability, transport, cache } = createSubject([returns(undefined), throws(failure)]);

      await expect(capability.addTracks("playlist-1", trackIds)).rejects.toBe(failure);
      expect(transport.requests).toHaveLength(2);
      expect(cache.invalidations).toEqual(["playlists"]);
    });

    it("does not invalidate when the first batch fails before any confirmed mutation", async () => {
      const failure = new MediaServerError("Plex request failed (HTTP 400)", {
        code: "request-failed",
        serverType: "plex",
        operation: "add tracks to Plex playlist",
        statusCode: 400,
        retryable: false,
      });
      const { capability, transport, cache } = createSubject([throws(failure)]);

      await expect(capability.addTracks("playlist-1", ["track-1"])).rejects.toBe(failure);
      expect(transport.requests).toHaveLength(1);
      expect(cache.invalidations).toEqual([]);
    });
  });

  describe("delete", () => {
    it("deletes an encoded opaque ID and invalidates after success", async () => {
      const { capability, transport, cache } = createSubject([returns(undefined)]);

      await capability.delete("playlist/1");

      expect(transport.requests).toEqual([
        {
          path: "/playlists/playlist%2F1",
          operation: "delete Plex playlist",
          options: { method: "DELETE" },
        },
      ]);
      expect(cache.invalidations).toEqual(["playlists"]);
    });

    it.each([
      { statusCode: 401, code: "authentication" as const },
      { statusCode: 404, code: "not-found" as const },
      { statusCode: 400, code: "request-failed" as const },
      { statusCode: 500, code: "request-failed" as const },
    ])(
      "propagates typed HTTP $statusCode errors without replay or invalidation",
      async (testCase) => {
        const failure = new MediaServerError(`HTTP ${testCase.statusCode}`, {
          code: testCase.code,
          serverType: "plex",
          operation: "delete Plex playlist",
          statusCode: testCase.statusCode,
          retryable: false,
        });
        const { capability, transport, cache } = createSubject([throws(failure)]);

        await expect(capability.delete("playlist-1")).rejects.toBe(failure);
        expect(transport.requests).toHaveLength(1);
        expect(cache.invalidations).toEqual([]);
      },
    );
  });
});
