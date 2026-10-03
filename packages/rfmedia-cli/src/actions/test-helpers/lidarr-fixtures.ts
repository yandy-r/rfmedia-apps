/**
 * Test fixtures for the Lidarr baseline actions.
 *
 * Provides ready-made wire shapes (`HEALTHY_STATUS`, `EMPTY_WANTED_PAGE`) plus
 * `create*Fixture(overrides)` factories that build valid artists, profiles,
 * tags, wanted records, and health checks with sensible defaults. Factories
 * return fresh frozen values so tests do not share mutable nested state.
 */

import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrArtistStatistics,
  LidarrHealthCheck,
  LidarrProfile,
  LidarrSystemStatus,
  LidarrTag,
  LidarrWantedPage,
  LidarrWantedRecord,
} from "../../types/lidarr.js";

/** A healthy Lidarr system-status response used as the default fixture. */
export const HEALTHY_STATUS: LidarrSystemStatus = Object.freeze({
  version: "2.1.7.4030",
  appName: "Lidarr",
  instanceName: "Lidarr",
  isProduction: true,
  runtimeVersion: "6.0.0",
});

/** An empty wanted/missing page (page 1, no records). */
export const EMPTY_WANTED_PAGE: LidarrWantedPage = Object.freeze({
  page: 1,
  pageSize: 50,
  totalRecords: 0,
  records: Object.freeze([]),
});

function normalizeFixtureTagIds(tagIds: readonly number[]): readonly number[] {
  return Object.freeze([...new Set(tagIds)].sort((left, right) => left - right));
}

function freezeArtistStatistics(
  statistics: LidarrArtistStatistics | undefined,
): LidarrArtistStatistics | undefined {
  return statistics === undefined ? undefined : Object.freeze({ ...statistics });
}

/**
 * Builds a valid per-artist statistics block.
 *
 * @param overrides - Fields to override on the default statistics block.
 * @returns A {@link LidarrArtistStatistics} value.
 */
export function createLidarrArtistStatisticsFixture(
  overrides: Partial<LidarrArtistStatistics> = {},
): LidarrArtistStatistics {
  return Object.freeze({
    albumCount: 3,
    trackFileCount: 30,
    trackCount: 30,
    sizeOnDisk: 1_000_000,
    ...overrides,
  });
}

/**
 * Builds a valid Lidarr artist record.
 *
 * @param overrides - Fields to override on the default artist.
 * @returns A {@link LidarrArtist} value with a populated statistics block.
 */
export function createLidarrArtistFixture(overrides: Partial<LidarrArtist> = {}): LidarrArtist {
  const statistics = Object.hasOwn(overrides, "statistics")
    ? freezeArtistStatistics(overrides.statistics)
    : createLidarrArtistStatisticsFixture();

  return Object.freeze({
    id: 1,
    artistName: "Artist 1",
    foreignArtistId: "mbid-artist-1",
    monitored: true,
    qualityProfileId: 1,
    metadataProfileId: 1,
    ...overrides,
    tags: normalizeFixtureTagIds(overrides.tags ?? []),
    statistics,
  });
}

/**
 * Builds a valid Lidarr profile resource.
 *
 * @param overrides - Fields to override on the default profile.
 * @returns A fresh immutable {@link LidarrProfile} value.
 */
export function createLidarrProfileFixture(overrides: Partial<LidarrProfile> = {}): LidarrProfile {
  return Object.freeze({
    id: 5,
    name: "Lossless",
    ...overrides,
  });
}

/**
 * Builds a valid Lidarr tag resource.
 *
 * @param overrides - Fields to override on the default tag.
 * @returns A fresh immutable {@link LidarrTag} value.
 */
export function createLidarrTagFixture(overrides: Partial<LidarrTag> = {}): LidarrTag {
  return Object.freeze({
    id: 4,
    label: "Favorite",
    ...overrides,
  });
}

/**
 * Builds an artist with deterministic quality and metadata profile state.
 *
 * @param overrides - Fields to override on the profiled artist.
 * @returns A fresh immutable {@link LidarrArtist} value.
 */
export function createLidarrProfiledArtistFixture(
  overrides: Partial<LidarrArtist> = {},
): LidarrArtist {
  return createLidarrArtistFixture({
    id: 7,
    artistName: "Profiled Artist",
    foreignArtistId: "mbid-profiled-artist",
    qualityProfileId: 5,
    metadataProfileId: 2,
    tags: [],
    ...overrides,
  });
}

/**
 * Builds an artist with deterministic sorted profile and tag state.
 *
 * @param overrides - Fields to override on the tagged artist.
 * @returns A fresh immutable {@link LidarrArtist} value.
 */
export function createLidarrTaggedArtistFixture(
  overrides: Partial<LidarrArtist> = {},
): LidarrArtist {
  return createLidarrArtistFixture({
    id: 8,
    artistName: "Tagged Artist",
    foreignArtistId: "mbid-tagged-artist",
    qualityProfileId: 5,
    metadataProfileId: 2,
    tags: [4, 8],
    ...overrides,
  });
}

/**
 * Builds a valid, frozen Lidarr album projection.
 *
 * Defaults to a monitored primary "Album" with no secondary types; override
 * `albumType`/`secondaryTypes` to build selector-matching variants (e.g.
 * `{ albumType: "Single" }` or `{ secondaryTypes: ["Live"] }`).
 *
 * @param overrides - Fields to override on the default album.
 * @returns A frozen {@link LidarrAlbum} value.
 */
export function createLidarrAlbumFixture(overrides: Partial<LidarrAlbum> = {}): LidarrAlbum {
  return Object.freeze({
    id: 100,
    title: "Album 1",
    artistId: 1,
    monitored: true,
    albumType: "Album",
    secondaryTypes: [],
    ...overrides,
  });
}

/**
 * Builds a valid wanted/missing album record.
 *
 * @param overrides - Fields to override on the default record.
 * @returns A {@link LidarrWantedRecord} value.
 */
export function createLidarrWantedRecordFixture(
  overrides: Partial<LidarrWantedRecord> = {},
): LidarrWantedRecord {
  const artist = Object.freeze({
    id: 1,
    artistName: "Artist 1",
    foreignArtistId: "mbid-artist-1",
    ...overrides.artist,
  });

  return Object.freeze({
    id: 100,
    title: "Album 1",
    releaseDate: "2020-01-01",
    monitored: true,
    ...overrides,
    artist,
  });
}

/**
 * Builds a valid Lidarr health-check record.
 *
 * @param overrides - Fields to override on the default health check.
 * @returns A {@link LidarrHealthCheck} value (a `warning` by default).
 */
export function createLidarrHealthCheckFixture(
  overrides: Partial<LidarrHealthCheck> = {},
): LidarrHealthCheck {
  return Object.freeze({
    source: "IndexerStatusCheck",
    type: "warning",
    message: "One or more indexers are unavailable.",
    ...overrides,
  });
}
