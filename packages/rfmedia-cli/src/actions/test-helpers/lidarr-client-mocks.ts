/**
 * Typed mock builder for the {@link LidarrClientApi} seam.
 *
 * Mirrors `createMediaServerAdapterMock`: every method is a `vi.fn` whose type
 * is preserved via the `MockedCapability` mapped type, with sensible resolved
 * defaults (healthy status, empty lists, an empty wanted page). Tests override
 * individual methods and assert on call arguments.
 */

import { vi, type Mock } from "vitest";

import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import { EMPTY_WANTED_PAGE, HEALTHY_STATUS, createLidarrArtistFixture } from "./lidarr-fixtures.js";

/** Maps each method of `T` to a `vi.fn` mock preserving its signature. */
type MockedCapability<T> = {
  [K in keyof T]: T[K] extends (...args: infer TArgs) => infer TResult
    ? Mock<(...args: TArgs) => TResult>
    : never;
};

/** A fully-typed mock of the Lidarr client seam. */
export type LidarrClientMock = MockedCapability<LidarrClientApi>;

function getDefaultArtist(artistId: number) {
  return Promise.resolve(
    createLidarrArtistFixture({
      id: artistId,
      artistName: `Artist ${artistId}`,
      foreignArtistId: `mbid-artist-${artistId}`,
    }),
  );
}

const DEFAULT_NAMING_CONFIG = Object.freeze({
  id: 1,
  renameTracks: false,
  replaceIllegalCharacters: false,
  colonReplacementFormat: 0,
  standardTrackFormat: "",
  multiDiscTrackFormat: "",
  artistFolderFormat: "",
});

const DEFAULT_NAMING_EXAMPLES = Object.freeze({
  singleTrackExample: "",
  multiDiscTrackExample: "",
  artistFolderExample: "",
  albumFolderExample: "",
});

function getDefaultCustomFormat(customFormatId: number) {
  return Promise.resolve(
    Object.freeze({
      id: customFormatId,
      name: `Custom Format ${customFormatId}`,
      includeCustomFormatWhenRenaming: false,
      specifications: Object.freeze([]),
    }),
  );
}

function getDefaultQualityProfile(qualityProfileId: number) {
  return Promise.resolve(
    Object.freeze({
      id: qualityProfileId,
      name: `Quality Profile ${qualityProfileId}`,
      upgradeAllowed: false,
      cutoff: 1,
      items: Object.freeze([]),
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: Object.freeze([]),
    }),
  );
}

/**
 * Creates a typed mock of {@link LidarrClientApi}.
 *
 * @param overrides - Per-method implementation overrides; omitted methods use
 *   healthy defaults (`HEALTHY_STATUS`, empty arrays, a deterministic targeted
 *   artist, `EMPTY_WANTED_PAGE`, and successful no-op mutations).
 * @returns A mock whose methods are `vi.fn` instances assignable to
 *   {@link LidarrClientApi}.
 */
