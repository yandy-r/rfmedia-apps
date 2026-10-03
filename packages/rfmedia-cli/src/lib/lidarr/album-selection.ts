/**
 * Pure Lidarr album selection primitives shared by the album read and plan
 * lanes.
 *
 * This module is deliberately free of I/O and client imports: filtering,
 * deterministic ordering, client-side paging, dedupe, and per-selector
 * accounting all operate on already-fetched album projections and return
 * frozen values, so every consumer stays trivially unit-testable.
 */

import { matchesAlbumTypeSelectors, type LidarrAlbumTypeSelector } from "./album-types.js";
import type { LidarrAlbum } from "../../types/lidarr.js";

/**
 * AND-composed album filter dimensions.
 *
 * Every present dimension must match for an album to pass; within `types`
 * the selectors compose with OR semantics via
 * {@link matchesAlbumTypeSelectors}.
 */
export interface LidarrAlbumFilterCriteria {
  /** Album-type selectors; an album matches when ANY selector matches. */
  readonly types?: readonly LidarrAlbumTypeSelector[];
  /** Required monitored state. */
  readonly monitored?: boolean;
  /** Required on-disk file presence (see {@link filterLidarrAlbums}). */
  readonly hasFiles?: boolean;
}

/**
 * An album "has files" when `statistics.trackFileCount` is greater than zero.
 * An absent statistics block — or an absent count within it — counts as zero
 * files, so unscanned albums honestly report as file-less.
 */
function albumHasFiles(album: LidarrAlbum): boolean {
  return (album.statistics?.trackFileCount ?? 0) > 0;
}

/**
 * Filters albums with AND semantics across the criteria dimensions.
 *
 * `types` uses OR semantics within the selector list; `monitored` compares
 * the album's monitored flag; `hasFiles` compares on-disk file presence,
 * where an absent statistics block counts as zero files.
 *
 * @param albums - Albums to filter.
 * @param criteria - Present dimensions must ALL match.
 * @returns A new frozen array of matching albums, in input order.
 */
export function filterLidarrAlbums(
  albums: readonly LidarrAlbum[],
  criteria: LidarrAlbumFilterCriteria,
): readonly LidarrAlbum[] {
  return Object.freeze(
    albums.filter((album) => {
      if (criteria.types !== undefined && !matchesAlbumTypeSelectors(album, criteria.types)) {
        return false;
      }
      if (criteria.monitored !== undefined && album.monitored !== criteria.monitored) {
        return false;
      }
      if (criteria.hasFiles !== undefined && albumHasFiles(album) !== criteria.hasFiles) {
        return false;
      }
      return true;
    }),
  );
}

/**
 * Sorts albums by artistId ascending, then album id ascending.
 *
 * This deterministic order is the stable-pagination contract behind
 * client-side windows: identical inputs always produce identical pages
 * regardless of server response ordering.
 *
 * @param albums - Albums to sort; the input array is not mutated.
 * @returns A new frozen array in (artistId, albumId) order.
 */
export function sortLidarrAlbumsDeterministic(
  albums: readonly LidarrAlbum[],
): readonly LidarrAlbum[] {
  return Object.freeze(
    [...albums].sort((left, right) => left.artistId - right.artistId || left.id - right.id),
  );
}

/** Client-side paging window over an already-sorted album listing. */
export interface LidarrAlbumPageWindow {
  /** Maximum number of albums to return; `undefined` returns all remaining. */
  readonly limit?: number;
  /** Zero-based start index; `undefined` starts at the beginning. */
  readonly offset?: number;
}

function requireNonNegativeInteger(value: number, label: "limit" | "offset"): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Applies a client-side limit/offset window to an album listing.
 *
 * Call AFTER {@link sortLidarrAlbumsDeterministic}: the window is only stable
 * over a deterministic order. An offset at or beyond the input length yields
 * an empty array.
 *
 * @param albums - Deterministically sorted albums to window.
 * @param page - Limit/offset window to apply.
 * @returns A new frozen array holding the requested window.
 * @throws {RangeError} On a negative or non-integer limit or offset.
 */
export function pageLidarrAlbums(
  albums: readonly LidarrAlbum[],
  page: LidarrAlbumPageWindow,
): readonly LidarrAlbum[] {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? albums.length;
  requireNonNegativeInteger(offset, "offset");
  requireNonNegativeInteger(limit, "limit");
  return Object.freeze(albums.slice(offset, offset + limit));
}

/** Drops duplicate album ids, keeping the first occurrence of each. */
export function dedupeAlbums(albums: readonly LidarrAlbum[]): readonly LidarrAlbum[] {
  const seen = new Set<number>();
  return Object.freeze(
    albums.filter((album) => {
      if (seen.has(album.id)) return false;
      seen.add(album.id);
      return true;
    }),
  );
}

/** Per-selector OVERLAPPING match counts (multi-selector albums count in each). */
export function countBySelector(
  matched: readonly LidarrAlbum[],
  selectors: readonly LidarrAlbumTypeSelector[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const selector of selectors) {
    counts[selector] = matched.filter((album) =>
      matchesAlbumTypeSelectors(album, [selector]),
    ).length;
  }
  return Object.freeze(counts);
}
