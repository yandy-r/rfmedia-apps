import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  MediaAlbum,
  MediaArtist,
  MediaCollection,
  MediaPlaylist,
  MediaTrack,
} from "../../../types/media-server.js";
import {
  mapPlexAlbum,
  mapPlexArtist,
  mapPlexCollection,
  mapPlexCollectionItem,
  mapPlexLibrary,
  mapPlexPlaylist,
  mapPlexTrack,
  mediaKindToPlexMetadataType,
  normalizedRatingToPlexNative,
  normalizedRatingToStars,
  plexMetadataTypeToMediaKind,
  plexNativeRatingToNormalized,
  plexNativeRatingToStars,
  resolvePlexCollectionKind,
  starRatingToNormalized,
  validateNormalizedMediaRating,
} from "./mappers.js";

const wireTrack = {
  ratingKey: "track-1",
  title: "Song",
  grandparentTitle: "Artist",
  parentTitle: "Album",
  userRating: 5,
  viewCount: 7,
  lastViewedAt: 1_725_004_800,
  duration: 180_000,
  year: 2024,
  Mood: [{ tag: "Focused" }],
  Media: [{ Part: [{ file: "/music/Artist/Album/Song.flac" }] }],
} as const;

describe("Plex rating mappers", () => {
  it("preserves null/unrated, zero, half, and full scale semantics", () => {
    expect(plexNativeRatingToNormalized(undefined)).toBeNull();
    expect(plexNativeRatingToNormalized(null)).toBeNull();
    expect(plexNativeRatingToNormalized(0)).toBeNull();
    expect(normalizedRatingToPlexNative(null)).toBe(0);
    expect(normalizedRatingToPlexNative(0)).toBe(0);

    expect(plexNativeRatingToNormalized(5)).toBe(0.5);
    expect(normalizedRatingToPlexNative(0.5)).toBe(5);
    expect(normalizedRatingToStars(0.5)).toBe(2.5);
    expect(starRatingToNormalized(2.5)).toBe(0.5);
    expect(plexNativeRatingToStars(5)).toBe(2.5);

    expect(plexNativeRatingToNormalized(10)).toBe(1);
    expect(normalizedRatingToPlexNative(1)).toBe(10);
    expect(normalizedRatingToStars(1)).toBe(5);
    expect(starRatingToNormalized(5)).toBe(1);
  });

  it("retains the legacy integer rounding for Plex writes", () => {
    expect(normalizedRatingToPlexNative(0.74)).toBe(7);
    expect(normalizedRatingToPlexNative(0.75)).toBe(8);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01])(
    "rejects invalid normalized request rating %s",
    (value) => {
      expect(() => validateNormalizedMediaRating(value)).toThrow(RangeError);
      expect(() => normalizedRatingToPlexNative(value)).toThrow(
        "Normalized media rating must be a finite number between 0 and 1",
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 10.01])(
    "rejects invalid Plex native rating %s",
    (value) => {
      expect(() => plexNativeRatingToNormalized(value)).toThrow(
        "Plex native rating must be a finite number between 0 and 10",
      );
    },
  );

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -0.01, 5.01])(
    "rejects invalid star rating %s",
    (value) => {
      expect(() => starRatingToNormalized(value)).toThrow(
        "Star rating must be a finite number between 0 and 5",
      );
    },
  );
});

describe("Plex metadata type mappers", () => {
  it("maps all supported generic kinds and numeric Plex codes", () => {
    expect(mediaKindToPlexMetadataType("artist")).toBe(8);
    expect(mediaKindToPlexMetadataType("album")).toBe(9);
    expect(mediaKindToPlexMetadataType("track")).toBe(10);
    expect(plexMetadataTypeToMediaKind(8)).toBe("artist");
    expect(plexMetadataTypeToMediaKind(9)).toBe("album");
    expect(plexMetadataTypeToMediaKind(10)).toBe("track");
  });

  it.each([7, 11, "10", undefined, Number.NaN])("does not classify unknown code %j", (value) => {
    expect(plexMetadataTypeToMediaKind(value)).toBeUndefined();
  });
});

