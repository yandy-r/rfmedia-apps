import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  MediaServerError,
  type MediaServerCollectionCapability,
} from "../../../types/media-server.js";
import type { PlexResponseCache, PlexCacheKey } from "./cache.js";
import type { PlexTransport } from "./client.js";
import { createPlexCollectionCapability, type PlexMachineIdentifierLoader } from "./collections.js";
import type { PlexRequestInput } from "./types.js";

class ScriptedTransport implements PlexTransport {
  readonly requests: PlexRequestInput[] = [];
  readonly #results: unknown[];

  constructor(results: readonly unknown[]) {
    this.#results = [...results];
  }

  async request<T>(input: PlexRequestInput): Promise<T> {
    this.requests.push(input);
    if (this.#results.length === 0) {
      throw new Error(`No scripted result for ${input.operation}`);
    }
    const result = this.#results.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result as T;
  }
}

class RecordingCache implements PlexResponseCache {
  readonly enabled = true;
  readonly invalidations: string[] = [];
  readonly #values = new Map<string, unknown>();

  get<T>(key: PlexCacheKey): T | undefined {
    return this.#values.get(JSON.stringify(key)) as T | undefined;
  }

  set<T>(key: PlexCacheKey, value: T): void {
    this.#values.set(JSON.stringify(key), value);
  }

  delete(key: PlexCacheKey): boolean {
    return this.#values.delete(JSON.stringify(key));
  }

  invalidate(category: "identity" | "libraries" | "queries" | "playlists" | "collections"): number {
    this.invalidations.push(category);
    let count = 0;
    for (const key of this.#values.keys()) {
      if (key.includes(`\"category\":\"${category}\"`)) {
        this.#values.delete(key);
        count += 1;
      }
    }
    return count;
  }

  clear(): void {
    this.#values.clear();
  }
}

function collectionResponse(
  metadata: readonly Readonly<Record<string, unknown>>[] | undefined,
): unknown {
  return {
    MediaContainer: {
      size: metadata?.length ?? 0,
      ...(metadata === undefined ? {} : { Metadata: metadata }),
    },
  };
}

function collection(
  id: string,
  title: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    ratingKey: id,
    title,
    childCount: 0,
    smart: false,
    ...overrides,
  };
}

function httpError(statusCode: number): MediaServerError {
  return new MediaServerError(`Plex request failed (HTTP ${statusCode})`, {
    code: statusCode === 404 ? "not-found" : "request-failed",
    serverType: "plex",
    operation: "test",
    statusCode,
    retryable: false,
  });
}

function createCapability(
  results: readonly unknown[],
  options: { readonly pageSize?: number; readonly machineId?: string } = {},
): {
  readonly capability: MediaServerCollectionCapability;
  readonly transport: ScriptedTransport;
  readonly cache: RecordingCache;
  readonly loadMachineIdentifier: ReturnType<typeof vi.fn<PlexMachineIdentifierLoader>>;
} {
  const transport = new ScriptedTransport(results);
  const cache = new RecordingCache();
  const loadMachineIdentifier = vi
    .fn<PlexMachineIdentifierLoader>()
    .mockResolvedValue(options.machineId ?? "machine-1");
  const capability = createPlexCollectionCapability(transport, cache, loadMachineIdentifier, {
    pageSize: options.pageSize,
  });
  return { capability, transport, cache, loadMachineIdentifier };
}

