import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MediaServerError,
  type MediaAlbum,
  type MediaArtist,
  type MediaPage,
  type MediaQueryOptions,
  type MediaServerAdapter,
  type MediaTrack,
  type NormalizedMediaRating,
} from "./media-server.js";
import type { MediaFilterField, MediaFilterOperator } from "./media-filters.js";

const track: MediaTrack = {
  id: "song-1",
  kind: "track",
  title: "Example Song",
  rating: 0.75,
  artist: "Example Artist",
  album: "Example Album",
  playCount: 4,
  durationMs: 180_000,
  filePath: "/media/example-song.flac",
  genres: ["Electronic"],
};

const album: MediaAlbum = {
  id: "release-1",
  kind: "album",
  title: "Example Album",
  rating: null,
  artist: "Example Artist",
  trackCount: 1,
};

const artist: MediaArtist = {
  id: "performer-1",
  kind: "artist",
  title: "Example Artist",
  rating: 1,
  albumCount: 1,
};

function page<T extends MediaTrack | MediaAlbum | MediaArtist>(item: T): MediaPage<T> {
  return {
    items: [item],
    total: 1,
    offset: 0,
    returned: 1,
    hasMore: false,
  };
}

function createFakeAdapter(): MediaServerAdapter {
  return {
    type: "example-server",
    capabilities: {
      query: true,
      library: true,
      scan: true,
      playlist: true,
      collection: true,
      metadata: true,
    },
    features: {
      ratings: {
        readable: true,
        writable: true,
        normalized: true,
        nativeScale: { min: 0, max: 100, step: 1 },
      },
      smartPlaylists: false,
      smartCollections: false,
      pathScopedScans: true,
      filterPushdown: {
        supported: false,
        fields: [],
        operators: [],
      },
      sonicAnalysis: "unavailable",
    },
    query: {
      libraryContentVersion: async () => ({
        libraryId: "library-1",
        value: "content-version-1",
      }),
      trackById: async () => track,
      tracks: async () => page(track),
      albums: async () => page(album),
      artists: async () => page(artist),
      albumTracks: async () => [track],
    },
    library: {
      list: async () => [{ id: "library-1", title: "Music", kind: "track" }],
      byName: async (name) => ({ id: "library-1", title: name, kind: "track" }),
    },
    scan: {
      trigger: async () => ({ success: true, message: "Scan requested" }),
      triggerPath: async () => ({ success: true, message: "Path scan requested" }),
      triggerSource: async () => ({ success: true, message: "Source scan requested" }),
    },
    playlist: {
      list: async () => [],
      byName: async (name) => ({
        id: "playlist-1",
        title: name,
        smart: false,
        itemCount: 1,
        durationMs: track.durationMs,
      }),
      delete: async () => undefined,
      tracks: async () => [track],
      create: async (name, options) => ({
        id: "playlist-1",
        title: name,
        smart: options?.smart ?? false,
        itemCount: 0,
        durationMs: 0,
      }),
      addTracks: async () => undefined,
    },
    collection: {
      list: async () => [],
      get: async (id) => ({ id, title: "Collection", kind: "track", itemCount: 1, smart: false }),
      byName: async (_libraryId, name) => ({
        id: "collection-1",
        title: name,
        kind: "track",
        itemCount: 1,
        smart: false,
      }),
      items: async () => [track],
      create: async (_libraryId, input) => ({
        id: "collection-1",
        title: input.title,
        kind: input.kind,
        itemCount: 0,
        smart: false,
      }),
      addItems: async () => undefined,
      delete: async () => undefined,
    },
    metadata: {
      updateTrackRating: async () => ({ success: true, message: "Rating updated" }),
    },
  };
}

describe("MediaServerAdapter contract", () => {
  it("supports a provider-neutral adapter with opaque IDs and discriminated entities", async () => {
    const adapter = createFakeAdapter();
    const result = await adapter.query.tracks({ library: "Music", kind: "track" });

    expect(adapter.type).toBe("example-server");
    expect(result).toEqual(page(track));
    expect(result.returned).toBe(1);
    expect(result.items[0]).toMatchObject({ id: "song-1", kind: "track", rating: 0.75 });
    expect(result.items[0]).not.toHaveProperty("ratingKey");
    expect(result.items[0]).not.toHaveProperty("userRating");

    expectTypeOf(adapter.query.tracks)
      .parameter(0)
      .toEqualTypeOf<MediaQueryOptions & { readonly kind: "track" }>();
    expectTypeOf(adapter.query.trackById).parameters.toEqualTypeOf<
      [trackId: string, options?: { readonly signal?: AbortSignal }]
    >();
    expectTypeOf(result).toEqualTypeOf<MediaPage<MediaTrack>>();
    expectTypeOf(result.items[0]?.rating).toEqualTypeOf<NormalizedMediaRating | null | undefined>();
  });

  it("limits filter pushdown metadata to the provider-neutral vocabulary", () => {
    const pushdown = createFakeAdapter().features.filterPushdown;

    expectTypeOf(pushdown.fields).toEqualTypeOf<readonly MediaFilterField[]>();
    expectTypeOf(pushdown.operators).toEqualTypeOf<readonly MediaFilterOperator[]>();
  });

  it("keeps provider-only identifiers and native rating values out of operations", async () => {
    const adapter = createFakeAdapter();

    await expect(adapter.collection.addItems("collection-1", ["song-1"])).resolves.toBeUndefined();
    await expect(adapter.metadata.updateTrackRating("song-1", null)).resolves.toEqual({
      success: true,
      message: "Rating updated",
    });

    expectTypeOf(adapter.collection.addItems).parameters.toEqualTypeOf<
      [id: string, itemIds: readonly string[]]
    >();
    expectTypeOf(adapter.metadata.updateTrackRating).parameters.toEqualTypeOf<
      [trackId: string, rating: NormalizedMediaRating | null]
    >();
  });

  it("throws typed query failures while scan and rating operations return result objects", async () => {
    const error = new MediaServerError("Query failed", {
      code: "network",
      serverType: "example-server",
      operation: "query tracks",
      retryable: true,
      cause: new Error("connection reset"),
    });
    const adapter = createFakeAdapter();
    const failingAdapter: MediaServerAdapter = {
      ...adapter,
      query: {
        ...adapter.query,
        tracks: async () => {
          throw error;
        },
      },
      scan: {
        ...adapter.scan,
        trigger: async () => ({ success: false, message: "Scan unavailable", statusCode: 503 }),
      },
      metadata: {
        updateTrackRating: async () => ({
          success: false,
          message: "Rating unavailable",
          statusCode: 503,
        }),
      },
    };

    await expect(failingAdapter.query.tracks({ library: "Music", kind: "track" })).rejects.toBe(
      error,
    );
    await expect(failingAdapter.scan.trigger()).resolves.toMatchObject({
      success: false,
      statusCode: 503,
    });
    await expect(failingAdapter.metadata.updateTrackRating("song-1", 0.5)).resolves.toMatchObject({
      success: false,
      statusCode: 503,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "MediaServerError",
      code: "network",
      serverType: "example-server",
      operation: "query tracks",
      retryable: true,
    });
    expect(error.cause).toBeInstanceOf(Error);
  });
});
