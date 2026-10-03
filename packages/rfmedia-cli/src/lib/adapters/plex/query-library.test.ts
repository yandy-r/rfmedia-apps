import { describe, expect, it, vi } from "vitest";

import { MediaServerError } from "../../../types/media-server.js";
import type { PlexRequestInput } from "./types.js";
import { createPlexResponseCache } from "./cache.js";
import type { PlexTransport } from "./client.js";
import { createPlexQueryLibraryFamily } from "./query-library.js";

interface TransportHarness {
  readonly transport: PlexTransport;
  readonly requests: PlexRequestInput[];
}

function createTransport(...responses: readonly unknown[]): TransportHarness {
  const pending = [...responses];
  const requests: PlexRequestInput[] = [];
  const transport: PlexTransport = {
    async request<T>(input: PlexRequestInput): Promise<T> {
      requests.push(input);
      const response = pending.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response as T;
    },
  };
  return { transport, requests };
}

function createPendingTransport(...responses: readonly unknown[]): TransportHarness {
  const pending = [...responses];
  const requests: PlexRequestInput[] = [];
  const transport: PlexTransport = {
    request<T>(input: PlexRequestInput): Promise<T> {
      requests.push(input);
      if (pending.length > 0) {
        return Promise.resolve(pending.shift() as T);
      }
      return new Promise<T>((_resolve, reject) => {
        input.options?.signal?.addEventListener(
          "abort",
          () => reject(input.options?.signal?.reason),
          { once: true },
        );
      });
    },
  };
  return { transport, requests };
}

function createFamily(
  harness: TransportHarness,
  options: {
    readonly cacheEnabled?: boolean;
    readonly libraryName?: string;
    readonly mappings?: readonly { readonly path: string; readonly library: string }[];
    readonly pageSize?: number;
  } = {},
) {
  return createPlexQueryLibraryFamily({
    transport: harness.transport,
    cache: createPlexResponseCache({
      enabled: options.cacheEnabled ?? true,
      ttlSeconds: 300,
    }),
    defaultLibraryName: options.libraryName,
    libraryMappings: options.mappings,
    pageSize: options.pageSize,
  });
}

const librariesResponse = {
  MediaContainer: {
    Directory: [
      { key: "1", title: "Music", type: "artist" },
      { key: "2", title: "Audiobooks", type: "artist" },
      { key: "3", title: "Movies", type: "movie" },
    ],
  },
};
const MAX_ISO_EPOCH_SECONDS = 8_640_000_000_000;

function libraryVersionResponse(contentChangedAt: number) {
  return {
    MediaContainer: {
      Directory: [
        {
          key: "1",
          title: "Music",
          type: "artist",
          uuid: "music-library-uuid",
          contentChangedAt,
        },
      ],
    },
  };
}

