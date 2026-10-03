import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaFilter } from "../types/media-filters.js";
import type { MediaAlbum, MediaArtist, MediaPage, MediaTrack } from "../types/media-server.js";
import type {
  PlexAlbumQueryResult,
  PlexArtistQueryResult,
  PlexQueryResult,
} from "../types/plex.js";
import { createPlexQueryAdapterMock } from "./plex-query-adapter.mock.js";
import {
  createMediaAlbumFixture,
  createMediaArtistFixture,
  createMediaTrackFixture,
} from "./test-helpers/media-server-fixtures.js";

const DEFAULT_CONFIG = {
  plex: { url: "http://localhost:32400", token: "test-token" },
};

const mockConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    plex: { url: "http://localhost:32400", token: "test-token" },
  }),
}));
const mockResolveRequiredMediaServerAdapter = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({ logDebug: vi.fn(), logInfo: vi.fn() }));
const mockDb = vi.hoisted(() => ({
  initializeDatabase: vi.fn().mockResolvedValue({}),
  closeDatabase: vi.fn(),
  createPlexQuery: vi.fn().mockReturnValue(41),
  updatePlexQueryStatus: vi.fn(),
  savePlexQueryResults: vi
    .fn()
    .mockImplementation((_db: unknown, _queryId: number, rows: unknown[]) => rows.length),
}));

vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockResolveRequiredMediaServerAdapter,
}));
vi.mock("../lib/loaded-config.js", () => ({ getLoadedConfig: mockConfig.getLoadedConfig }));
vi.mock("../lib/logger.js", () => ({
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
}));
vi.mock("../lib/db.js", () => ({
  initializeDatabase: mockDb.initializeDatabase,
  closeDatabase: mockDb.closeDatabase,
  createPlexQuery: mockDb.createPlexQuery,
  updatePlexQueryStatus: mockDb.updatePlexQueryStatus,
  savePlexQueryResults: mockDb.savePlexQueryResults,
}));
vi.mock("../lib/config.js", () => ({
  resolveUndoDatabasePath: vi.fn().mockReturnValue("/tmp/rfmedia-test.db"),
}));

import { executePlexQuery } from "./plex-query.js";

let adapterMock = createPlexQueryAdapterMock();

function page<T extends MediaTrack | MediaAlbum | MediaArtist>(
  items: readonly T[],
  overrides: Partial<MediaPage<T>> = {},
): MediaPage<T> {
  return {
    items,
    total: items.length,
    offset: 0,
    returned: items.length,
    hasMore: false,
    ...overrides,
  };
}

function resetAdapterMock(): void {
  adapterMock = createPlexQueryAdapterMock();
  mockResolveRequiredMediaServerAdapter.mockReturnValue(adapterMock.adapter);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.getLoadedConfig.mockReturnValue(DEFAULT_CONFIG);
  resetAdapterMock();
});

