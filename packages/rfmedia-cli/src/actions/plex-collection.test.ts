/**
 * Tests for plex-collection.ts - Plex collection action handlers.
 *
 * Tests collection CRUD operations including create, add, list, show, and delete
 * with various filter options, folder-based matching, and error handling.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  MediaAlbum,
  MediaArtist,
  MediaCollection,
  MediaKind,
  MediaPage,
  MediaTrack,
} from "../types/media-server.js";
import type { MediaFilterRule } from "../types/media-filters.js";
import { createPlexCollectionAdapterMock } from "./plex-collection-adapter.mock.js";

// Mock definitions with vi.hoisted() - must be defined before vi.mock() calls
const mockAdapterFunctions = vi.hoisted(() => ({
  listCollections: vi.fn().mockResolvedValue([]),
  getCollection: vi.fn().mockResolvedValue({
    id: "100",
    title: "Test Collection",
    kind: "track" as const,
    itemCount: 0,
    smart: false,
  }),
  createCollection: vi.fn().mockResolvedValue({
    id: "100",
    title: "Test Collection",
    kind: "track" as const,
    itemCount: 0,
    smart: false,
  }),
  addCollectionItems: vi.fn().mockResolvedValue(undefined),
  deleteCollection: vi.fn().mockResolvedValue(undefined),
  queryTracks: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  }),
  queryAlbums: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  }),
  queryArtists: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  }),
  getAlbumTracks: vi.fn().mockResolvedValue([]),
  findLibraryByName: vi.fn().mockResolvedValue({
    id: "1",
    title: "Music",
    kind: "artist" as const,
  }),
  findCollectionByName: vi.fn().mockResolvedValue({
    id: "100",
    title: "Test Collection",
    kind: "track" as const,
    itemCount: 5,
    smart: false,
  }),
  isValidPlexUrl: vi.fn().mockReturnValue(true),
}));

const mockResolveRequiredMediaServerAdapter = vi.hoisted(() => vi.fn());

const mockConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    plex: { url: "http://localhost:32400", token: "test-token" },
  }),
}));

const mockAudioFunctions = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
}));

const mockFilesystemFunctions = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(true),
}));

const mockPromptFunctions = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logSuccess: vi.fn(),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockResolveRequiredMediaServerAdapter,
}));

vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: mockConfig.getLoadedConfig,
}));

vi.mock("../lib/audio.js", () => ({
  findAudioFiles: mockAudioFunctions.findAudioFiles,
}));

vi.mock("../lib/filesystem.js", () => ({
  pathExists: mockFilesystemFunctions.pathExists,
}));

vi.mock("../lib/prompt.js", () => ({
  confirm: mockPromptFunctions.confirm,
}));

vi.mock("../lib/logger.js", () => ({
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
  logWarn: mockLogger.logWarn,
  logSuccess: mockLogger.logSuccess,
}));

// Import after mocks
import {
  executeCollectionCreate,
  executeCollectionAdd,
  executeCollectionList,
  executeCollectionShow,
  executeCollectionDelete,
} from "./plex-collection.js";

const collectionAdapterMock = createPlexCollectionAdapterMock();

// =============================================================================
// Test Data
// =============================================================================

const mockTrack = (id: string, title: string, filePath: string): MediaTrack => ({
  id,
  kind: "track",
  title,
  artist: "Test Artist",
  album: "Test Album",
  rating: 0.8,
  playCount: 10,
  durationMs: 180000,
  filePath,
});

const mockCollection = (
  id: string,
  title: string,
  itemCount: number = 0,
  kind: MediaKind = "track",
): MediaCollection => ({ id, title, itemCount, kind, smart: false });

function createPage<T extends MediaTrack | MediaAlbum | MediaArtist>(
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

function queriedRules(
  queryMock: typeof mockAdapterFunctions.queryTracks,
): readonly MediaFilterRule[] {
  const options = queryMock.mock.calls[0]?.[0] as
    | { filter?: { rules?: readonly MediaFilterRule[] } }
    | undefined;
  return options?.filter?.rules ?? [];
}

// =============================================================================
// Helper to reset all mocks to default state
// =============================================================================

function resetMocksToDefaults() {
  vi.clearAllMocks(); // NOT resetAllMocks!

  // Reset config
  mockConfig.getLoadedConfig.mockReturnValue({
    plex: { url: "http://localhost:32400", token: "test-token" },
  });

  // Reset Plex functions to default success responses
  mockAdapterFunctions.isValidPlexUrl.mockReturnValue(true);
  mockAdapterFunctions.findLibraryByName.mockResolvedValue({
    id: "1",
    title: "Music",
    kind: "artist",
  });
  mockAdapterFunctions.listCollections.mockResolvedValue([]);
  mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test Collection", 0));
  mockAdapterFunctions.createCollection.mockResolvedValue(
    mockCollection("100", "Test Collection", 0),
  );
  mockAdapterFunctions.findCollectionByName.mockResolvedValue(
    mockCollection("100", "Test Collection", 5),
  );
  mockAdapterFunctions.queryTracks.mockResolvedValue(createPage([]));
  mockAdapterFunctions.queryAlbums.mockResolvedValue(createPage([]));
  mockAdapterFunctions.queryArtists.mockResolvedValue(createPage([]));
  mockAdapterFunctions.addCollectionItems.mockResolvedValue(undefined);
  mockAdapterFunctions.deleteCollection.mockResolvedValue(undefined);

  collectionAdapterMock.queryTracks.mockImplementation((options) =>
    mockAdapterFunctions.queryTracks(options),
  );
  collectionAdapterMock.queryAlbums.mockImplementation((options) =>
    mockAdapterFunctions.queryAlbums(options),
  );
  collectionAdapterMock.queryArtists.mockImplementation((options) =>
    mockAdapterFunctions.queryArtists(options),
  );
  collectionAdapterMock.queryAlbumTracks.mockImplementation((albumId) =>
    mockAdapterFunctions.getAlbumTracks(albumId),
  );
  collectionAdapterMock.findLibraryByName.mockImplementation((name) =>
    mockAdapterFunctions.findLibraryByName(name),
  );
  collectionAdapterMock.listCollections.mockImplementation((libraryId) =>
    mockAdapterFunctions.listCollections(libraryId),
  );
  collectionAdapterMock.getCollection.mockImplementation((collectionId) =>
    mockAdapterFunctions.getCollection(collectionId),
  );
  collectionAdapterMock.findCollectionByName.mockImplementation((libraryId, name) =>
    mockAdapterFunctions.findCollectionByName(libraryId, name),
  );
  collectionAdapterMock.createCollection.mockImplementation((libraryId, input) =>
    mockAdapterFunctions.createCollection(libraryId, input),
  );
  collectionAdapterMock.addCollectionItems.mockImplementation((collectionId, itemIds) =>
    mockAdapterFunctions.addCollectionItems(collectionId, [...itemIds]),
  );
  collectionAdapterMock.deleteCollection.mockImplementation((collectionId) =>
    mockAdapterFunctions.deleteCollection(collectionId),
  );

  // Reset audio and filesystem functions
  mockAudioFunctions.findAudioFiles.mockResolvedValue([]);
  mockFilesystemFunctions.pathExists.mockResolvedValue(true);

  // Reset prompt functions
  mockPromptFunctions.confirm.mockResolvedValue(true);

  mockResolveRequiredMediaServerAdapter.mockImplementation(
    (overrides?: { plexUrl?: string; plexToken?: string }) => {
      const loadedConfig = mockConfig.getLoadedConfig();
      const url = overrides?.plexUrl ?? loadedConfig.plex?.url;
      const token = overrides?.plexToken ?? loadedConfig.plex?.token;

      if (!url || !token) {
        throw new Error(
          "Plex URL and token are required. Set in config or use --plex-url and --plex-token",
        );
      }

      if (!mockAdapterFunctions.isValidPlexUrl(url)) {
        throw new Error(`Invalid Plex URL format: ${url}`);
      }

      return collectionAdapterMock.adapter;
    },
  );
}

// =============================================================================
// executeCollectionCreate Tests
// =============================================================================

describe("executeCollectionCreate", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should create collection with title and library", async () => {
    const createdCollection = mockCollection("100", "New Collection", 0);
    mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);

    const result = await executeCollectionCreate({
      collectionName: "New Collection",
      library: "Music",
    });

    expect(result.collection.title).toBe("New Collection");
    expect(result.itemsAdded).toBe(0);
    expect(result.totalItems).toBe(0);
    expect(mockAdapterFunctions.findLibraryByName).toHaveBeenCalledWith("Music");
    expect(mockAdapterFunctions.createCollection).toHaveBeenCalledWith(
      "1", // libraryKey
      { title: "New Collection", kind: "track" },
    );
  });

  it("should apply filters and add matching items", async () => {
    const tracks = [
      mockTrack("1", "Track 1", "/music/track1.flac"),
      mockTrack("2", "Track 2", "/music/track2.flac"),
      mockTrack("3", "Track 3", "/music/track3.flac"),
    ];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: tracks,
      total: 3,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const createdCollection = mockCollection("100", "Rock Collection", 0);
    mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);

    const updatedCollection = mockCollection("100", "Rock Collection", 3);
    mockAdapterFunctions.getCollection.mockResolvedValue(updatedCollection);

    const result = await executeCollectionCreate({
      collectionName: "Rock Collection",
      library: "Music",
      genre: "Rock",
      year: ">=2020",
    });

    expect(result.collection.title).toBe("Rock Collection");
    expect(result.itemsAdded).toBe(3);
    expect(result.totalItems).toBe(3);
    expect(mockAdapterFunctions.queryTracks).toHaveBeenCalled();
    expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("100", ["1", "2", "3"]);
  });

  it("should create artist collection using artist query mode", async () => {
    mockAdapterFunctions.queryArtists.mockResolvedValue({
      items: [
        { id: "a1", kind: "artist", title: "Artist A", rating: 0.8, albumCount: 5 },
        { id: "a2", kind: "artist", title: "Artist B", rating: 1, albumCount: 3 },
      ],
      total: 2,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    mockAdapterFunctions.createCollection.mockResolvedValue(
      mockCollection("300", "Artist Collection", 0, "artist"),
    );
    mockAdapterFunctions.getCollection.mockResolvedValue(
      mockCollection("300", "Artist Collection", 2, "artist"),
    );

    const result = await executeCollectionCreate({
      collectionName: "Artist Collection",
      library: "Music",
      type: "artist",
      genre: "Jazz",
    });

    expect(result.itemsAdded).toBe(2);
    expect(result.totalItems).toBe(2);
    expect(mockAdapterFunctions.queryArtists).toHaveBeenCalled();
    expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
    expect(mockAdapterFunctions.createCollection).toHaveBeenCalledWith("1", {
      title: "Artist Collection",
      kind: "artist",
    });
    expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("300", ["a1", "a2"]);
  });

  it("should advance artist pagination when a page yields zero filtered artists", async () => {
    mockAdapterFunctions.queryArtists
      .mockResolvedValueOnce({
        items: [],
        total: 900,
        offset: 0,
        returned: 500,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: "a9", kind: "artist", title: "Artist Z", rating: 0.8, albumCount: 4 }],
        total: 900,
        offset: 500,
        returned: 400,
        hasMore: false,
      });

    mockAdapterFunctions.createCollection.mockResolvedValue(
      mockCollection("301", "Artist Pagination", 0, "artist"),
    );
    mockAdapterFunctions.getCollection.mockResolvedValue(
      mockCollection("301", "Artist Pagination", 1, "artist"),
    );

    const result = await executeCollectionCreate({
      collectionName: "Artist Pagination",
      library: "Music",
      type: "artist",
      genre: "R&B",
    });

    expect(result.itemsAdded).toBe(1);
    expect(mockAdapterFunctions.queryArtists).toHaveBeenCalledTimes(2);

    const firstCallOptions = mockAdapterFunctions.queryArtists.mock.calls[0]?.[0];
    const secondCallOptions = mockAdapterFunctions.queryArtists.mock.calls[1]?.[0];

    expect(firstCallOptions).toEqual(expect.objectContaining({ offset: 0 }));
    expect(secondCallOptions).toEqual(expect.objectContaining({ offset: 500 }));
    expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("301", ["a9"]);
  });

  it("should fail fast when artist pagination hasMore=true with zero page item count", async () => {
    mockAdapterFunctions.queryArtists.mockResolvedValue({
      items: [],
      total: 900,
      offset: 0,
      returned: 0,
      hasMore: true,
    });

    await expect(
      executeCollectionCreate({
        collectionName: "Artist Pagination Guard",
        library: "Music",
        type: "artist",
        genre: "R&B",
      }),
    ).rejects.toThrow(
      "Pagination stalled while querying artists: server reported more results but returned an empty page",
    );

    expect(mockAdapterFunctions.createCollection).not.toHaveBeenCalled();
  });

  it("should stop paginating once the global limit is satisfied", async () => {
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: [
        mockTrack("1", "Track 1", "/music/track1.flac"),
        mockTrack("2", "Track 2", "/music/track2.flac"),
        mockTrack("3", "Track 3", "/music/track3.flac"),
      ],
      total: 900,
      offset: 0,
      returned: 3,
      hasMore: true,
    });
    mockAdapterFunctions.createCollection.mockResolvedValue(
      mockCollection("302", "Limited Pagination", 0),
    );
    mockAdapterFunctions.getCollection.mockResolvedValue(
      mockCollection("302", "Limited Pagination", 2),
    );

    const result = await executeCollectionCreate({
      collectionName: "Limited Pagination",
      library: "Music",
      genre: "Rock",
      limit: 2,
    });

    expect(result.itemsAdded).toBe(2);
    expect(mockAdapterFunctions.queryTracks).toHaveBeenCalledTimes(1);
    expect(mockAdapterFunctions.queryTracks).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 500 }),
    );
    expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("302", ["1", "2"]);
  });

  it("should create album collection using album query mode", async () => {
    mockAdapterFunctions.queryAlbums.mockResolvedValue({
      items: [
        {
          id: "al1",
          kind: "album",
          title: "Album 1",
          artist: "Artist A",
          rating: 0.8,
          trackCount: 10,
        },
        {
          id: "al2",
          kind: "album",
          title: "Album 2",
          artist: "Artist B",
          rating: 1,
          trackCount: 8,
        },
      ],
      total: 2,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    mockAdapterFunctions.createCollection.mockResolvedValue(
      mockCollection("400", "Album Collection", 0, "album"),
    );
    mockAdapterFunctions.getCollection.mockResolvedValue(
      mockCollection("400", "Album Collection", 2, "album"),
    );

    const result = await executeCollectionCreate({
      collectionName: "Album Collection",
      library: "Music",
      type: "album",
      minYear: 2000,
    });

    expect(result.itemsAdded).toBe(2);
    expect(result.totalItems).toBe(2);
    expect(mockAdapterFunctions.queryAlbums).toHaveBeenCalled();
    expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
    expect(mockAdapterFunctions.createCollection).toHaveBeenCalledWith("1", {
      title: "Album Collection",
      kind: "album",
    });
    expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("400", ["al1", "al2"]);
  });

  it("should reject smart create for non-track type before mutation", async () => {
    await expect(
      executeCollectionCreate({
        collectionName: "Smart Artists",
        library: "Music",
        type: "artist",
        smart: true,
      }),
    ).rejects.toThrow("Smart collections are only supported for track type");

    expect(mockAdapterFunctions.createCollection).not.toHaveBeenCalled();
    expect(mockAdapterFunctions.addCollectionItems).not.toHaveBeenCalled();
  });

  it("should throw error when filter returns no matches", async () => {
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: [],
      total: 0,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    await expect(
      executeCollectionCreate({
        collectionName: "Empty Collection",
        library: "Music",
        genre: "NonexistentGenre",
      }),
    ).rejects.toThrow("Filter returned no matching tracks");

    // Collection should NOT be created
    expect(mockAdapterFunctions.createCollection).not.toHaveBeenCalled();
  });

  it("should throw error when library not found", async () => {
    mockAdapterFunctions.findLibraryByName.mockRejectedValue(
      new Error('Library "NonexistentLibrary" not found'),
    );

    await expect(
      executeCollectionCreate({
        collectionName: "New Collection",
        library: "NonexistentLibrary",
      }),
    ).rejects.toThrow('Library "NonexistentLibrary" not found');
  });

  it("should throw error when library is not provided", async () => {
    await expect(
      executeCollectionCreate({
        collectionName: "New Collection",
      }),
    ).rejects.toThrow("Library name is required");
  });

  it("should project created collection compatibility defaults", async () => {
    const createdCollection = mockCollection("100", "Test Collection", 0);
    mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);

    const result = await executeCollectionCreate({
      collectionName: "Test Collection",
      library: "Music",
    });

    expect(result.collection).toEqual({
      ratingKey: "100",
      key: "/library/collections/100/children",
      title: "Test Collection",
      childCount: 0,
      smart: false,
      addedAt: 0,
      updatedAt: 0,
      type: "collection",
      metadataType: 10,
      mediaType: "track",
    });
    expect(result).toMatchObject({ itemsAdded: 0, totalItems: 0 });
  });

  it("should use CLI overrides for plexUrl and plexToken", async () => {
    await executeCollectionCreate({
      collectionName: "Test Collection",
      library: "Music",
      plexUrl: "http://custom-server:32400",
      plexToken: "custom-token",
    });

    expect(mockResolveRequiredMediaServerAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        plexUrl: "http://custom-server:32400",
        plexToken: "custom-token",
      }),
    );
  });
});

// =============================================================================
// executeCollectionAdd Tests
// =============================================================================

describe("executeCollectionAdd", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  describe("Filter Mode", () => {
    it("should query and add items with filters", async () => {
      const tracks = [
        mockTrack("1", "Track 1", "/music/track1.flac"),
        mockTrack("2", "Track 2", "/music/track2.flac"),
      ];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "My Collection", 5);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

      const updatedCollection = mockCollection("100", "My Collection", 7);
      mockAdapterFunctions.getCollection.mockResolvedValue(updatedCollection);

      const result = await executeCollectionAdd({
        collectionName: "My Collection",
        library: "Music",
        genre: "Jazz",
        minStars: 4,
      });

      expect(result.itemsAdded).toBe(2);
      expect(result.totalItems).toBe(7);
      expect(mockAdapterFunctions.queryTracks).toHaveBeenCalled();
      expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("100", ["1", "2"]);
    });

    it("should query and add artists when mode is artist", async () => {
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(
        mockCollection("510", "Artist Target", 4, "artist"),
      );
      mockAdapterFunctions.queryArtists.mockResolvedValue({
        items: [
          { id: "a1", kind: "artist", title: "Artist A", rating: 0.8, albumCount: 5 },
          { id: "a2", kind: "artist", title: "Artist B", rating: 0.6, albumCount: 3 },
        ],
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("510", "Artist Target", 6, "artist"),
      );

      const result = await executeCollectionAdd({
        collectionName: "Artist Target",
        library: "Music",
        mode: "artist",
        genre: "Jazz",
      });

      expect(result.itemsAdded).toBe(2);
      expect(mockAdapterFunctions.queryArtists).toHaveBeenCalled();
      expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
      expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("510", ["a1", "a2"]);
    });

    it("should query and add albums when mode is album", async () => {
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(
        mockCollection("520", "Album Target", 2, "album"),
      );
      mockAdapterFunctions.queryAlbums.mockResolvedValue({
        items: [
          {
            id: "al1",
            kind: "album",
            title: "Album A",
            artist: "Artist A",
            rating: 0.8,
            trackCount: 9,
          },
          {
            id: "al2",
            kind: "album",
            title: "Album B",
            artist: "Artist B",
            rating: 1,
            trackCount: 7,
          },
        ],
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("520", "Album Target", 4, "album"),
      );

      const result = await executeCollectionAdd({
        collectionName: "Album Target",
        library: "Music",
        mode: "album",
        minYear: 2000,
      });

      expect(result.itemsAdded).toBe(2);
      expect(mockAdapterFunctions.queryAlbums).toHaveBeenCalled();
      expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
      expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("520", ["al1", "al2"]);
    });

    it("should fail preflight when add mode does not match collection type", async () => {
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(
        mockCollection("530", "Album Target", 2, "album"),
      );

      await expect(
        executeCollectionAdd({
          collectionName: "Album Target",
          library: "Music",
          mode: "track",
          genre: "Rock",
        }),
      ).rejects.toThrow('uses media type "album"');

      expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
      expect(mockAdapterFunctions.addCollectionItems).not.toHaveBeenCalled();
    });

    it("should throw error when filter returns no matches", async () => {
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: [],
        total: 0,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      await expect(
        executeCollectionAdd({
          collectionName: "My Collection",
          library: "Music",
          genre: "NonexistentGenre",
        }),
      ).rejects.toThrow("Filter returned no matching tracks");
    });

    it("should throw error when no filters or folder provided", async () => {
      await expect(
        executeCollectionAdd({
          collectionName: "My Collection",
          library: "Music",
        }),
      ).rejects.toThrow("Either --from-folder or filter options");
    });

    it("should use the generic collection kind for add preflight", async () => {
      const collection = mockCollection("100", "Track Target", 0, "track");
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
      mockAdapterFunctions.getCollection.mockResolvedValue(collection);
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: [mockTrack("1", "Track", "/path/track.flac")],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const result = await executeCollectionAdd({
        collectionName: "Track Target",
        library: "Music",
        genre: "Rock",
      });

      expect(mockAdapterFunctions.findCollectionByName).toHaveBeenCalledWith("1", "Track Target");
      expect(mockAdapterFunctions.getCollection).toHaveBeenCalledWith("100");
      expect(result.itemsAdded).toBe(1);
      expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("100", ["1"]);
    });
  });

  describe("Folder Mode", () => {
    it("should match local files to Plex tracks", async () => {
      // Local files
      mockAudioFunctions.findAudioFiles.mockResolvedValue([
        "/music/track1.flac",
        "/music/track2.flac",
      ]);

      // Plex tracks with matching paths
      const plexTracks = [
        mockTrack("1", "Track 1", "/music/track1.flac"),
        mockTrack("2", "Track 2", "/music/track2.flac"),
        mockTrack("3", "Track 3", "/music/track3.flac"),
      ];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: plexTracks,
        total: 3,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "Imported Collection", 0);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

      const updatedCollection = mockCollection("100", "Imported Collection", 2);
      mockAdapterFunctions.getCollection.mockResolvedValue(updatedCollection);

      const result = await executeCollectionAdd({
        collectionName: "Imported Collection",
        library: "Music",
        fromFolder: "/music",
      });

      expect(result.itemsAdded).toBe(2);
      expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("100", ["1", "2"]);
    });

    it("should handle exact path matching", async () => {
      mockAudioFunctions.findAudioFiles.mockResolvedValue([
        "/mnt/media/music/Artist/Album/track.flac",
      ]);

      const plexTracks = [mockTrack("1", "Track", "/mnt/media/music/Artist/Album/track.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: plexTracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "Test", 0);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

      const result = await executeCollectionAdd({
        collectionName: "Test",
        library: "Music",
        fromFolder: "/mnt/media/music/Artist/Album",
      });

      expect(result.itemsAdded).toBe(1);
    });

    it("should handle basename matching for different mount points", async () => {
      // Local path uses /mnt/media
      mockAudioFunctions.findAudioFiles.mockResolvedValue(["/mnt/media/music/track.flac"]);

      // Plex uses /media
      const plexTracks = [mockTrack("1", "Track", "/media/music/track.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: plexTracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "Test", 0);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

      const result = await executeCollectionAdd({
        collectionName: "Test",
        library: "Music",
        fromFolder: "/mnt/media/music",
      });

      // Should match via basename since exact path fails
      expect(result.itemsAdded).toBe(1);
    });

    it("should handle case-insensitive filename matching", async () => {
      // Local file with uppercase
      mockAudioFunctions.findAudioFiles.mockResolvedValue(["/music/Audio.MP3"]);

      // Plex has lowercase
      const plexTracks = [mockTrack("1", "Audio", "/music/audio.mp3")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: plexTracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "Test", 0);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

      const result = await executeCollectionAdd({
        collectionName: "Test",
        library: "Music",
        fromFolder: "/music",
      });

      // Should match via case-insensitive basename
      expect(result.itemsAdded).toBe(1);
    });

    it("should throw error when folder does not exist", async () => {
      mockFilesystemFunctions.pathExists.mockResolvedValue(false);

      await expect(
        executeCollectionAdd({
          collectionName: "Test",
          library: "Music",
          fromFolder: "/nonexistent/folder",
        }),
      ).rejects.toThrow("Folder not found");
    });

    it("should reject --from-folder when mode is non-track", async () => {
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(
        mockCollection("600", "Artist Folder Target", 0, "artist"),
      );

      await expect(
        executeCollectionAdd({
          collectionName: "Artist Folder Target",
          library: "Music",
          mode: "artist",
          fromFolder: "/music",
        }),
      ).rejects.toThrow("--from-folder is only supported for track mode");

      expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
      expect(mockAdapterFunctions.addCollectionItems).not.toHaveBeenCalled();
    });

    it("should reject --from-folder when the generic collection kind is non-track", async () => {
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(
        mockCollection("100", "Artist Target", 0, "artist"),
      );

      await expect(
        executeCollectionAdd({
          collectionName: "Artist Target",
          library: "Music",
          fromFolder: "/music",
        }),
      ).rejects.toThrow('uses media type "artist"');

      expect(mockAdapterFunctions.queryTracks).not.toHaveBeenCalled();
    });

    it("should throw error when no audio files in folder", async () => {
      mockAudioFunctions.findAudioFiles.mockResolvedValue([]);

      await expect(
        executeCollectionAdd({
          collectionName: "Test",
          library: "Music",
          fromFolder: "/empty/folder",
        }),
      ).rejects.toThrow("No audio files found in folder");
    });

    it("should throw error when no matches found", async () => {
      mockAudioFunctions.findAudioFiles.mockResolvedValue(["/local/unmatched-file.flac"]);

      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: [mockTrack("1", "Different Track", "/plex/different-file.flac")],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "Test", 0);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

      await expect(
        executeCollectionAdd({
          collectionName: "Test",
          library: "Music",
          fromFolder: "/local",
        }),
      ).rejects.toThrow("No matches found");
    });

    it("should warn about ambiguous basename matches", async () => {
      // Single local file
      mockAudioFunctions.findAudioFiles.mockResolvedValue(["/music/track.flac"]);

      // Multiple Plex tracks with same basename
      const plexTracks = [
        mockTrack("1", "Track 1", "/music/artist1/track.flac"),
        mockTrack("2", "Track 2", "/music/artist2/track.flac"),
      ];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: plexTracks,
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const collection = mockCollection("100", "Test", 0);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

      await expect(
        executeCollectionAdd({
          collectionName: "Test",
          library: "Music",
          fromFolder: "/music",
        }),
      ).rejects.toThrow("No matches found");

      // Should have warned about ambiguity (actual format includes count)
      expect(mockLogger.logWarn).toHaveBeenCalledWith(
        expect.stringContaining("Multiple Plex tracks"),
      );
    });
  });

  describe("Updates Existing Collection", () => {
    it("should update existing collection correctly", async () => {
      const tracks = [mockTrack("5", "New Track", "/music/new.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      // Collection already has items
      const existingCollection = mockCollection("100", "Existing Collection", 10);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(existingCollection);

      // After adding
      const updatedCollection = mockCollection("100", "Existing Collection", 11);
      mockAdapterFunctions.getCollection.mockResolvedValue(updatedCollection);

      const result = await executeCollectionAdd({
        collectionName: "Existing Collection",
        library: "Music",
        genre: "Rock",
      });

      expect(result.itemsAdded).toBe(1);
      expect(result.totalItems).toBe(11);
    });
  });
});

// =============================================================================
// executeCollectionList Tests
// =============================================================================

describe("executeCollectionList", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should list collections in library", async () => {
    const collections = [
      mockCollection("1", "Rock Favorites", 50),
      mockCollection("2", "Jazz Collection", 30),
      mockCollection("3", "Workout Mix", 25),
    ];
    mockAdapterFunctions.listCollections.mockResolvedValue(collections);

    const result = await executeCollectionList({
      library: "Music",
    });

    expect(result).toHaveLength(3);
    expect(result[0]?.title).toBe("Rock Favorites");
    expect(result[1]?.title).toBe("Jazz Collection");
    expect(result[2]?.title).toBe("Workout Mix");
    expect(mockAdapterFunctions.listCollections).toHaveBeenCalledWith(
      "1", // libraryKey
    );
  });

  it("should return empty array for library with no collections", async () => {
    mockAdapterFunctions.listCollections.mockResolvedValue([]);

    const result = await executeCollectionList({
      library: "Music",
    });

    expect(result).toHaveLength(0);
  });

  it("should throw error when library is not provided", async () => {
    await expect(executeCollectionList({})).rejects.toThrow("Library name is required");
  });

  it("should project collection compatibility defaults for JSON output", async () => {
    const collections = [mockCollection("1", "Test Collection", 10)];
    mockAdapterFunctions.listCollections.mockResolvedValue(collections);

    const result = await executeCollectionList({
      library: "Music",
    });

    expect(result).toEqual([
      {
        ratingKey: "1",
        key: "/library/collections/1/children",
        title: "Test Collection",
        childCount: 10,
        smart: false,
        addedAt: 0,
        updatedAt: 0,
        type: "collection",
        metadataType: 10,
        mediaType: "track",
      },
    ]);
  });
});

// =============================================================================
// executeCollectionShow Tests
// =============================================================================

describe("executeCollectionShow", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should show collection details", async () => {
    const collection = mockCollection("100", "My Collection", 25);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

    const result = await executeCollectionShow({
      collectionName: "My Collection",
      library: "Music",
    });

    expect(result.title).toBe("My Collection");
    expect(result.childCount).toBe(25);
    expect(result.ratingKey).toBe("100");
  });

  it("should throw error when collection not found", async () => {
    mockAdapterFunctions.findCollectionByName.mockRejectedValue(
      new Error('Collection "Nonexistent" not found'),
    );

    await expect(
      executeCollectionShow({
        collectionName: "Nonexistent",
        library: "Music",
      }),
    ).rejects.toThrow('Collection "Nonexistent" not found');
  });

  it("should throw error when library is not provided", async () => {
    await expect(
      executeCollectionShow({
        collectionName: "My Collection",
      }),
    ).rejects.toThrow("Library name is required");
  });
});

// =============================================================================
// executeCollectionDelete Tests
// =============================================================================

describe("executeCollectionDelete", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should find and delete collection", async () => {
    const collection = mockCollection("100", "To Delete", 10);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

    await executeCollectionDelete({
      collectionName: "To Delete",
      library: "Music",
      yes: true,
    });

    expect(mockAdapterFunctions.findCollectionByName).toHaveBeenCalled();
    expect(mockAdapterFunctions.deleteCollection).toHaveBeenCalledWith("100");
  });

  it("should throw error when collection not found", async () => {
    mockAdapterFunctions.findCollectionByName.mockRejectedValue(
      new Error('Collection "Nonexistent" not found'),
    );

    await expect(
      executeCollectionDelete({
        collectionName: "Nonexistent",
        library: "Music",
        yes: true,
      }),
    ).rejects.toThrow('Collection "Nonexistent" not found');

    expect(mockAdapterFunctions.deleteCollection).not.toHaveBeenCalled();
  });

  it("should respect --yes flag for confirmation", async () => {
    const collection = mockCollection("100", "To Delete", 10);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

    await executeCollectionDelete({
      collectionName: "To Delete",
      library: "Music",
      yes: true,
    });

    // Should NOT prompt for confirmation
    expect(mockPromptFunctions.confirm).not.toHaveBeenCalled();
    expect(mockAdapterFunctions.deleteCollection).toHaveBeenCalled();
  });

  it("should prompt for confirmation without --yes flag", async () => {
    const collection = mockCollection("100", "To Delete", 10);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockPromptFunctions.confirm.mockResolvedValue(true);

    await executeCollectionDelete({
      collectionName: "To Delete",
      library: "Music",
    });

    expect(mockPromptFunctions.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Are you sure you want to delete"),
    );
    expect(mockAdapterFunctions.deleteCollection).toHaveBeenCalled();
  });

  it("should abort deletion when user cancels confirmation", async () => {
    const collection = mockCollection("100", "To Delete", 10);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockPromptFunctions.confirm.mockResolvedValue(false);

    await executeCollectionDelete({
      collectionName: "To Delete",
      library: "Music",
    });

    expect(mockPromptFunctions.confirm).toHaveBeenCalled();
    expect(mockAdapterFunctions.deleteCollection).not.toHaveBeenCalled();
    expect(mockLogger.logInfo).toHaveBeenCalledWith("Delete cancelled");
  });

  it("should throw error when library is not provided", async () => {
    await expect(
      executeCollectionDelete({
        collectionName: "To Delete",
      }),
    ).rejects.toThrow("Library name is required");
  });
});

// =============================================================================
// Path Matching Edge Cases
// =============================================================================

describe("Path Matching Edge Cases", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should handle symlinks (different paths, same file)", async () => {
    // Local path uses symlink
    mockAudioFunctions.findAudioFiles.mockResolvedValue(["/symlink/music/track.flac"]);

    // Plex has resolved symlink path
    const plexTracks = [mockTrack("1", "Track", "/real/path/music/track.flac")];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: plexTracks,
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const collection = mockCollection("100", "Test", 0);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

    const result = await executeCollectionAdd({
      collectionName: "Test",
      library: "Music",
      fromFolder: "/symlink/music",
    });

    // Should match via basename since full paths differ
    expect(result.itemsAdded).toBe(1);
  });

  it("should handle mount point differences (/mnt/media vs /media)", async () => {
    mockAudioFunctions.findAudioFiles.mockResolvedValue(["/mnt/media/Artist/Album/song.flac"]);

    const plexTracks = [mockTrack("1", "Song", "/media/Artist/Album/song.flac")];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: plexTracks,
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const collection = mockCollection("100", "Test", 0);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

    const result = await executeCollectionAdd({
      collectionName: "Test",
      library: "Music",
      fromFolder: "/mnt/media/Artist/Album",
    });

    expect(result.itemsAdded).toBe(1);
  });

  it("should handle case sensitivity (Audio.mp3 vs audio.mp3)", async () => {
    mockAudioFunctions.findAudioFiles.mockResolvedValue(["/music/AUDIO.MP3"]);

    const plexTracks = [mockTrack("1", "Audio", "/music/audio.mp3")];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: plexTracks,
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const collection = mockCollection("100", "Test", 0);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

    const result = await executeCollectionAdd({
      collectionName: "Test",
      library: "Music",
      fromFolder: "/music",
    });

    expect(result.itemsAdded).toBe(1);
  });

  it("should handle multiple files with same name in different folders (warning)", async () => {
    mockAudioFunctions.findAudioFiles.mockResolvedValue([
      "/music/artist1/track.flac",
      "/music/artist2/track.flac",
    ]);

    // Each Plex track is uniquely matched
    const plexTracks = [
      mockTrack("1", "Track 1", "/plex/artist1/track.flac"),
      mockTrack("2", "Track 2", "/plex/artist2/track.flac"),
    ];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: plexTracks,
      total: 2,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const collection = mockCollection("100", "Test", 0);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

    await expect(
      executeCollectionAdd({
        collectionName: "Test",
        library: "Music",
        fromFolder: "/music",
      }),
    ).rejects.toThrow("No matches found");

    // Should warn about ambiguity for both files since basename "track.flac" matches 2 Plex tracks
    expect(mockLogger.logWarn).toHaveBeenCalled();
  });

  it("should correctly match when some files have exact paths and others use basename", async () => {
    mockAudioFunctions.findAudioFiles.mockResolvedValue([
      "/music/exact-match.flac", // Exact path match
      "/local/basename-match.flac", // Different mount, basename match
    ]);

    const plexTracks = [
      mockTrack("1", "Exact Match", "/music/exact-match.flac"),
      mockTrack("2", "Basename Match", "/plex/basename-match.flac"),
    ];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: plexTracks,
      total: 2,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const collection = mockCollection("100", "Test", 0);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 2));

    const result = await executeCollectionAdd({
      collectionName: "Test",
      library: "Music",
      fromFolder: "/music",
    });

    expect(result.itemsAdded).toBe(2);
  });

  it("should report partial matches with warning", async () => {
    mockAudioFunctions.findAudioFiles.mockResolvedValue([
      "/music/found.flac",
      "/music/not-found.flac",
    ]);

    const plexTracks = [mockTrack("1", "Found", "/music/found.flac")];
    mockAdapterFunctions.queryTracks.mockResolvedValue({
      items: plexTracks,
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });

    const collection = mockCollection("100", "Test", 0);
    mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);
    mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Test", 1));

    const result = await executeCollectionAdd({
      collectionName: "Test",
      library: "Music",
      fromFolder: "/music",
    });

    expect(result.itemsAdded).toBe(1);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("could not be matched"),
    );
  });
});

// =============================================================================
// Named Filter Loading Integration Tests (Task 5.2)
// =============================================================================

describe("Named Filter Loading Integration Tests", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  describe("Loading Valid Named Filters", () => {
    it("should successfully load and use a valid named filter from config", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "jazz-high-rated": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [
              { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
              { type: "rule", field: "trackRating", operator: ">=", value: 4 },
            ],
          },
        },
      });

      const tracks = [
        mockTrack("1", "Jazz Favorite 1", "/music/jazz1.flac"),
        mockTrack("2", "Jazz Favorite 2", "/music/jazz2.flac"),
      ];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Jazz Collection", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("100", "Jazz Collection", 2),
      );

      const result = await executeCollectionCreate({
        collectionName: "Jazz Collection",
        library: "Music",
        filter: "jazz-high-rated",
      });

      expect(result.collection.title).toBe("Jazz Collection");
      expect(result.itemsAdded).toBe(2);
      expect(mockAdapterFunctions.queryTracks).toHaveBeenCalled();
    });

    it("should load named filter in executeCollectionAdd", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "energetic-workout": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [
              { type: "rule", field: "mood", operator: "contains", value: "Energetic" },
              { type: "rule", field: "trackRating", operator: ">=", value: 4 },
            ],
          },
        },
      });

      const tracks = [
        mockTrack("10", "Workout Song", "/music/workout.flac"),
        mockTrack("11", "Energy Boost", "/music/energy.flac"),
      ];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const existingCollection = mockCollection("200", "Workout Mix", 5);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(existingCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("200", "Workout Mix", 7));

      const result = await executeCollectionAdd({
        collectionName: "Workout Mix",
        library: "Music",
        filter: "energetic-workout",
      });

      expect(result.itemsAdded).toBe(2);
      expect(result.totalItems).toBe(7);
      expect(mockAdapterFunctions.addCollectionItems).toHaveBeenCalledWith("200", ["10", "11"]);
    });
  });

  describe("Non-Existent Filter Error Handling", () => {
    it("should throw descriptive error when filter not found with available filters list", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "jazz-favorites": { match: "all", rules: [] },
          "rock-classics": { match: "all", rules: [] },
          "pop-divas": { match: "all", rules: [] },
        },
      });

      await expect(
        executeCollectionCreate({
          collectionName: "Test Collection",
          library: "Music",
          filter: "nonexistent-filter",
        }),
      ).rejects.toThrow('Filter "nonexistent-filter" not found in plexFilters config');
    });

    it("should list available filters in error message", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "filter-a": { match: "all", rules: [] },
          "filter-b": { match: "all", rules: [] },
        },
      });

      try {
        await executeCollectionCreate({
          collectionName: "Test Collection",
          library: "Music",
          filter: "unknown-filter",
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain("Available:");
        expect(errorMessage).toContain("filter-a");
        expect(errorMessage).toContain("filter-b");
      }
    });

    it("should show empty available list when plexFilters is empty", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {},
      });

      // When plexFilters is empty object, Object.keys().join() returns empty string
      await expect(
        executeCollectionCreate({
          collectionName: "Test",
          library: "Music",
          filter: "some-filter",
        }),
      ).rejects.toThrow('Filter "some-filter" not found in plexFilters config. Available:');
    });

    it('should show "none" when plexFilters section is undefined', async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        // No plexFilters section at all
      });

      await expect(
        executeCollectionCreate({
          collectionName: "Test",
          library: "Music",
          filter: "any-filter",
        }),
      ).rejects.toThrow("Available: none");
    });

    it("should throw error for non-existent filter in executeCollectionAdd", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "existing-filter": { match: "all", rules: [] },
        },
      });

      const collection = mockCollection("100", "Test Collection", 5);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(collection);

      await expect(
        executeCollectionAdd({
          collectionName: "Test Collection",
          library: "Music",
          filter: "missing-filter",
        }),
      ).rejects.toThrow('Filter "missing-filter" not found in plexFilters config');
    });
  });

  describe("OR Group Expansion with Deduplication", () => {
    it("should expand nested OR group to multiple queries and deduplicate by ratingKey", async () => {
      // Use a filter with nested OR group inside top-level AND (match: all)
      // This pattern allows server-side OR expansion
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "multi-artist-nested": {
            match: "all", // Top-level AND allows nested OR expansion
            library: "Music",
            type: "track",
            rules: [
              {
                type: "group",
                match: "any", // Nested OR group - gets expanded to multiple server queries
                rules: [
                  { type: "rule", field: "artist", operator: "==", value: "Artist A" },
                  { type: "rule", field: "artist", operator: "==", value: "Artist B" },
                ],
              },
            ],
          },
        },
      });

      // First query returns Artist A tracks - with correct artist name for client-side filtering
      const artistATracks = [
        { ...mockTrack("1", "Track from A", "/a/track1.flac"), artist: "Artist A" },
        { ...mockTrack("2", "Another A Track", "/a/track2.flac"), artist: "Artist A" },
      ];
      // Second query returns Artist B tracks, including a duplicate ratingKey
      const artistBTracks = [
        { ...mockTrack("2", "Same Track Different Source", "/b/track2.flac"), artist: "Artist B" }, // Duplicate ratingKey
        { ...mockTrack("3", "Track from B", "/b/track3.flac"), artist: "Artist B" },
      ];

      mockAdapterFunctions.queryTracks
        .mockResolvedValueOnce({
          items: artistATracks,
          total: 2,
          offset: 0,
          returned: 1,
          hasMore: false,
        })
        .mockResolvedValueOnce({
          items: artistBTracks,
          total: 2,
          offset: 0,
          returned: 1,
          hasMore: false,
        });

      const createdCollection = mockCollection("100", "Multi Artist", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("100", "Multi Artist", 3),
      );

      const result = await executeCollectionCreate({
        collectionName: "Multi Artist Collection",
        library: "Music",
        filter: "multi-artist-nested",
      });

      // Should have 3 unique tracks (1, 2, 3) after deduplication
      expect(result.itemsAdded).toBe(3);

      // Verify multiple queries were made (one per OR branch)
      expect(mockAdapterFunctions.queryTracks).toHaveBeenCalledTimes(2);

      // Verify addCollectionItems received exactly 3 unique rating keys
      const addedItems = mockAdapterFunctions.addCollectionItems.mock.calls[0]?.[1] as string[];
      expect(addedItems).toHaveLength(3);
      expect(new Set(addedItems).size).toBe(3); // Confirms no duplicates
      expect(addedItems).toContain("1");
      expect(addedItems).toContain("2");
      expect(addedItems).toContain("3");
    });
  });

  describe("Complex Conditions Trigger Client-Side Filtering", () => {
    it("should use client-side filtering for complex nested boolean logic", async () => {
      // Complex nested filter with deeply nested OR groups using artist field
      // This requires client-side filtering to evaluate
      // Note: genre field returns undefined for tracks in filter evaluator,
      // so we use artist field which works for client-side filtering
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "complex-nested": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [
              { type: "rule", field: "artistRating", operator: ">=", value: 3 }, // userRating >= 6
              {
                type: "group",
                match: "any",
                rules: [
                  {
                    type: "group",
                    match: "all",
                    rules: [
                      { type: "rule", field: "artist", operator: "contains", value: "Jazz" },
                      { type: "rule", field: "minYear", operator: ">=", value: 2010 },
                    ],
                  },
                  {
                    type: "group",
                    match: "all",
                    rules: [
                      { type: "rule", field: "artist", operator: "contains", value: "Rock" },
                      { type: "rule", field: "trackRating", operator: ">=", value: 4 }, // userRating >= 8
                    ],
                  },
                ],
              },
            ],
          },
        },
      });

      // Provide tracks that will pass client-side filtering:
      // Track 1: userRating=8 (passes artistRating >= 3) + artist='Jazz Artist', year=2015 (passes first nested group)
      // Track 2: userRating=9 (passes artistRating >= 3 AND trackRating >= 4) + artist='Rock Band' (passes second nested group)
      const tracks = [
        {
          ...mockTrack("1", "Modern Jazz", "/jazz.flac"),
          artist: "Jazz Artist",
          rating: 0.8,
          year: 2015,
        },
        { ...mockTrack("2", "Classic Rock", "/rock.flac"), artist: "Rock Band", rating: 0.9 },
      ];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 2,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Complex Filter", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("100", "Complex Filter", 2),
      );

      const result = await executeCollectionCreate({
        collectionName: "Complex Filter Collection",
        library: "Music",
        filter: "complex-nested",
      });

      // The function should execute - complex nested groups use client-side filtering
      expect(mockAdapterFunctions.queryTracks).toHaveBeenCalled();
      expect(result.collection.title).toBe("Complex Filter");
    });

    it("should handle filter with year range conditions via server query", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "year-range": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [
              { type: "rule", field: "minYear", operator: ">=", value: 2015 },
              { type: "rule", field: "maxYear", operator: "<=", value: 2020 },
              { type: "rule", field: "trackRating", operator: ">=", value: 3 },
            ],
          },
        },
      });

      const tracks = [mockTrack("1", "Mid-2010s Track", "/track.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Year Range", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Year Range", 1));

      await executeCollectionCreate({
        collectionName: "Year Range Collection",
        library: "Music",
        filter: "year-range",
      });

      expect(queriedRules(mockAdapterFunctions.queryTracks)).toEqual(
        expect.arrayContaining([
          { type: "rule", field: "minYear", operator: ">=", value: 2015 },
          { type: "rule", field: "maxYear", operator: "<=", value: 2020 },
          { type: "rule", field: "trackRating", operator: ">=", value: 3 },
        ]),
      );
    });
  });

  describe("CLI Options Augment Filter Conditions", () => {
    it("should use filter genre when both CLI and filter specify genre (filter takes precedence)", async () => {
      // Named filter conditions from YAML take precedence over CLI options for same fields
      // This is because in queryTracksWithFilters: queryOptions = { ...filters, ...variant }
      // where filters are CLI options and variant comes from the named filter
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "default-jazz": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [{ type: "rule", field: "genre", operator: "contains", value: "Jazz" }],
          },
        },
      });

      const tracks = [mockTrack("1", "Jazz Track", "/jazz.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Genre Test", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Genre Test", 1));

      await executeCollectionCreate({
        collectionName: "Genre Test Collection",
        library: "Music",
        filter: "default-jazz",
        genre: "Rock", // CLI provides Rock, but filter's Jazz takes precedence
      });

      // Filter genre (Jazz) takes precedence over CLI genre (Rock)
      expect(queriedRules(mockAdapterFunctions.queryTracks)).toEqual(
        expect.arrayContaining([
          { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
        ]),
      );
      expect(queriedRules(mockAdapterFunctions.queryTracks)).not.toEqual(
        expect.arrayContaining([
          { type: "rule", field: "genre", operator: "contains", value: "Rock" },
        ]),
      );
    });

    it("should allow CLI rating options to augment filter when filter has no rating rules", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "genre-only-filter": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [{ type: "rule", field: "genre", operator: "contains", value: "Pop" }],
          },
        },
      });

      const tracks = [mockTrack("1", "Pop Track", "/pop.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Augmented", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Augmented", 1));

      await executeCollectionCreate({
        collectionName: "Augmented Collection",
        library: "Music",
        filter: "genre-only-filter",
        minTrackRating: 4.5,
        minArtistRating: 3,
      });

      // CLI rating filters should be added since filter doesn't have them
      expect(queriedRules(mockAdapterFunctions.queryTracks)).toEqual(
        expect.arrayContaining([
          { type: "rule", field: "trackRating", operator: ">=", value: 4.5 },
          { type: "rule", field: "artistRating", operator: ">=", value: 3 },
        ]),
      );
    });

    it("should allow CLI limit to override filter limit", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "limited-filter": {
            match: "all",
            library: "Music",
            type: "track",
            limit: 100, // Filter default limit
            rules: [{ type: "rule", field: "trackRating", operator: ">=", value: 4 }],
          },
        },
      });

      // Return many tracks
      const tracks = Array.from({ length: 25 }, (_, i) =>
        mockTrack(`${i + 1}`, `Track ${i + 1}`, `/music/track${i + 1}.flac`),
      );
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 25,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Limited", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(mockCollection("100", "Limited", 5));

      const result = await executeCollectionCreate({
        collectionName: "Limited Collection",
        library: "Music",
        filter: "limited-filter",
        limit: 5, // CLI override to limit to 5
      });

      // Should be limited to 5 items
      expect(result.itemsAdded).toBe(5);
    });

    it("should allow CLI year filters to augment named filter without year rules", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "rated-only": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [{ type: "rule", field: "trackRating", operator: ">=", value: 4 }],
          },
        },
      });

      const tracks = [mockTrack("1", "Recent Track", "/recent.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const createdCollection = mockCollection("100", "Year Augmented", 0);
      mockAdapterFunctions.createCollection.mockResolvedValue(createdCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("100", "Year Augmented", 1),
      );

      await executeCollectionCreate({
        collectionName: "Year Augmented Collection",
        library: "Music",
        filter: "rated-only",
        minYear: 2020,
        maxYear: 2024,
      });

      // CLI year filters should be added since filter doesn't have them
      expect(queriedRules(mockAdapterFunctions.queryTracks)).toEqual(
        expect.arrayContaining([
          { type: "rule", field: "minYear", operator: ">=", value: 2020 },
          { type: "rule", field: "maxYear", operator: "<=", value: 2024 },
          { type: "rule", field: "trackRating", operator: ">=", value: 4 },
        ]),
      );
    });

    it("should use filter genre when adding to collection (filter takes precedence)", async () => {
      mockConfig.getLoadedConfig.mockReturnValue({
        plex: { url: "http://localhost:32400", token: "test-token" },
        plexFilters: {
          "jazz-filter": {
            match: "all",
            library: "Music",
            type: "track",
            rules: [{ type: "rule", field: "genre", operator: "contains", value: "Jazz" }],
          },
        },
      });

      const tracks = [mockTrack("5", "Jazz Song", "/jazz.flac")];
      mockAdapterFunctions.queryTracks.mockResolvedValue({
        items: tracks,
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const existingCollection = mockCollection("100", "My Collection", 10);
      mockAdapterFunctions.findCollectionByName.mockResolvedValue(existingCollection);
      mockAdapterFunctions.getCollection.mockResolvedValue(
        mockCollection("100", "My Collection", 11),
      );

      await executeCollectionAdd({
        collectionName: "My Collection",
        library: "Music",
        filter: "jazz-filter",
        genre: "Rock", // CLI provides Rock, filter's Jazz takes precedence
        style: "Classic Rock", // CLI adds style (filter has no style rule)
      });

      // Filter genre (Jazz) takes precedence, CLI style is added
      expect(queriedRules(mockAdapterFunctions.queryTracks)).toEqual(
        expect.arrayContaining([
          { type: "rule", field: "genre", operator: "contains", value: "Jazz" },
          { type: "rule", field: "style", operator: "contains", value: "Classic Rock" },
        ]),
      );
    });
  });
});

// =============================================================================
// Configuration Error Handling
// =============================================================================

describe("Configuration Error Handling", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should throw error when config is missing", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({});

    await expect(
      executeCollectionCreate({
        collectionName: "Test",
        library: "Music",
      }),
    ).rejects.toThrow("Plex URL and token are required");
  });

  it("should throw error when plex URL is missing", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      plex: { token: "test-token" },
    });

    await expect(
      executeCollectionCreate({
        collectionName: "Test",
        library: "Music",
      }),
    ).rejects.toThrow("Plex URL and token are required");
  });

  it("should throw error when plex token is missing", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      plex: { url: "http://localhost:32400" },
    });

    await expect(
      executeCollectionCreate({
        collectionName: "Test",
        library: "Music",
      }),
    ).rejects.toThrow("Plex URL and token are required");
  });

  it("should throw error for invalid URL format", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({
      plex: { url: "not-a-url", token: "test-token" },
    });
    mockAdapterFunctions.isValidPlexUrl.mockReturnValue(false);

    await expect(
      executeCollectionCreate({
        collectionName: "Test",
        library: "Music",
      }),
    ).rejects.toThrow("Invalid Plex URL format");
  });

  it("should work with CLI overrides when config is empty", async () => {
    mockConfig.getLoadedConfig.mockReturnValue({});
    mockAdapterFunctions.isValidPlexUrl.mockReturnValue(true);

    await executeCollectionCreate({
      collectionName: "Test",
      library: "Music",
      plexUrl: "http://localhost:32400",
      plexToken: "cli-token",
    });

    expect(mockResolveRequiredMediaServerAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        plexUrl: "http://localhost:32400",
        plexToken: "cli-token",
      }),
    );
    expect(mockAdapterFunctions.findLibraryByName).toHaveBeenCalledWith("Music");
  });
});