describe("Plex query and library capability family", () => {
  it("maps guarded track pages and encodes supported Plex pushdown fields", async () => {
    const harness = createTransport(librariesResponse, {
      MediaContainer: {
        size: 1,
        totalSize: 11,
        offset: 10,
        Metadata: [
          {
            ratingKey: "track/1",
            title: "Needle",
            grandparentTitle: "Artist",
            parentTitle: "Album",
            userRating: 8,
            viewCount: 4,
            lastViewedAt: MAX_ISO_EPOCH_SECONDS,
            duration: 1234,
            year: 2024,
            Mood: [{ tag: "Bright" }],
            Media: [{ Part: [{ file: "/music/needle.flac" }] }],
          },
        ],
      },
    });
    const family = createFamily(harness);

    const page = await family.query.tracks({
      kind: "track",
      library: "music",
      offset: 10,
      limit: 25,
      filter: {
        match: "all",
        rules: [
          { type: "rule", field: "artistRating", operator: ">=", value: 4 },
          { type: "rule", field: "album", operator: "not_contains", value: "Live" },
          { type: "rule", field: "minPlays", operator: ">=", value: 3 },
        ],
      },
    });

    expect(page).toEqual({
      items: [
        {
          id: "track/1",
          kind: "track",
          title: "Needle",
          rating: 0.8,
          artist: "Artist",
          album: "Album",
          playCount: 4,
          lastViewedAt: MAX_ISO_EPOCH_SECONDS,
          durationMs: 1234,
          year: 2024,
          moods: ["Bright"],
          filePath: "/music/needle.flac",
        },
      ],
      total: 11,
      offset: 10,
      returned: 1,
      hasMore: false,
    });
    expect(harness.requests[1]).toEqual({
      path: "/library/sections/1/all",
      operation: "query Plex tracks",
      options: {
        method: "GET",
        query: {
          type: 10,
          "X-Plex-Container-Start": 10,
          "X-Plex-Container-Size": 25,
          "artist.userRating>": 8,
          "album.title!": "Live",
          "viewCount>": 3,
        },
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
  ])("rejects track pages with lastViewedAt and a %s viewCount", async (_case, viewCount) => {
    const family = createFamily(
      createTransport(librariesResponse, {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "track/2",
              title: "Broken",
              ...(viewCount === undefined ? {} : { viewCount }),
              lastViewedAt: 1_725_004_800,
            },
          ],
        },
      }),
    );

    await expect(family.query.tracks({ kind: "track", library: "Music" })).rejects.toMatchObject({
      code: "invalid-response",
      operation: "query Plex tracks",
    });
  });

  it("rejects a track page beyond the ISO-renderable epoch range", async () => {
    const family = createFamily(
      createTransport(librariesResponse, {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "track/2",
              title: "Broken",
              viewCount: 1,
              lastViewedAt: MAX_ISO_EPOCH_SECONDS + 1,
            },
          ],
        },
      }),
    );

    await expect(family.query.tracks({ kind: "track", library: "Music" })).rejects.toMatchObject({
      code: "invalid-response",
      operation: "query Plex tracks",
    });
  });

  it("queries albums, artists, and encoded album children with generic mappings", async () => {
    const harness = createTransport(
      librariesResponse,
      {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "album-1",
              title: "Record",
              parentTitle: "Band",
              userRating: 6,
              leafCount: 9,
              Style: [{ tag: "Indie" }],
            },
          ],
        },
      },
      {
        MediaContainer: {
          Metadata: [{ ratingKey: "artist-1", title: "Band", userRating: 10, childCount: 2 }],
        },
      },
      {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "track-1",
              title: "Song",
              grandparentTitle: "Band",
              parentTitle: "Record",
            },
          ],
        },
      },
    );
    const family = createFamily(harness);

    await expect(family.query.albums({ kind: "album", library: "Music" })).resolves.toMatchObject({
      items: [{ id: "album-1", kind: "album", rating: 0.6 }],
    });
    await expect(family.query.artists({ kind: "artist", library: "Music" })).resolves.toMatchObject(
      { items: [{ id: "artist-1", kind: "artist", rating: 1 }] },
    );
    await expect(family.query.albumTracks("album/one ?")).resolves.toMatchObject([
      { id: "track-1", kind: "track" },
    ]);

    expect(harness.requests.at(-1)?.path).toBe("/library/metadata/album%2Fone%20%3F/children");
  });

  it("fetches exact track evidence without consulting or populating the response cache", async () => {
    const trackResponse = {
      MediaContainer: {
        Metadata: [
          {
            ratingKey: "track/1",
            title: "Needle",
            grandparentTitle: "Artist",
            parentTitle: "Album",
            userRating: 8,
            Media: [{ Part: [{ file: "/music/needle.flac" }] }],
          },
        ],
      },
    };
    const harness = createTransport(trackResponse, trackResponse);
    const family = createFamily(harness, { cacheEnabled: true });

    await expect(family.query.trackById("track/1")).resolves.toMatchObject({
      id: "track/1",
      filePath: "/music/needle.flac",
      rating: 0.8,
    });
    await expect(family.query.trackById("track/1")).resolves.toMatchObject({
      id: "track/1",
    });

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests).toEqual([
      {
        path: "/library/metadata/track%2F1",
        operation: "fetch Plex track",
        options: { method: "GET", signal: undefined },
      },
      {
        path: "/library/metadata/track%2F1",
        operation: "fetch Plex track",
        options: { method: "GET", signal: undefined },
      },
    ]);
  });

  it("fetches an uncached Plex ChangeStamp token for the selected library", async () => {
    const controller = new AbortController();
    const harness = createTransport(libraryVersionResponse(417), libraryVersionResponse(418));
    const family = createFamily(harness, { cacheEnabled: true });

    await expect(
      family.query.libraryContentVersion("music", { signal: controller.signal }),
    ).resolves.toEqual({
      libraryId: "1",
      value: '["music-library-uuid",417]',
    });
    await expect(family.query.libraryContentVersion("Music")).resolves.toEqual({
      libraryId: "1",
      value: '["music-library-uuid",418]',
    });

    expect(harness.requests).toEqual([
      {
        path: "/library/sections",
        operation: "fetch Plex library content version",
        options: { method: "GET", signal: controller.signal },
      },
      {
        path: "/library/sections",
        operation: "fetch Plex library content version",
        options: { method: "GET", signal: undefined },
      },
    ]);
  });

  it("fails closed when Plex omits its library content ChangeStamp", async () => {
    const harness = createTransport(librariesResponse);
    const family = createFamily(harness);

    await expect(family.query.libraryContentVersion("Music")).rejects.toMatchObject({
      code: "invalid-response",
      operation: "fetch Plex library content version",
    });
  });

  it("applies only residual nested rules while retaining pre-filter page counts", async () => {
    const harness = createTransport(librariesResponse, {
      MediaContainer: {
        totalSize: 7,
        offset: 0,
        Metadata: [
          {
            ratingKey: "1",
            title: "Keep Me",
            grandparentTitle: "Band",
            parentTitle: "Record",
            Media: [{ Part: [{ file: "/one.flac" }] }],
          },
          {
            ratingKey: "2",
            title: "Discard Me",
            grandparentTitle: "Band",
            parentTitle: "Record",
            Media: [{ Part: [{ file: "/two.flac" }] }],
          },
        ],
      },
    });
    const family = createFamily(harness);

    const page = await family.query.tracks({
      kind: "track",
      library: "Music",
      filter: {
        match: "all",
        rules: [
          { type: "rule", field: "genre", operator: "contains", value: "Rock" },
          {
            type: "group",
            match: "any",
            rules: [
              { type: "rule", field: "title", operator: "contains", value: "Keep" },
              { type: "rule", field: "title", operator: "contains", value: "Another" },
            ],
          },
        ],
      },
    });

    expect(page.items.map(({ id }) => id)).toEqual(["1"]);
    expect(page.returned).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(harness.requests[1]?.options?.query).toMatchObject({ genre: "Rock" });
  });

  it("does not push top-level OR rules that would change pagination semantics", async () => {
    const harness = createTransport(librariesResponse, {
      MediaContainer: {
        Metadata: [
          {
            ratingKey: "1",
            title: "Keep",
            grandparentTitle: "Artist",
            parentTitle: "Album",
          },
        ],
      },
    });
    const family = createFamily(harness);

    await family.query.tracks({
      kind: "track",
      library: "Music",
      filter: {
        match: "any",
        rules: [
          { type: "rule", field: "title", operator: "contains", value: "Keep" },
          { type: "rule", field: "artist", operator: "contains", value: "Other" },
        ],
      },
    });

    expect(harness.requests[1]?.options?.query).toEqual({
      type: 10,
      "X-Plex-Container-Start": 0,
      "X-Plex-Container-Size": 100,
    });
  });

  it("returns cache hits identical to live libraries and query pages", async () => {
    const harness = createTransport(librariesResponse, {
      MediaContainer: {
        Metadata: [{ ratingKey: "1", title: "Song", grandparentTitle: "A", parentTitle: "B" }],
      },
    });
    const family = createFamily(harness);

    const firstLibraries = await family.library.list();
    const secondLibraries = await family.library.list();
    const firstPage = await family.query.tracks({ kind: "track", library: "Music" });
    const secondPage = await family.query.tracks({ kind: "track", library: "Music" });

    expect(secondLibraries).toEqual(firstLibraries);
    expect(secondPage).toEqual(firstPage);
    expect(harness.requests).toHaveLength(2);
  });

  it("keeps query cancellation out of cache identity and rejects aborted cache-hit callers", async () => {
    const harness = createTransport(librariesResponse, {
      MediaContainer: {
        Metadata: [{ ratingKey: "1", title: "Song", grandparentTitle: "A", parentTitle: "B" }],
      },
    });
    const family = createFamily(harness);
    const first = new AbortController();
    const second = new AbortController();

    const livePage = await family.query.tracks({
      kind: "track",
      library: "Music",
      signal: first.signal,
    });
    await expect(
      family.query.tracks({
        kind: "track",
        library: "Music",
        signal: second.signal,
      }),
    ).resolves.toEqual(livePage);

    const aborted = AbortSignal.abort(new Error("stop cached query"));
    await expect(
      family.query.tracks({ kind: "track", library: "Music", signal: aborted }),
    ).rejects.toBe(aborted.reason);
    expect(harness.requests).toHaveLength(2);
  });

  it("cancels an in-flight query page after library resolution", async () => {
    const harness = createPendingTransport(librariesResponse);
    const family = createFamily(harness);
    const controller = new AbortController();
    const reason = new Error("stop query page");

    const pending = family.query.tracks({
      kind: "track",
      library: "Music",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(harness.requests[1]).toMatchObject({
      path: "/library/sections/1/all",
      options: { signal: controller.signal },
    });
  });

  it("finds libraries case-insensitively and reports available names", async () => {
    const harness = createTransport(librariesResponse);
    const family = createFamily(harness);

    await expect(family.library.byName("aUdIoBoOkS")).resolves.toMatchObject({
      id: "2",
      title: "Audiobooks",
    });
    await expect(family.library.byName("Missing")).rejects.toMatchObject({
      code: "not-found",
      operation: "find Plex library",
      message: 'Library "Missing" not found. Available: Music, Audiobooks',
    });
  });

  it("classifies empty provider identifiers as configuration failures before transport", async () => {
    const harness = createTransport();
    const family = createFamily(harness);

    await expect(family.query.albumTracks("")).rejects.toMatchObject({
      code: "configuration",
      operation: "fetch Plex album tracks",
    });
    await expect(family.query.trackById("")).rejects.toMatchObject({
      code: "configuration",
      operation: "fetch Plex track",
    });
    await expect(family.scan.triggerPath("", "/music")).resolves.toMatchObject({
      success: false,
      message: "Plex resource identifier must not be empty",
    });
    expect(harness.requests).toHaveLength(0);
  });

  it("rejects malformed library, identity, and metadata responses with typed errors", async () => {
    const malformedLibrary = createFamily(createTransport({ MediaContainer: {} }));
    await expect(malformedLibrary.library.list()).rejects.toMatchObject({
      code: "invalid-response",
      operation: "list Plex libraries",
    });

    const malformedIdentity = createFamily(
      createTransport({ MediaContainer: { machineIdentifier: "" } }),
    );
    await expect(malformedIdentity.getMachineIdentifier()).rejects.toBeInstanceOf(MediaServerError);

    const malformedPage = createFamily(
      createTransport(librariesResponse, {
        MediaContainer: { Metadata: [{ ratingKey: "1", title: 42 }] },
      }),
    );
    await expect(
      malformedPage.query.tracks({ kind: "track", library: "Music" }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("caches the private machine identifier per family", async () => {
    const harness = createTransport({
      MediaContainer: { machineIdentifier: "machine-123", friendlyName: "Server" },
    });
    const family = createFamily(harness);

    await expect(family.getMachineIdentifier()).resolves.toBe("machine-123");
    await expect(family.getMachineIdentifier()).resolves.toBe("machine-123");
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.path).toBe("/");
  });

  it("cancels an in-flight private library-resolution request", async () => {
    const harness = createPendingTransport();
    const family = createFamily(harness);
    const controller = new AbortController();
    const reason = new Error("stop library resolution");

    const pending = family.findLibrary("Music", { signal: controller.signal });
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(harness.requests[0]).toMatchObject({
      path: "/library/sections",
      options: { signal: controller.signal },
    });
  });

  it("cancels an in-flight private machine-identity request", async () => {
    const harness = createPendingTransport();
    const family = createFamily(harness);
    const controller = new AbortController();
    const reason = new Error("stop machine identity");

    const pending = family.getMachineIdentifier({ signal: controller.signal });
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(harness.requests[0]).toMatchObject({
      path: "/",
      options: { signal: controller.signal },
    });
  });

  it("rejects a page that claims more results without making progress", async () => {
    const harness = createTransport(librariesResponse, {
      MediaContainer: { totalSize: 3, offset: 0, Metadata: [] },
    });
    const family = createFamily(harness);

    await expect(family.query.tracks({ kind: "track", library: "Music" })).rejects.toThrow(
      "Pagination stalled while querying Plex tracks",
    );
  });
});

describe("Plex scan capability family", () => {
  it("scans all libraries or the configured default library", async () => {
    const allHarness = createTransport(undefined);
    const allFamily = createFamily(allHarness);
    await expect(allFamily.scan.trigger()).resolves.toEqual({
      success: true,
      message: "Scan triggered for all libraries",
    });
    expect(allHarness.requests[0]?.path).toBe("/library/sections/all/refresh");

    const namedHarness = createTransport(librariesResponse, undefined);
    const namedFamily = createFamily(namedHarness, { libraryName: "music" });
    await expect(namedFamily.scan.trigger()).resolves.toMatchObject({
      success: true,
      libraryName: "Music",
    });
    expect(namedHarness.requests[1]?.path).toBe("/library/sections/1/refresh");
  });

  it("uses structured path queries and retains optional failure result semantics", async () => {
    const failure = new MediaServerError("Plex authentication failed (HTTP 401)", {
      code: "authentication",
      serverType: "plex",
      operation: "scan Plex path",
      statusCode: 401,
      retryable: false,
    });
    const harness = createTransport(failure);
    const family = createFamily(harness);

    await expect(family.scan.triggerPath("section/1", "/Music/A & B")).resolves.toEqual({
      success: false,
      message: "Plex authentication failed (HTTP 401)",
      statusCode: 401,
    });
    expect(harness.requests[0]).toMatchObject({
      path: "/library/sections/section%2F1/refresh",
      options: { query: { path: "/Music/A & B" } },
    });
  });

  it("matches the most-specific mapped path for a source scan", async () => {
    const harness = createTransport(librariesResponse, undefined);
    const family = createFamily(harness, {
      mappings: [
        { path: "/media", library: "Music" },
        { path: "/media/audiobooks", library: "Audiobooks" },
      ],
    });

    await expect(family.scan.triggerSource("/media/audiobooks/Author/Book")).resolves.toMatchObject(
      {
        success: true,
        libraryName: "Audiobooks",
      },
    );
    expect(harness.requests[1]).toMatchObject({
      path: "/library/sections/2/refresh",
      options: { query: { path: "/media/audiobooks/Author/Book" } },
    });
  });

  it("falls back to a whole scan when no mapping exists or lookup fails", async () => {
    const noMappingHarness = createTransport(undefined);
    const noMappingFamily = createFamily(noMappingHarness);
    await noMappingFamily.scan.triggerSource("/unmapped/path");
    expect(noMappingHarness.requests[0]?.path).toBe("/library/sections/all/refresh");

    const lookupFailureHarness = createTransport(librariesResponse, undefined);
    const lookupFailureFamily = createFamily(lookupFailureHarness, {
      mappings: [{ path: "/media", library: "Missing" }],
    });
    await expect(lookupFailureFamily.scan.triggerSource("/media/Album")).resolves.toMatchObject({
      success: true,
      message: "Scan triggered for all libraries",
    });
    expect(lookupFailureHarness.requests.at(-1)?.path).toBe("/library/sections/all/refresh");
  });
});
