import { inspect } from "node:util";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PLEX_METADATA_TYPE_CODES,
  createPlexConnectionSettings,
  getPlexConnectionToken,
  isPlexMetadataTypeCode,
  isPlexWireAlbum,
  isPlexWireArtist,
  isPlexWireArtistIdentity,
  isPlexWireArtistIdentityResponse,
  isPlexWireCollection,
  isPlexWireCollectionItem,
  isPlexWireLibraryResponse,
  isPlexWireMetadataResponse,
  isPlexWirePlaylist,
  isPlexWireServerResponse,
  isPlexWireTrack,
  toPlexConnectionLogContext,
  type PlexConnectionSettings,
  type PlexCacheCategory,
  type PlexMetadataTypeCode,
  type PlexRequestOptions,
} from "./types.js";

describe("private Plex connection types", () => {
  it("captures immutable defaults and keeps the opaque token out of serializable shapes", () => {
    const token = "opaque.jwt-looking.value";
    const connection = createPlexConnectionSettings({
      origin: "http://localhost:32400",
      token,
      clientIdentifier: "rfmedia-test-client",
    });

    expect(connection).toMatchObject({
      origin: "http://localhost:32400",
      clientIdentifier: "rfmedia-test-client",
      cache: { enabled: false, ttlSeconds: 300 },
      request: { timeoutMs: 30_000, delayMs: 100 },
    });
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(connection.cache)).toBe(true);
    expect(Object.keys(connection)).not.toContain("token");
    expect(Reflect.ownKeys(connection)).toEqual(["origin", "clientIdentifier", "cache", "request"]);
    expect(Reflect.ownKeys(connection).some((key) => typeof key === "symbol")).toBe(false);
    expect(JSON.stringify({ ...connection })).not.toContain(token);
    expect(JSON.stringify(connection)).not.toContain(token);
    expect(inspect(connection)).not.toContain(token);
    expect(JSON.stringify(toPlexConnectionLogContext(connection))).not.toContain(token);
    expect(getPlexConnectionToken(connection, connection.origin)).toBe(token);
    expectTypeOf(connection).toEqualTypeOf<PlexConnectionSettings>();
  });

  it("binds credentials to the normalized origin", () => {
    const connection = createPlexConnectionSettings({
      origin: "https://plex.example.com",
      token: "secret-token",
      clientIdentifier: "rfmedia-test-client",
      cache: { enabled: true, ttlSeconds: 42 },
      request: { timeoutMs: 5_000, delayMs: 0 },
    });

    expect(() => getPlexConnectionToken(connection, "https://other.example.com")).toThrow(
      "different origin",
    );
    expect(connection.cache).toEqual({ enabled: true, ttlSeconds: 42 });
    expect(connection.request).toEqual({ timeoutMs: 5_000, delayMs: 0 });
  });

  it.each([
    "ftp://plex.example.com",
    "https://plex.example.com/",
    "https://plex.example.com/library",
    "https://user:password@plex.example.com",
    "https://plex.example.com?token=value",
    "not a URL",
  ])("rejects a non-canonical connection origin: %s", (origin) => {
    expect(() =>
      createPlexConnectionSettings({
        origin,
        token: "secret-token",
        clientIdentifier: "rfmedia-test-client",
      }),
    ).toThrow("normalized HTTP(S) origin");
  });

  it("defines structured requests without credential/header fields", () => {
    const options = {
      method: "GET",
      query: { type: 10, smart: false, optional: undefined },
      signal: AbortSignal.abort(),
    } as const satisfies PlexRequestOptions;

    expect(options.query).toEqual({ type: 10, smart: false, optional: undefined });
    expect(options).not.toHaveProperty("headers");
    expectTypeOf<PlexCacheCategory>().toEqualTypeOf<
      "identity" | "libraries" | "queries" | "playlists" | "collections"
    >();
  });
});