export function createLidarrClientMock(overrides: Partial<LidarrClientApi> = {}): LidarrClientMock {
  return {
    getSystemStatus: vi.fn(overrides.getSystemStatus ?? (() => Promise.resolve(HEALTHY_STATUS))),
    getHealth: vi.fn(overrides.getHealth ?? (() => Promise.resolve([]))),
    listArtists: vi.fn(overrides.listArtists ?? (() => Promise.resolve([]))),
    search: vi.fn(overrides.search ?? (() => Promise.resolve(Object.freeze([])))),
    lookupArtists: vi.fn(overrides.lookupArtists ?? (() => Promise.resolve(Object.freeze([])))),
    lookupAlbums: vi.fn(overrides.lookupAlbums ?? (() => Promise.resolve(Object.freeze([])))),
    getArtistByForeignId: vi.fn(
      overrides.getArtistByForeignId ?? (() => Promise.resolve(undefined)),
    ),
    listRootFolders: vi.fn(overrides.listRootFolders ?? (() => Promise.resolve(Object.freeze([])))),
    prepareArtistAdd: vi.fn(
      overrides.prepareArtistAdd ?? ((input) => Promise.resolve(Object.freeze({ ...input }))),
    ),
    addArtist: vi.fn(
      overrides.addArtist ??
        ((input) =>
          Promise.resolve(
            createLidarrArtistFixture({
              id: 1,
              artistName: input.artistName,
              foreignArtistId: input.foreignArtistId,
              monitored: false,
              qualityProfileId: input.qualityProfileId,
              metadataProfileId: input.metadataProfileId,
              path: input.rootFolderPath,
            }),
          )),
    ),
    listAlbums: vi.fn(overrides.listAlbums ?? (() => Promise.resolve(Object.freeze([])))),
    probeManualImport: vi.fn(
      overrides.probeManualImport ?? (() => Promise.resolve(Object.freeze([]))),
    ),
    listTracks: vi.fn(overrides.listTracks ?? (() => Promise.resolve(Object.freeze([])))),
    listTrackFiles: vi.fn(overrides.listTrackFiles ?? (() => Promise.resolve(Object.freeze([])))),
    bulkDeleteTrackFiles: vi.fn(overrides.bulkDeleteTrackFiles ?? (() => Promise.resolve())),
    getArtist: vi.fn(overrides.getArtist ?? getDefaultArtist),
    deleteArtist: vi.fn(overrides.deleteArtist ?? (() => Promise.resolve())),
    listQualityProfiles: vi.fn(overrides.listQualityProfiles ?? (() => Promise.resolve([]))),
    listCustomFormats: vi.fn(overrides.listCustomFormats ?? (() => Promise.resolve([]))),
    getCustomFormat: vi.fn(overrides.getCustomFormat ?? getDefaultCustomFormat),
    getCustomFormatSchema: vi.fn(
      overrides.getCustomFormatSchema ?? (() => Promise.resolve(Object.freeze([]))),
    ),
    createCustomFormat: vi.fn(
      overrides.createCustomFormat ??
        ((input) =>
          Promise.resolve(
            Object.freeze({
              ...input,
              id: 1,
              specifications: Object.freeze(
                input.specifications.map((specification, index) =>
                  Object.freeze({ ...specification, id: index + 1 }),
                ),
              ),
            }),
          )),
    ),
    updateCustomFormat: vi.fn(
      overrides.updateCustomFormat ??
        ((input) =>
          Promise.resolve(
            Object.freeze({
              ...input,
              specifications: Object.freeze(
                input.specifications.map((specification, index) =>
                  Object.freeze({ ...specification, id: index + 1 }),
                ),
              ),
            }),
          )),
    ),
    listQualityProfileDefinitions: vi.fn(
      overrides.listQualityProfileDefinitions ?? (() => Promise.resolve(Object.freeze([]))),
    ),
    getQualityProfileDefinition: vi.fn(
      overrides.getQualityProfileDefinition ?? getDefaultQualityProfile,
    ),
    getQualityProfileSchema: vi.fn(
      overrides.getQualityProfileSchema ??
        (() =>
          Promise.resolve({
            items: Object.freeze([]),
            formatItems: Object.freeze([]),
          })),
    ),
    createQualityProfile: vi.fn(
      overrides.createQualityProfile ??
        ((input) => Promise.resolve(Object.freeze({ ...input, id: 1 }))),
    ),
    updateQualityProfile: vi.fn(
      overrides.updateQualityProfile ?? ((input) => Promise.resolve(Object.freeze({ ...input }))),
    ),
    getNamingConfig: vi.fn(
      overrides.getNamingConfig ?? (() => Promise.resolve(DEFAULT_NAMING_CONFIG)),
    ),
    getNamingExamples: vi.fn(
      overrides.getNamingExamples ?? (() => Promise.resolve(DEFAULT_NAMING_EXAMPLES)),
    ),
    updateNamingConfig: vi.fn(
      overrides.updateNamingConfig ?? ((input) => Promise.resolve(Object.freeze({ ...input }))),
    ),
    listMetadataProfiles: vi.fn(overrides.listMetadataProfiles ?? (() => Promise.resolve([]))),
    listMetadataProfileDetails: vi.fn(
      overrides.listMetadataProfileDetails ?? (() => Promise.resolve(Object.freeze([]))),
    ),
    listTags: vi.fn(overrides.listTags ?? (() => Promise.resolve([]))),
    getWantedMissing: vi.fn(
      overrides.getWantedMissing ?? (() => Promise.resolve(EMPTY_WANTED_PAGE)),
    ),
    setArtistsMonitored: vi.fn(overrides.setArtistsMonitored ?? (() => Promise.resolve())),
    setAlbumsMonitored: vi.fn(overrides.setAlbumsMonitored ?? (() => Promise.resolve())),
    deleteAlbum: vi.fn(overrides.deleteAlbum ?? (() => Promise.resolve())),
    setAlbumAnyReleaseOk: vi.fn(overrides.setAlbumAnyReleaseOk ?? (() => Promise.resolve())),
    setArtistProfiles: vi.fn(overrides.setArtistProfiles ?? (() => Promise.resolve())),
    updateArtistTags: vi.fn(overrides.updateArtistTags ?? (() => Promise.resolve())),
  };
}