describe("executePlexQuery generic entity projection", () => {
  it("queries a generic track and preserves public plus SQLite Plex fields", async () => {
    adapterMock.queryTracks.mockResolvedValue(
      page([
        createMediaTrackFixture({
          id: "123",
          title: "Test Track",
          artist: "Test Artist",
          album: "Test Album",
          rating: 0.8,
          playCount: 10,
          durationMs: 180_000,
          year: 2024,
          filePath: "/path/to/track.flac",
          moods: ["Focused"],
        }),
      ]),
    );

    const result = (await executePlexQuery({ library: "Music" })) as PlexQueryResult & {
      queryId: number;
    };

    expect(result).toEqual({
      tracks: [
        {
          ratingKey: "123",
          title: "Test Track",
          artist: "Test Artist",
          album: "Test Album",
          userRating: 8,
          viewCount: 10,
          duration: 180_000,
          year: 2024,
          filePath: "/path/to/track.flac",
          moods: ["Focused"],
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
      queryId: 41,
    });
    expect(adapterMock.queryTracks).toHaveBeenCalledWith(
      expect.objectContaining({ library: "Music", kind: "track" }),
    );
    expect(mockDb.savePlexQueryResults).toHaveBeenCalledWith({}, 41, [
      {
        ratingKey: "123",
        mediaType: "track",
        title: "Test Track",
        userRating: 8,
        year: 2024,
        artist: "Test Artist",
        album: "Test Album",
        viewCount: 10,
        filePath: "/path/to/track.flac",
      },
    ]);
  });

  it("projects generic album fields and an unrated value", async () => {
    adapterMock.queryAlbums.mockResolvedValue(
      page([
        createMediaAlbumFixture({
          id: "456",
          title: "Test Album",
          artist: "Test Artist",
          rating: null,
          year: 2024,
          trackCount: 10,
          artworkPath: "/thumb/456",
          styles: ["Jazz"],
          moods: ["Relaxing"],
        }),
      ]),
    );

    const result = (await executePlexQuery({
      library: "Music",
      type: "album",
    })) as PlexAlbumQueryResult;

    expect(result.albums).toEqual([
      {
        ratingKey: "456",
        title: "Test Album",
        artist: "Test Artist",
        userRating: 0,
        year: 2024,
        trackCount: 10,
        thumb: "/thumb/456",
        styles: ["Jazz"],
        moods: ["Relaxing"],
      },
    ]);
    expect(adapterMock.queryAlbums).toHaveBeenCalledWith(
      expect.objectContaining({ library: "Music", kind: "album" }),
    );
    expect(adapterMock.queryTracks).not.toHaveBeenCalled();
    expect(mockDb.savePlexQueryResults).toHaveBeenCalledWith({}, 41, [
      expect.objectContaining({
        ratingKey: "456",
        mediaType: "album",
        userRating: 0,
        artist: "Test Artist",
        trackCount: 10,
      }),
    ]);
  });

  it("projects generic artist fields and normalized ratings", async () => {
    adapterMock.queryArtists.mockResolvedValue(
      page([
        createMediaArtistFixture({
          id: "789",
          title: "Test Artist",
          rating: 0.65,
          albumCount: 5,
          artworkPath: "/thumb/789",
        }),
      ]),
    );

    const result = (await executePlexQuery({
      library: "Music",
      type: "artist",
    })) as PlexArtistQueryResult;

    expect(result.artists[0]).toEqual({
      ratingKey: "789",
      title: "Test Artist",
      userRating: 7,
      albumCount: 5,
      thumb: "/thumb/789",
      styles: [],
      moods: [],
    });
    expect(adapterMock.queryArtists).toHaveBeenCalledWith(
      expect.objectContaining({ library: "Music", kind: "artist" }),
    );
    expect(mockDb.savePlexQueryResults).toHaveBeenCalledWith({}, 41, [
      expect.objectContaining({ ratingKey: "789", mediaType: "artist", albumCount: 5 }),
    ]);
  });
});

describe("executePlexQuery filter planning", () => {
  it("maps flat CLI filters to the generic filter AST", async () => {
    await executePlexQuery({
      library: "Music",
      minArtistRating: 3,
      maxArtistRating: 5,
      minAlbumRating: 4,
      maxAlbumRating: 5,
      minTrackRating: 3.5,
      maxTrackRating: 4.5,
      genre: "Electronic",
      style: "Dance",
      mood: "Energetic",
      year: 2023,
      minYear: 2020,
      maxYear: 2024,
      minPlays: 5,
      artist: "Artist",
      title: "Title",
      album: "Album",
      limit: 200,
    });

    const query = adapterMock.queryTracks.mock.calls[0]?.[0];
    expect(query).toMatchObject({ library: "Music", kind: "track", limit: 200 });
    expect(query?.filter?.rules).toEqual(
      expect.arrayContaining([
        { type: "rule", field: "artistRating", operator: ">=", value: 3 },
        { type: "rule", field: "artistRating", operator: "<=", value: 5 },
        { type: "rule", field: "albumRating", operator: ">=", value: 4 },
        { type: "rule", field: "trackRating", operator: ">=", value: 3.5 },
        { type: "rule", field: "genre", operator: "contains", value: "Electronic" },
        { type: "rule", field: "minPlays", operator: ">=", value: 5 },
        { type: "rule", field: "album", operator: "contains", value: "Album" },
      ]),
    );
  });

  it("does not reinterpret a server-applied parent rating as the item rating", async () => {
    adapterMock.queryTracks.mockResolvedValue(
      page([createMediaTrackFixture({ id: "low-track", rating: 0.2 })]),
    );

    const result = (await executePlexQuery({
      library: "Music",
      minArtistRating: 4,
      noSave: true,
    })) as PlexQueryResult;

    expect(result.tracks.map(({ ratingKey }) => ratingKey)).toEqual(["low-track"]);
  });

  it("applies config defaults only when no named filter is active", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plex: {
        ...DEFAULT_CONFIG.plex,
        defaultFilters: { minRating: 4, minPlays: 3, genre: "Jazz" },
      },
    });

    await executePlexQuery({ library: "Music" });

    expect(adapterMock.queryTracks.mock.calls[0]?.[0].filter?.rules).toEqual(
      expect.arrayContaining([
        { type: "rule", field: "trackRating", operator: ">=", value: 4 },
        { type: "rule", field: "minPlays", operator: ">=", value: 3 },
        { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
      ]),
    );
  });

  it("uses named library/type/limit defaults and excludes config default rules", async () => {
    const favorites: MediaFilter = {
      library: "Named Music",
      type: "album",
      limit: 12,
      match: "all",
      rules: [{ type: "rule", field: "genre", operator: "contains", value: "Rock" }],
    };
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plex: { ...DEFAULT_CONFIG.plex, defaultFilters: { genre: "Jazz", minRating: 5 } },
      plexFilters: { favorites },
    });

    await executePlexQuery({ filter: "favorites" });

    expect(adapterMock.queryAlbums).toHaveBeenCalledWith(
      expect.objectContaining({
        library: "Named Music",
        kind: "album",
        limit: 12,
        filter: favorites,
      }),
    );
  });

  it("lets explicit library/type/limit values override named defaults", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        favorites: {
          library: "Named Music",
          type: "album",
          limit: 12,
          match: "all",
          rules: [],
        },
      },
    });

    await executePlexQuery({
      filter: "favorites",
      library: "CLI Music",
      type: "artist",
      limit: 4,
    });

    expect(adapterMock.queryArtists).toHaveBeenCalledWith(
      expect.objectContaining({ library: "CLI Music", kind: "artist", limit: 4 }),
    );
  });

  it("replaces same-role named rules with CLI rules, including nested OR branches", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        favorites: {
          library: "Music",
          match: "all",
          rules: [
            {
              type: "group",
              match: "any",
              rules: [
                { type: "rule", field: "trackRating", operator: ">=", value: 4 },
                { type: "rule", field: "trackRating", operator: ">=", value: 5 },
              ],
            },
            { type: "rule", field: "minPlays", operator: ">=", value: 7 },
          ],
        },
      },
    });

    await executePlexQuery({ filter: "favorites", minTrackRating: 2 });

    expect(adapterMock.queryTracks.mock.calls[0]?.[0].filter).toEqual({
      match: "all",
      rules: [
        { type: "rule", field: "minPlays", operator: ">=", value: 7 },
        { type: "rule", field: "trackRating", operator: ">=", value: 2 },
      ],
    });
  });

  it("subsumes a mixed-role OR when one branch is explicitly overridden", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        favorites: {
          library: "Music",
          match: "all",
          rules: [
            {
              type: "group",
              match: "any",
              rules: [
                { type: "rule", field: "artist", operator: "contains", value: "Foo" },
                { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
              ],
            },
          ],
        },
      },
    });

    await executePlexQuery({ filter: "favorites", artist: "Baz" });

    expect(adapterMock.queryTracks.mock.calls[0]?.[0].filter).toEqual({
      match: "all",
      rules: [{ type: "rule", field: "artist", operator: "contains", value: "Baz" }],
    });
    expect(adapterMock.queryTracks).toHaveBeenCalledTimes(1);
  });

  it("expands generic OR variants, deduplicates IDs, and applies residual rules", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        favorites: {
          library: "Music",
          match: "all",
          rules: [
            { type: "rule", field: "trackRating", operator: ">=", value: 3 },
            {
              type: "group",
              match: "any",
              rules: [
                { type: "rule", field: "genre", operator: "contains", value: "Rock" },
                { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
              ],
            },
          ],
        },
      },
    });
    const rock = createMediaTrackFixture({ id: "rock", genres: ["Rock"], rating: 0.8 });
    const jazz = createMediaTrackFixture({ id: "jazz", genres: ["Jazz"], rating: 0.8 });
    adapterMock.queryTracks
      .mockResolvedValueOnce(page([rock, jazz], { total: 9 }))
      .mockResolvedValueOnce(page([jazz], { total: 9 }));

    const result = (await executePlexQuery({
      filter: "favorites",
      noSave: true,
    })) as PlexQueryResult;

    expect(adapterMock.queryTracks).toHaveBeenCalledTimes(2);
    expect(adapterMock.queryTracks.mock.calls[0]?.[0].filter?.rules).toEqual(
      expect.arrayContaining([
        { type: "rule", field: "trackRating", operator: ">=", value: 3 },
        { type: "rule", field: "genre", operator: "contains", value: "Rock" },
      ]),
    );
    expect(result.tracks.map(({ ratingKey }) => ratingKey)).toEqual(["rock", "jazz"]);
    expect(result.totalSize).toBe(9);
  });

  it("evaluates a top-level any filter as residual logic without variant expansion", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        choices: {
          library: "Music",
          match: "any",
          rules: [
            { type: "rule", field: "genre", operator: "contains", value: "Rock" },
            { type: "rule", field: "title", operator: "contains", value: "Keep" },
          ],
        },
      },
    });
    adapterMock.queryTracks.mockResolvedValue(
      page([
        createMediaTrackFixture({ id: "keep", title: "Keep Me", genres: ["Pop"] }),
        createMediaTrackFixture({ id: "drop", title: "Drop Me", genres: ["Pop"] }),
      ]),
    );

    const result = (await executePlexQuery({ filter: "choices", noSave: true })) as PlexQueryResult;

    expect(adapterMock.queryTracks).toHaveBeenCalledTimes(1);
    expect(result.tracks.map(({ ratingKey }) => ratingKey)).toEqual(["keep"]);
  });

  it("applies default genre exclusion case-insensitively", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plex: { ...DEFAULT_CONFIG.plex, defaultFilters: { excludeGenres: ["rock"] } },
    });
    adapterMock.queryTracks.mockResolvedValue(
      page([
        createMediaTrackFixture({ id: "rock", genres: ["ROCK"] }),
        createMediaTrackFixture({ id: "pop", genres: ["Pop"] }),
      ]),
    );

    const result = (await executePlexQuery({ library: "Music" })) as PlexQueryResult;

    expect(result.tracks.map(({ ratingKey }) => ratingKey)).toEqual(["pop"]);
    expect(mockDb.updatePlexQueryStatus).toHaveBeenCalledWith({}, 41, "completed", 1, 2);
  });
});