describe("private Plex metadata codes", () => {
  it("owns the exact artist, album, and track codes", () => {
    expect(PLEX_METADATA_TYPE_CODES).toEqual({ artist: 8, album: 9, track: 10 });
    expectTypeOf(PLEX_METADATA_TYPE_CODES.track).toEqualTypeOf<10>();
  });

  it.each([
    [8, true],
    [9, true],
    [10, true],
    [7, false],
    ["10", false],
    [Number.NaN, false],
  ])("validates metadata code %j", (value, expected) => {
    expect(isPlexMetadataTypeCode(value)).toBe(expected);
  });

  it("narrows metadata codes", () => {
    const value: unknown = 10;
    if (!isPlexMetadataTypeCode(value)) {
      throw new Error("expected metadata code");
    }
    expectTypeOf(value).toEqualTypeOf<PlexMetadataTypeCode>();
  });
});

const wireTrack = {
  ratingKey: "track-1",
  title: "Track",
  grandparentTitle: "Artist",
  parentTitle: "Album",
  userRating: 8,
  viewCount: 2,
  duration: 180_000,
  year: 2024,
  Mood: [{ tag: "Energetic" }],
  Media: [{ Part: [{ file: "/music/track.flac" }] }],
};
const MAX_ISO_EPOCH_SECONDS = 8_640_000_000_000;

