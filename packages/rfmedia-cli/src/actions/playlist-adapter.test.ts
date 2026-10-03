import { describe, it, expect, expectTypeOf, vi, beforeEach } from "vitest";

import type { MediaServerAdapter, MediaTrack } from "../types/media-server.js";
import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";
import {
  createMediaPlaylistFixture,
  createMediaTrackFixture,
} from "./test-helpers/media-server-fixtures.js";

const mockResolveRequiredMediaServerAdapter = vi.hoisted(() => vi.fn());
const mockExtractTrackFilePaths = vi.hoisted(() => vi.fn());

const mockCommon = vi.hoisted(() => ({
  isMachineFormat: vi.fn().mockReturnValue(false),
  getOutputFormat: vi.fn().mockReturnValue("text" as const),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  formatDryRun: vi.fn((message: string) => `[DRY RUN] ${message}`),
}));

const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(false),
  remove: vi.fn().mockResolvedValue(undefined),
}));

const mockM3u = vi.hoisted(() => ({
  writeM3UPlaylist: vi.fn().mockResolvedValue({
    success: true,
    trackCount: 1,
    outputPath: "/tmp/test.m3u8",
  }),
}));

const mockDb = vi.hoisted(() => ({
  initializeDatabase: vi.fn().mockResolvedValue({ close: vi.fn() }),
  createSmartPlaylist: vi.fn().mockReturnValue(1),
  getSmartPlaylist: vi.fn().mockReturnValue(null),
  updateSmartPlaylist: vi.fn(),
  recordPlaylistHistory: vi.fn(),
  listSmartPlaylists: vi.fn().mockReturnValue([]),
  deleteSmartPlaylist: vi.fn().mockReturnValue(true),
  getSmartPlaylistById: vi.fn().mockReturnValue(null),
  getSmartPlaylistHistory: vi.fn().mockReturnValue([]),
}));

vi.mock("@rfmedia/common", () => mockCommon);
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/filesystem.js", () => mockFilesystem);
vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    filters: {},
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      allowedLibraryRoots: ["/music"],
    },
  }),
}));
vi.mock("../lib/audio.js", () => ({ findAudioFiles: vi.fn().mockResolvedValue([]) }));
vi.mock("../lib/metadata.js", () => ({ readExtendedMetadata: vi.fn() }));
vi.mock("../lib/ratings.js", () => ({ evaluateSmartFilter: vi.fn() }));
vi.mock("../lib/parallel.js", () => ({
  processInParallel: vi.fn(),
  getDefaultWorkers: vi.fn().mockReturnValue(4),
}));
vi.mock("../lib/m3u.js", () => mockM3u);
vi.mock("../lib/db.js", () => mockDb);
vi.mock("../lib/prompt.js", () => ({ confirm: vi.fn().mockResolvedValue(true) }));
vi.mock("../lib/formatters/index.js", () => ({ formatOutput: vi.fn() }));
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockResolveRequiredMediaServerAdapter,
  extractTrackFilePaths: mockExtractTrackFilePaths,
}));

import { executePlaylistCreate } from "./playlist.js";

describe("playlist adapter integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses required adapter for plex-playlist source", async () => {
    const adapterMock = createMediaServerAdapterMock();
    const playlist = createMediaPlaylistFixture({
      id: "playlist-1",
      title: "Source Playlist",
    });
    const track = createMediaTrackFixture();

    adapterMock.playlist.byName.mockResolvedValue(playlist);
    adapterMock.playlist.tracks.mockResolvedValue([track]);
    mockResolveRequiredMediaServerAdapter.mockReturnValue(adapterMock.adapter);
    mockExtractTrackFilePaths.mockResolvedValue({
      valid: [track.filePath],
      missing: [],
    });

    const result = await executePlaylistCreate({
      name: "Adapter Playlist",
      output: "/tmp/test.m3u8",
      plexPlaylist: "Source Playlist",
    });

    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(1);
    expect(mockResolveRequiredMediaServerAdapter).toHaveBeenCalledWith({});
    expect(adapterMock.playlist.byName).toHaveBeenCalledWith("Source Playlist");
    expect(adapterMock.playlist.tracks).toHaveBeenCalledOnce();
  });

  it("keeps shared fixtures and grouped mocks on the generic contract", async () => {
    const createCollection = vi.fn().mockResolvedValue({
      id: "collection-1",
      title: "Favorites",
      kind: "track" as const,
      itemCount: 0,
      smart: false,
    });
    const addCollectionItems = vi.fn().mockResolvedValue(undefined);
    const adapterMock = createMediaServerAdapterMock();
    const overriddenAdapterMock = createMediaServerAdapterMock({
      collection: {
        create: createCollection,
        addItems: addCollectionItems,
      },
    });
    const track = createMediaTrackFixture();

    await overriddenAdapterMock.adapter.collection.create("library-1", {
      title: "Favorites",
      kind: "track",
    });
    await overriddenAdapterMock.adapter.collection.addItems("collection-1", ["track-1"]);

    expect(track).toMatchObject({ id: "track-1", kind: "track", rating: 0.8 });
    expect(track).not.toHaveProperty("ratingKey");
    expect(adapterMock.adapter.features.sonicAnalysis).toBe("server-dependent");
    expect(adapterMock.adapter.features.ratings).toMatchObject({
      readable: true,
      writable: true,
      normalized: true,
    });
    await expect(
      adapterMock.adapter.query.tracks({ library: "Music", kind: "track" }),
    ).resolves.toMatchObject({ returned: 0, items: [] });
    expect(createCollection).toHaveBeenCalledWith("library-1", {
      title: "Favorites",
      kind: "track",
    });
    expect(addCollectionItems).toHaveBeenCalledWith("collection-1", ["track-1"]);
    expectTypeOf(adapterMock.adapter).toEqualTypeOf<MediaServerAdapter>();
    expectTypeOf(track).toEqualTypeOf<MediaTrack>();
    expectTypeOf(adapterMock.collection.addItems).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(adapterMock.collection.addItems).parameter(1).toEqualTypeOf<readonly string[]>();
  });
});