describe("executePlexQuery pagination and persistence", () => {
  it("preserves the reported total and completed outward pagination shape", async () => {
    adapterMock.queryTracks.mockResolvedValue(
      page([createMediaTrackFixture()], { total: 100, returned: 1, hasMore: true }),
    );

    const result = (await executePlexQuery({ library: "Music", limit: 1 })) as PlexQueryResult;

    expect(result).toMatchObject({ totalSize: 100, offset: 0, hasMore: false });
  });

  it("advances by the server-returned count until residual filtering satisfies the limit", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        keep: {
          library: "Music",
          match: "any",
          rules: [{ type: "rule", field: "title", operator: "contains", value: "Keep" }],
        },
      },
    });
    adapterMock.queryTracks
      .mockResolvedValueOnce(
        page(
          [
            createMediaTrackFixture({ id: "drop-1", title: "Drop One" }),
            createMediaTrackFixture({ id: "drop-2", title: "Drop Two" }),
          ],
          { total: 3, returned: 2, hasMore: true },
        ),
      )
      .mockResolvedValueOnce(
        page([createMediaTrackFixture({ id: "keep", title: "Keep Me" })], {
          total: 3,
          offset: 2,
          returned: 1,
          hasMore: false,
        }),
      );

    const result = (await executePlexQuery({
      filter: "keep",
      limit: 1,
      noSave: true,
    })) as PlexQueryResult;

    expect(adapterMock.queryTracks).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 2 }),
    );
    expect(result.tracks.map(({ ratingKey }) => ratingKey)).toEqual(["keep"]);
    expect(result).toMatchObject({ totalSize: 3, offset: 0, hasMore: false });
  });

  it("preserves the last variant server total for compatibility", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: {
        choices: {
          library: "Music",
          match: "all",
          rules: [
            {
              type: "group",
              match: "any",
              rules: [
                { type: "rule", field: "genre", operator: "contains", value: "Rock" },
                { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
              ],
            },
          ],
        },
      },
    });
    adapterMock.queryTracks
      .mockResolvedValueOnce(
        page([createMediaTrackFixture({ id: "rock", genres: ["Rock"] })], { total: 10 }),
      )
      .mockResolvedValueOnce(
        page([createMediaTrackFixture({ id: "jazz", genres: ["Jazz"] })], { total: 3 }),
      );

    const result = (await executePlexQuery({
      filter: "choices",
      noSave: true,
    })) as PlexQueryResult;

    expect(result.totalSize).toBe(3);
    expect(result.hasMore).toBe(false);
  });

  it("uses generic returned-count pagination to reject a stalled page", async () => {
    adapterMock.queryTracks.mockResolvedValue(page([], { total: 100, returned: 0, hasMore: true }));

    await expect(executePlexQuery({ library: "Music" })).rejects.toThrow(
      "Pagination stalled while querying tracks",
    );
    expect(mockDb.updatePlexQueryStatus).toHaveBeenCalledWith({}, 41, "failed", 0, 0);
    expect(mockDb.closeDatabase).toHaveBeenCalledWith({});
  });

  it("does not initialize or write the database with --no-save", async () => {
    const result = await executePlexQuery({ library: "Music", noSave: true });

    expect(mockDb.initializeDatabase).not.toHaveBeenCalled();
    expect(mockDb.createPlexQuery).not.toHaveBeenCalled();
    expect(mockDb.savePlexQueryResults).not.toHaveBeenCalled();
    expect("queryId" in result).toBe(false);
  });

  it("persists the unchanged query definition fields", async () => {
    await executePlexQuery({
      library: "Music",
      type: "track",
      name: "Favorites",
      filter: undefined,
      minTrackRating: 4,
      genre: "Rock",
    });

    expect(mockDb.createPlexQuery).toHaveBeenCalledWith(
      {},
      {
        libraryName: "Music",
        mediaType: "track",
        filters: { minTrackRating: 4, genre: "Rock" },
        name: "Favorites",
      },
    );
    expect(mockDb.updatePlexQueryStatus).toHaveBeenCalledWith({}, 41, "completed", 0, 0);
    expect(mockDb.closeDatabase).toHaveBeenCalledWith({});
  });
});

