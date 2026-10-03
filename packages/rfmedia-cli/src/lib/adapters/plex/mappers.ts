/**
 * Pure mappings between private Plex wire shapes, the generic media-server
 * domain, and the established Plex compatibility/persistence shapes.
 *
 * Wire DTOs must not escape this private directory. Callers receive generic
 * entities with opaque IDs or deliberate legacy projections.
 */

import type {
  MediaAlbum,
  MediaArtist,
  MediaCollection,
  MediaItem,
  MediaKind,
  MediaPlaylist,
  MediaServerLibrary,
  MediaTrack,
  NormalizedMediaRating,
} from "../../../types/media-server.js";
import {
  PLEX_METADATA_TYPE_CODES,
  isPlexMetadataTypeCode,
  type PlexMetadataTypeCode,
  type PlexWireAlbum,
  type PlexWireArtist,
  type PlexWireCollection,
  type PlexWireCollectionItem,
  type PlexWireLibrary,
  type PlexWirePlaylist,
  type PlexWireTag,
  type PlexWireTrack,
} from "./types.js";

const PLEX_NATIVE_RATING_MAX = 10;
const STAR_RATING_MAX = 5;

const MEDIA_KIND_BY_PLEX_METADATA_TYPE = Object.freeze({
  8: "artist",
  9: "album",
  10: "track",
} as const satisfies Readonly<Record<PlexMetadataTypeCode, MediaKind>>);

function assertFiniteRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
}

function mapTags(tags: readonly PlexWireTag[] | undefined): readonly string[] {
  return tags?.map(({ tag }) => tag) ?? [];
}

function mapTrackFilePath(track: PlexWireTrack): string {
  return track.Media?.[0]?.Part?.[0]?.file ?? "";
}

/**
 * Validates a normalized generic rating before it reaches a provider request.
 *
 * @param rating - Candidate rating on the closed `0..1` interval.
 * @returns The same value, narrowed to the generic rating type.
 * @throws RangeError for non-finite or out-of-range values.
 */
export function validateNormalizedMediaRating(rating: number): NormalizedMediaRating {
  assertFiniteRange(rating, 0, 1, "Normalized media rating");
  return rating;
}

/**
 * Converts a Plex-native `0..10` rating to the generic scale.
 *
 * Plex uses native zero for an unrated item, so missing and zero values both
 * map to `null`. Positive values preserve their fractional precision.
 */
export function plexNativeRatingToNormalized(
  rating: number | null | undefined,
): NormalizedMediaRating | null {
  if (rating === undefined || rating === null) {
    return null;
  }
  assertFiniteRange(rating, 0, PLEX_NATIVE_RATING_MAX, "Plex native rating");
  return rating === 0 ? null : rating / PLEX_NATIVE_RATING_MAX;
}

/**
 * Converts a generic rating to the integer Plex-native `0..10` scale.
 *
 * `null` and normalized zero both become Plex's unrated value (`0`). Values
 * are rounded exactly as the legacy rating helper did.
 */
export function normalizedRatingToPlexNative(rating: NormalizedMediaRating | null): number {
  if (rating === null) {
    return 0;
  }
  validateNormalizedMediaRating(rating);
  return rating === 0 ? 0 : Math.round(rating * PLEX_NATIVE_RATING_MAX);
}

/** Converts a generic rating to the user-facing `0..5` star scale. */
export function normalizedRatingToStars(rating: NormalizedMediaRating | null): number {
  if (rating === null) {
    return 0;
  }
  validateNormalizedMediaRating(rating);
  return rating * STAR_RATING_MAX;
}

/** Converts a validated `0..5` star rating to the generic scale. */
export function starRatingToNormalized(stars: number): NormalizedMediaRating {
  assertFiniteRange(stars, 0, STAR_RATING_MAX, "Star rating");
  return stars / STAR_RATING_MAX;
}

/** Converts a Plex-native rating directly to user-facing stars. */
export function plexNativeRatingToStars(rating: number | null | undefined): number {
  return normalizedRatingToStars(plexNativeRatingToNormalized(rating));
}

/** Returns the private Plex metadata code for a generic media kind. */
export function mediaKindToPlexMetadataType(kind: MediaKind): PlexMetadataTypeCode {
  return PLEX_METADATA_TYPE_CODES[kind];
}

/**
 * Resolves a Plex metadata code without accepting unknown numeric values.
 *
 * Unknown codes return `undefined` so endpoint code can apply an explicit
 * operation-specific fallback instead of misclassifying the wire value.
 */