describe("private Plex wire guards", () => {
  it("accepts the consumed track, album, artist, playlist, and collection fields", () => {
    expect(isPlexWireTrack(wireTrack)).toBe(true);
    expect(
      isPlexWireAlbum({
        ratingKey: "album-1",
        title: "Album",
        parentTitle: "Artist",
        userRating: 7,
        leafCount: 10,
        Style: [{ tag: "Jazz" }],
      }),
    ).toBe(true);
    expect(isPlexWireArtist({ ratingKey: "artist-1", title: "Artist", childCount: 5 })).toBe(true);
    expect(
      isPlexWirePlaylist({
        ratingKey: "playlist-1",
        title: "Playlist",
        smart: false,
        leafCount: 3,
        playlistType: "audio",
      }),
    ).toBe(true);
    expect(
      isPlexWireCollection({
        ratingKey: "collection-1",
        title: "Collection",
        metadataType: 10,
        subtype: "track",
      }),
    ).toBe(true);
    expect(isPlexWireCollectionItem({ ...wireTrack, type: "track", leafCount: 1 })).toBe(true);
  });

  it("accepts an ISO-renderable last-viewed timestamp or its omission", () => {
    expect(isPlexWireTrack(wireTrack)).toBe(true);
    expect(isPlexWireTrack({ ...wireTrack, lastViewedAt: MAX_ISO_EPOCH_SECONDS })).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
  ])("rejects last-viewed timestamps with a %s view count", (_case, viewCount) => {
    const { viewCount: _existingViewCount, ...trackWithoutViewCount } = wireTrack;
    expect(
      isPlexWireTrack({
        ...trackWithoutViewCount,
        ...(viewCount === undefined ? {} : { viewCount }),
        lastViewedAt: 1_725_004_800,
      }),
    ).toBe(false);
  });

  it.each([
    ["nonnumeric", "1725004800"],
    ["nonfinite", Number.POSITIVE_INFINITY],
    ["fractional", 1_725_004_800.5],
    ["zero", 0],
    ["negative", -1],
    ["beyond ISO range", MAX_ISO_EPOCH_SECONDS + 1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s last-viewed timestamp", (_case, lastViewedAt) => {
    expect(isPlexWireTrack({ ...wireTrack, lastViewedAt })).toBe(false);
  });

  it.each([
    [{ title: "Missing ID" }, isPlexWireTrack],
    [{ ratingKey: "", title: "Empty ID" }, isPlexWireTrack],
    [{ ratingKey: "track-1", title: "Track", userRating: "8" }, isPlexWireTrack],
    [{ ratingKey: "track-1", title: "Track", Media: [{ Part: [{ file: 42 }] }] }, isPlexWireTrack],
    [{ ratingKey: "album-1", title: "Album", Style: [{ tag: 42 }] }, isPlexWireAlbum],
    [{ ratingKey: "artist-1", title: "Artist", childCount: Number.NaN }, isPlexWireArtist],
    [{ ratingKey: "playlist-1", title: "Playlist", smart: 1 }, isPlexWirePlaylist],
    [{ ratingKey: "collection-1", title: "Collection", metadataType: "10" }, isPlexWireCollection],
    [{ ratingKey: "collection-1", title: "Collection", key: "" }, isPlexWireCollection],
  ])("rejects malformed consumed fields", (value, guard) => {
    expect(guard(value)).toBe(false);
  });

  it("validates metadata containers with an endpoint-specific guard", () => {
    expect(
      isPlexWireMetadataResponse(
        { MediaContainer: { size: 1, totalSize: 1, offset: 0, Metadata: [wireTrack] } },
        isPlexWireTrack,
      ),
    ).toBe(true);
    expect(
      isPlexWireMetadataResponse(
        { MediaContainer: { size: -1, Metadata: [wireTrack] } },
        isPlexWireTrack,
      ),
    ).toBe(false);
    expect(
      isPlexWireMetadataResponse(
        { MediaContainer: { Metadata: [{ ...wireTrack, duration: "180000" }] } },
        isPlexWireTrack,
      ),
    ).toBe(false);
  });

  it("validates server identity and library containers", () => {
    expect(
      isPlexWireServerResponse({
        MediaContainer: { machineIdentifier: "machine-1", version: "1.0" },
      }),
    ).toBe(true);
    expect(isPlexWireServerResponse({ MediaContainer: { machineIdentifier: 123 } })).toBe(false);
    expect(isPlexWireServerResponse({ MediaContainer: { machineIdentifier: "" } })).toBe(false);

    expect(
      isPlexWireLibraryResponse({
        MediaContainer: {
          Directory: [
            {
              key: "1",
              title: "Music",
              type: "artist",
              uuid: "library-uuid",
              contentChangedAt: 42,
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isPlexWireLibraryResponse({
        MediaContainer: { Directory: [{ key: "1", title: "Music", type: 8 }] },
      }),
    ).toBe(false);
    expect(
      isPlexWireLibraryResponse({
        MediaContainer: { Directory: [{ key: "", title: "Music", type: "artist" }] },
      }),
    ).toBe(false);
    expect(
      isPlexWireLibraryResponse({
        MediaContainer: {
          Directory: [
            { key: "1", title: "Music", type: "artist", contentChangedAt: Number.MAX_VALUE },
          ],
        },
      }),
    ).toBe(false);
  });

  it("bounds private artist identity GUIDs without widening ordinary artists", () => {
    const identity = {
      ratingKey: "artist-1",
      title: "Artist",
      Guid: [{ id: "mbid://12345678-1234-1234-1234-123456789abc" }],
    };

    expect(isPlexWireArtistIdentity(identity)).toBe(true);
    expect(isPlexWireArtist(identity)).toBe(true);
    expect(
      isPlexWireArtistIdentity({
        ...identity,
        Guid: Array.from({ length: 33 }, (_, index) => ({ id: `other://${index}` })),
      }),
    ).toBe(false);
    expect(
      isPlexWireArtistIdentity({
        ...identity,
        Guid: [{ id: `mbid://${"x".repeat(1_025)}` }],
      }),
    ).toBe(false);
    expect(isPlexWireArtistIdentity({ ...identity, title: "unsafe\u202etitle" })).toBe(false);
  });

  it("bounds private identity response arrays and safe page arithmetic", () => {
    const artist = { ratingKey: "artist-1", title: "Artist" };

    expect(
      isPlexWireArtistIdentityResponse({
        MediaContainer: { size: 1, offset: 10, totalSize: 11, Metadata: [artist] },
      }),
    ).toBe(true);
    expect(
      isPlexWireArtistIdentityResponse({
        MediaContainer: { size: 2, offset: 10, totalSize: 11, Metadata: [artist] },
      }),
    ).toBe(false);
    expect(
      isPlexWireArtistIdentityResponse({
        MediaContainer: {
          offset: Number.MAX_SAFE_INTEGER,
          totalSize: Number.MAX_SAFE_INTEGER,
          Metadata: [artist],
        },
      }),
    ).toBe(false);
  });
});