describe("executePlexQuery overrides and errors", () => {
  it("forwards same-origin, token-only, and paired connection override inputs unchanged", async () => {
    await executePlexQuery({
      library: "Music",
      plexUrl: "http://custom-server:32400",
      plexToken: "custom-token",
      noSave: true,
    });

    expect(mockResolveRequiredMediaServerAdapter).toHaveBeenCalledWith({
      plexUrl: "http://custom-server:32400",
      plexToken: "custom-token",
    });
  });

  it("propagates required adapter resolution errors", async () => {
    mockResolveRequiredMediaServerAdapter.mockImplementation(() => {
      throw new Error("Plex URL and token are required");
    });

    await expect(executePlexQuery({ library: "Music" })).rejects.toThrow(
      "Plex URL and token are required",
    );
  });

  it("reports missing named filters and available names", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      plexFilters: { favorites: { match: "all", rules: [], library: "Music" } },
    });

    await expect(executePlexQuery({ filter: "missing" })).rejects.toThrow(
      'Filter "missing" not found in plexFilters config. Available: favorites',
    );
  });

  it("requires a library after named/default resolution", async () => {
    await expect(executePlexQuery({ noSave: true })).rejects.toThrow(
      "Library is required. Set via --library option or filter defaults",
    );
  });

  it("marks a saved query failed and rethrows adapter query errors", async () => {
    adapterMock.queryTracks.mockRejectedValue(new Error("query failed"));

    await expect(executePlexQuery({ library: "Music" })).rejects.toThrow("query failed");
    expect(mockDb.updatePlexQueryStatus).toHaveBeenCalledWith({}, 41, "failed", 0, 0);
    expect(mockDb.closeDatabase).toHaveBeenCalledWith({});
  });
});