export function plexMetadataTypeToMediaKind(value: unknown): MediaKind | undefined {
  return isPlexMetadataTypeCode(value) ? MEDIA_KIND_BY_PLEX_METADATA_TYPE[value] : undefined;
}

/** Maps a consumed Plex track DTO to the provider-neutral domain. */
export function mapPlexTrack(track: PlexWireTrack): MediaTrack {
  return {
    id: track.ratingKey,
    kind: "track",
    title: track.title,
    rating: plexNativeRatingToNormalized(track.userRating),
    artist: track.grandparentTitle ?? "Unknown Artist",
    album: track.parentTitle ?? "Unknown Album",
    playCount: track.viewCount ?? 0,
    lastViewedAt: track.lastViewedAt,
    durationMs: track.duration ?? 0,
    year: track.year,
    moods: mapTags(track.Mood),
    filePath: mapTrackFilePath(track),
  };
}

/** Maps a consumed Plex album DTO to the provider-neutral domain. */
export function mapPlexAlbum(album: PlexWireAlbum): MediaAlbum {
  return {
    id: album.ratingKey,
    kind: "album",
    title: album.title,
    rating: plexNativeRatingToNormalized(album.userRating),
    artist: album.parentTitle ?? "Unknown Artist",
    trackCount: album.leafCount ?? 0,
    year: album.year,
    artworkPath: album.thumb,
    styles: mapTags(album.Style),
    moods: mapTags(album.Mood),
  };
}

/** Maps a consumed Plex artist DTO to the provider-neutral domain. */
export function mapPlexArtist(artist: PlexWireArtist): MediaArtist {
  return {
    id: artist.ratingKey,
    kind: "artist",
    title: artist.title,
    rating: plexNativeRatingToNormalized(artist.userRating),
    albumCount: artist.childCount ?? 0,
    artworkPath: artist.thumb,
    styles: mapTags(artist.Style),
    moods: mapTags(artist.Mood),
  };
}

/**
 * Maps a Plex library section when it represents a supported music kind.
 * Non-music library types are intentionally ignored.
 */
export function mapPlexLibrary(library: PlexWireLibrary): MediaServerLibrary | undefined {
  const kind =
    library.type === "artist" || library.type === "album" || library.type === "track"
      ? library.type
      : undefined;
  return kind === undefined
    ? undefined
    : {
        id: library.key,
        title: library.title,
        kind,
      };
}

/** Maps a consumed Plex playlist DTO to the provider-neutral domain. */
export function mapPlexPlaylist(playlist: PlexWirePlaylist): MediaPlaylist {
  return {
    id: playlist.ratingKey,
    title: playlist.title,
    smart: playlist.smart ?? false,
    itemCount: playlist.leafCount ?? 0,
    durationMs: playlist.duration ?? 0,
    createdAt: playlist.addedAt,
    updatedAt: playlist.updatedAt,
  };
}

/**
 * Resolves a collection's accepted generic item kind.
 *
 * A recognized subtype takes precedence, followed by a recognized numeric
 * code and finally the caller's explicit fallback. The track fallback matches
 * the established collection-creation default.
 */
export function resolvePlexCollectionKind(
  collection: Pick<PlexWireCollection, "subtype" | "metadataType">,
  fallbackKind: MediaKind = "track",
): MediaKind {
  const subtype = collection.subtype;
  if (subtype === "track" || subtype === "album" || subtype === "artist") {
    return subtype;
  }
  return plexMetadataTypeToMediaKind(collection.metadataType) ?? fallbackKind;
}

/** Maps a consumed Plex collection DTO to the provider-neutral domain. */
export function mapPlexCollection(
  collection: PlexWireCollection,
  fallbackKind: MediaKind = "track",
): MediaCollection {
  return {
    id: collection.ratingKey,
    title: collection.title,
    kind: resolvePlexCollectionKind(collection, fallbackKind),
    itemCount: collection.childCount ?? 0,
    smart: collection.smart ?? false,
  };
}

/** Maps a collection child using its Plex discriminator and an explicit fallback. */
export function mapPlexCollectionItem(
  item: PlexWireCollectionItem,
  fallbackKind: MediaKind = "track",
): MediaItem {
  const kind =
    item.type === "artist" || item.type === "album" || item.type === "track"
      ? item.type
      : fallbackKind;
  switch (kind) {
    case "artist":
      return mapPlexArtist({
        ...item,
        childCount: item.leafCount,
      });
    case "album":
      return mapPlexAlbum(item);
    case "track":
      return mapPlexTrack(item);
  }
}