describe("Plex wire to generic entity mappers", () => {
  it("maps consumed track fields and keeps the ID opaque", () => {
    const track = mapPlexTrack(wireTrack);

    expect(track).toEqual({
      id: "track-1",
      kind: "track",
      title: "Song",
      rating: 0.5,
      artist: "Artist",
      album: "Album",
      playCount: 7,
      lastViewedAt: 1_725_004_800,
      durationMs: 180_000,
      year: 2024,
      moods: ["Focused"],
      filePath: "/music/Artist/Album/Song.flac",
    });
    expect(track).not.toHaveProperty("ratingKey");
    expect(track).not.toHaveProperty("userRating");
    expectTypeOf(track).toEqualTypeOf<MediaTrack>();
  });

  it.each([
    { ratingKey: "track-1", title: "No media" },
    { ratingKey: "track-1", title: "No parts", Media: [{}] },
    { ratingKey: "track-1", title: "Empty parts", Media: [{ Part: [] }] },
    { ratingKey: "track-1", title: "No file", Media: [{ Part: [{}] }] },
  ])("defaults missing media containers and parts without leaking the DTO", (wire) => {
    const track = mapPlexTrack(wire);

    expect(track).toMatchObject({
      id: "track-1",
      artist: "Unknown Artist",
      album: "Unknown Album",
      rating: null,
      playCount: 0,
      durationMs: 0,
      moods: [],
      filePath: "",
    });
    expect(track.lastViewedAt).toBeUndefined();
  });

  it("maps albums and artists with optional tags and artwork", () => {
    const album = mapPlexAlbum({
      ratingKey: "album-1",
      title: "Album",
      parentTitle: "Artist",
      userRating: 10,
      year: 2020,
      leafCount: 12,
      thumb: "/album-thumb",
      Style: [{ tag: "Jazz" }],
      Mood: [{ tag: "Warm" }],
    });
    const artist = mapPlexArtist({
      ratingKey: "artist-1",
      title: "Artist",
      userRating: 0,
      childCount: 4,
      thumb: "/artist-thumb",
      Style: [{ tag: "Fusion" }],
    });

    expect(album).toEqual({
      id: "album-1",
      kind: "album",
      title: "Album",
      rating: 1,
      artist: "Artist",
      trackCount: 12,
      year: 2020,
      artworkPath: "/album-thumb",
      styles: ["Jazz"],
      moods: ["Warm"],
    });
    expect(artist).toEqual({
      id: "artist-1",
      kind: "artist",
      title: "Artist",
      rating: null,
      albumCount: 4,
      artworkPath: "/artist-thumb",
      styles: ["Fusion"],
      moods: [],
    });
    expectTypeOf(album).toEqualTypeOf<MediaAlbum>();
    expectTypeOf(artist).toEqualTypeOf<MediaArtist>();
  });

  it("maps only supported music libraries and preserves playlist defaults", () => {
    expect(mapPlexLibrary({ key: "1", title: "Music", type: "artist" })).toEqual({
      id: "1",
      title: "Music",
      kind: "artist",
    });
    expect(mapPlexLibrary({ key: "2", title: "Movies", type: "movie" })).toBeUndefined();

    const playlist = mapPlexPlaylist({ ratingKey: "playlist-1", title: "Mix" });
    expect(playlist).toEqual({
      id: "playlist-1",
      title: "Mix",
      smart: false,
      itemCount: 0,
      durationMs: 0,
      createdAt: undefined,
      updatedAt: undefined,
    });
    expectTypeOf(playlist).toEqualTypeOf<MediaPlaylist>();
  });

  it("resolves collection subtype, numeric code, fallback, and unknown code deterministically", () => {
    expect(resolvePlexCollectionKind({ subtype: "album", metadataType: 10 })).toBe("album");
    expect(resolvePlexCollectionKind({ subtype: "unknown", metadataType: 8 })).toBe("artist");
    expect(resolvePlexCollectionKind({ metadataType: 99 }, "album")).toBe("album");
    expect(resolvePlexCollectionKind({ metadataType: 99 })).toBe("track");

    const collection = mapPlexCollection({
      ratingKey: "collection-1",
      title: "Favorites",
      childCount: 3,
      smart: true,
      metadataType: 9,
    });
    expect(collection).toEqual({
      id: "collection-1",
      title: "Favorites",
      kind: "album",
      itemCount: 3,
      smart: true,
    });
    expectTypeOf(collection).toEqualTypeOf<MediaCollection>();
  });

  it("maps collection children by discriminator with a track fallback", () => {
    expect(mapPlexCollectionItem({ ...wireTrack, type: "track" })).toMatchObject({
      kind: "track",
      id: "track-1",
    });
    expect(
      mapPlexCollectionItem({ ...wireTrack, type: "album", leafCount: 12, thumb: "/thumb" }),
    ).toMatchObject({ kind: "album", id: "track-1", trackCount: 12, artworkPath: "/thumb" });
    expect(
      mapPlexCollectionItem({ ...wireTrack, type: "artist", leafCount: 4, thumb: "/thumb" }),
    ).toMatchObject({ kind: "artist", id: "track-1", albumCount: 4, artworkPath: "/thumb" });
    expect(mapPlexCollectionItem({ ...wireTrack, type: "unknown" })).toMatchObject({
      kind: "track",
    });
  });

  it("rejects out-of-range ratings in otherwise valid wire entities", () => {
    expect(() => mapPlexTrack({ ...wireTrack, userRating: 11 })).toThrow(RangeError);
    expect(() => mapPlexAlbum({ ratingKey: "album-1", title: "Album", userRating: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      mapPlexArtist({ ratingKey: "artist-1", title: "Artist", userRating: Number.NaN }),
    ).toThrow(RangeError);
  });
});