describe("Plex collection reads", () => {
  it("lists and maps typed collections, then serves the adapter-local cache", async () => {
    const { capability, transport } = createCapability([
      collectionResponse([
        collection("collection-1", "Tracks", {
          childCount: 10,
          subtype: "track",
          metadataType: 10,
        }),
        collection("collection-2", "Artists", {
          childCount: 3,
          smart: true,
          subtype: "artist",
          metadataType: 8,
        }),
      ]),
    ]);

    const first = await capability.list("library/1");
    const second = await capability.list("library/1");

    expect(first).toEqual([
      { id: "collection-1", title: "Tracks", kind: "track", itemCount: 10, smart: false },
      { id: "collection-2", title: "Artists", kind: "artist", itemCount: 3, smart: true },
    ]);
    expect(second).toBe(first);
    expect(transport.requests).toEqual([
      {
        path: "/library/sections/library%2F1/collections",
        operation: "list collections",
      },
    ]);
  });

  it("preserves an empty list when collection metadata is absent", async () => {
    const { capability, transport } = createCapability([collectionResponse(undefined)]);

    expect(await capability.list("1")).toEqual([]);
    expect(await capability.list("1")).toEqual([]);
    expect(transport.requests).toHaveLength(1);
  });

  it("rejects malformed list responses instead of caching them", async () => {
    const { capability, cache } = createCapability([{ MediaContainer: { Metadata: "invalid" } }]);

    await expect(capability.list("1")).rejects.toMatchObject({
      code: "invalid-response",
      operation: "list collections",
    });
    expect(cache.invalidations).toEqual([]);
  });

  it("gets one collection and honors subtype metadata", async () => {
    const { capability, transport } = createCapability([
      collectionResponse([
        collection("collection-1", "Albums", {
          childCount: 12,
          subtype: "album",
          metadataType: 9,
        }),
      ]),
    ]);

    await expect(capability.get("collection/1")).resolves.toEqual({
      id: "collection-1",
      title: "Albums",
      kind: "album",
      itemCount: 12,
      smart: false,
    });
    expect(transport.requests[0]?.path).toBe("/library/collections/collection%2F1");
  });

  it("reports absent and malformed single-collection payloads distinctly", async () => {
    const { capability } = createCapability([
      collectionResponse([]),
      collectionResponse([{ ratingKey: "collection-1" }]),
    ]);

    await expect(capability.get("missing")).rejects.toMatchObject({ code: "not-found" });
    await expect(capability.get("broken")).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("finds a collection case-insensitively and reports available names", async () => {
    const { capability } = createCapability([
      collectionResponse([
        collection("collection-1", "My Favorites"),
        collection("collection-2", "Rock Collection"),
      ]),
      collectionResponse([]),
    ]);

    await expect(capability.byName("1", "my favorites")).resolves.toMatchObject({
      id: "collection-1",
    });
    await expect(capability.byName("2", "Missing")).rejects.toThrow("(no collections found)");
  });

  it("includes collection names when a lookup does not match", async () => {
    const { capability } = createCapability([
      collectionResponse([
        collection("collection-1", "Collection A"),
        collection("collection-2", "Collection B"),
      ]),
    ]);

    await expect(capability.byName("1", "Missing")).rejects.toThrow(
      /Collection "Missing" not found.*Collection A, Collection B/,
    );
  });
});

describe("Plex collection items", () => {
  it("maps track, album, and artist children to generic discriminated entities", async () => {
    const { capability } = createCapability([
      {
        MediaContainer: {
          size: 3,
          totalSize: 3,
          offset: 0,
          Metadata: [
            {
              ratingKey: "track-1",
              title: "Track",
              type: "track",
              grandparentTitle: "Artist",
              parentTitle: "Album",
              userRating: 8,
              viewCount: 2,
              duration: 180_000,
              Media: [{ Part: [{ file: "/music/track.flac" }] }],
            },
            {
              ratingKey: "album-1",
              title: "Album",
              type: "album",
              parentTitle: "Artist",
              userRating: 10,
              leafCount: 12,
              thumb: "/album.jpg",
            },
            {
              ratingKey: "artist-1",
              title: "Artist",
              type: "artist",
              userRating: 6,
              leafCount: 5,
              thumb: "/artist.jpg",
            },
          ],
        },
      },
    ]);

    const items = await capability.items("collection-1");

    expect(items).toMatchObject([
      {
        id: "track-1",
        kind: "track",
        artist: "Artist",
        album: "Album",
        rating: 0.8,
        filePath: "/music/track.flac",
      },
      {
        id: "album-1",
        kind: "album",
        artist: "Artist",
        rating: 1,
        trackCount: 12,
        artworkPath: "/album.jpg",
      },
      {
        id: "artist-1",
        kind: "artist",
        rating: 0.6,
        albumCount: 5,
        artworkPath: "/artist.jpg",
      },
    ]);
  });

  it("paginates from response metadata using the captured page size", async () => {
    const { capability, transport } = createCapability(
      [
        {
          MediaContainer: {
            size: 1,
            totalSize: 2,
            offset: 0,
            Metadata: [{ ratingKey: "track-1", title: "One", type: "track" }],
          },
        },
        {
          MediaContainer: {
            size: 1,
            totalSize: 2,
            offset: 1,
            Metadata: [{ ratingKey: "track-2", title: "Two", type: "track" }],
          },
        },
      ],
      { pageSize: 1 },
    );

    await expect(capability.items("collection-1")).resolves.toHaveLength(2);
    expect(transport.requests.map((request) => request.options?.query)).toEqual([
      { "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 1 },
      { "X-Plex-Container-Start": 1, "X-Plex-Container-Size": 1 },
    ]);
  });

  it("returns an empty array for an empty collection", async () => {
    const { capability } = createCapability([
      { MediaContainer: { size: 0, totalSize: 0, Metadata: [] } },
    ]);

    await expect(capability.items("collection-1")).resolves.toEqual([]);
  });

  it("propagates typed not-found errors and rejects malformed children", async () => {
    const { capability } = createCapability([
      httpError(404),
      {
        MediaContainer: {
          size: 1,
          totalSize: 1,
          Metadata: [{ ratingKey: "broken", title: "Broken", userRating: "8" }],
        },
      },
    ]);

    await expect(capability.items("missing")).rejects.toMatchObject({
      code: "not-found",
      statusCode: 404,
    });
    await expect(capability.items("broken")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("maps an out-of-range child rating to a typed invalid-response error", async () => {
    const { capability } = createCapability([
      {
        MediaContainer: {
          size: 1,
          totalSize: 1,
          Metadata: [{ ratingKey: "track-1", title: "Track", type: "track", userRating: 11 }],
        },
      },
    ]);

    await expect(capability.items("collection-1")).rejects.toMatchObject({
      name: "MediaServerError",
      code: "invalid-response",
      operation: "get collection items",
      retryable: false,
    });
  });
});

describe("Plex collection creation and deletion", () => {
  it.each([
    ["artist", 8],
    ["album", 9],
    ["track", 10],
  ] as const)("creates a static %s collection using Plex type %i", async (kind, type) => {
    const { capability, transport, cache } = createCapability([
      collectionResponse([collection(`${kind}-collection`, "New", {})]),
    ]);

    const created = await capability.create("library-1", { title: "New", kind });

    expect(created.kind).toBe(kind);
    expect(transport.requests[0]).toEqual({
      path: "/library/collections",
      operation: "create collection",
      options: {
        method: "POST",
        query: { type, title: "New", smart: 0, sectionId: "library-1" },
      },
    });
    expect(cache.invalidations).toEqual(["collections"]);
  });

  it("allows duplicate titles because Plex assigns opaque IDs", async () => {
    const { capability } = createCapability([
      collectionResponse([collection("collection-2", "Duplicate Name")]),
    ]);

    await expect(
      capability.create("library-1", { title: "Duplicate Name", kind: "track" }),
    ).resolves.toMatchObject({ id: "collection-2", title: "Duplicate Name" });
  });

  it("does not invalidate when create fails or returns malformed metadata", async () => {
    const { capability, cache } = createCapability([httpError(404), collectionResponse(undefined)]);

    await expect(
      capability.create("missing", { title: "New", kind: "track" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      capability.create("library-1", { title: "New", kind: "track" }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(cache.invalidations).toEqual([]);
  });

  it("deletes by opaque ID and invalidates only after success", async () => {
    const { capability, transport, cache } = createCapability([undefined, httpError(404)]);

    await capability.delete("collection/1");
    await expect(capability.delete("missing")).rejects.toMatchObject({ statusCode: 404 });

    expect(transport.requests[0]).toEqual({
      path: "/library/collections/collection%2F1",
      operation: "delete collection",
      options: { method: "DELETE" },
    });
    expect(cache.invalidations).toEqual(["collections"]);
  });
});

describe("Plex collection additions", () => {
  it("builds one machine-ID source URI for a successful batch", async () => {
    const { capability, transport, cache, loadMachineIdentifier } = createCapability([undefined], {
      machineId: "machine-abc",
    });

    await capability.addItems("collection-1", ["100", "101", "102"]);

    expect(loadMachineIdentifier).toHaveBeenCalledTimes(1);
    expect(transport.requests).toEqual([
      {
        path: "/library/collections/collection-1/items",
        operation: "add collection items",
        options: {
          method: "PUT",
          query: {
            uri: "server://machine-abc/com.plexapp.plugins.library/library/metadata/100,101,102",
          },
        },
      },
    ]);
    expect(cache.invalidations).toEqual(["collections"]);
  });

  it("splits additions into batches of at most 50 items", async () => {
    const itemIds = Array.from({ length: 51 }, (_, index) => String(index + 1));
    const { capability, transport } = createCapability([undefined, undefined]);

    await capability.addItems("collection-1", itemIds);

    expect(transport.requests).toHaveLength(2);
    expect(String(transport.requests[0]?.options?.query?.["uri"])).toContain(
      `/metadata/${itemIds.slice(0, 50).join(",")}`,
    );
    expect(String(transport.requests[1]?.options?.query?.["uri"])).toContain("/metadata/51");
  });

  it("is a no-op for empty input without loading identity or invalidating", async () => {
    const { capability, transport, cache, loadMachineIdentifier } = createCapability([]);

    await capability.addItems("collection-1", []);

    expect(loadMachineIdentifier).not.toHaveBeenCalled();
    expect(transport.requests).toEqual([]);
    expect(cache.invalidations).toEqual([]);
  });

  it("does not replay a non-400 failed mutation", async () => {
    const { capability, transport, cache } = createCapability([httpError(500)]);

    await expect(capability.addItems("collection-1", ["100", "101"])).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(transport.requests).toHaveLength(1);
    expect(cache.invalidations).toEqual([]);
  });

  it("recovers from exact HTTP 400 one item at a time, issuing each fallback once", async () => {
    const { capability, transport, cache } = createCapability([
      httpError(400),
      undefined,
      httpError(500),
      undefined,
    ]);

    await capability.addItems("collection-1", ["100", "101", "102"]);

    expect(transport.requests).toHaveLength(4);
    expect(transport.requests.slice(1).map((request) => request.options?.query?.["uri"])).toEqual([
      "server://machine-1/com.plexapp.plugins.library/library/metadata/100",
      "server://machine-1/com.plexapp.plugins.library/library/metadata/101",
      "server://machine-1/com.plexapp.plugins.library/library/metadata/102",
    ]);
    expect(cache.invalidations).toEqual(["collections"]);
  });

  it("throws and does not invalidate when every explicit fallback request fails", async () => {
    const { capability, transport, cache } = createCapability([
      httpError(400),
      httpError(500),
      new TypeError("network failed"),
    ]);

    await expect(capability.addItems("collection-1", ["100", "101"])).rejects.toMatchObject({
      code: "request-failed",
      retryable: false,
    });
    expect(transport.requests).toHaveLength(3);
    expect(cache.invalidations).toEqual([]);
  });

  it("invalidates confirmed earlier mutations when a later batch fails", async () => {
    const itemIds = Array.from({ length: 51 }, (_, index) => String(index + 1));
    const { capability, cache } = createCapability([undefined, httpError(500)]);

    await expect(capability.addItems("collection-1", itemIds)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(cache.invalidations).toEqual(["collections"]);
  });
});

describe("Plex collection capability construction", () => {
  it("returns the generic capability without exposing provider identity inputs", () => {
    const { capability } = createCapability([]);

    expectTypeOf(capability).toEqualTypeOf<MediaServerCollectionCapability>();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(capability)).toEqual([
      "list",
      "get",
      "byName",
      "items",
      "create",
      "addItems",
      "delete",
    ]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid page size %s at construction",
    (pageSize) => {
      expect(() => createCapability([], { pageSize })).toThrow("positive safe integer");
    },
  );
});
