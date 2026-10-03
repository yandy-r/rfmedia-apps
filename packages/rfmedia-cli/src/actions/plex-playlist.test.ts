/**
 * Tests for plex-playlist.ts - Plex playlist action handlers.
 *
 * Tests playlist listing, export, and sync operations with proper mock setup.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MediaAlbum,
  MediaPage,
  MediaPlaylist,
  MediaServerAdapter,
  MediaServerLibrary,
  MediaTrack,
} from "../types/media-server.js";
import {
  DEFAULT_MEDIA_SERVER_FEATURES,
  createMediaLibraryFixture,
  createMediaPlaylistFixture,
  createMediaTrackFixture,
} from "./test-helpers/media-server-fixtures.js";
import { createPlexPlaylistAdapterMock } from "./plex-playlist-adapter.mock.js";

// Mock definitions with vi.hoisted() - must be defined before vi.mock() calls
const mockLogger = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  formatDryRun: vi.fn((msg: string) => `[DRY RUN] ${msg}`),
  isJsonMode: vi.fn().mockReturnValue(false),
}));

const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  copyOrLink: vi.fn().mockResolvedValue("copy"),
  getFileSize: vi.fn().mockResolvedValue(1024 * 1024), // 1MB default
  remove: vi.fn().mockResolvedValue(undefined),
  sanitizeForFilesystem: vi.fn((name: string) => name), // Pass-through by default
}));

const mockPlex = vi.hoisted(() => ({
  getPlaylists: vi.fn().mockResolvedValue([]),
  findPlaylistByName: vi.fn().mockResolvedValue({
    id: "123",
    title: "Test Playlist",
    smart: false,
    itemCount: 2,
    durationMs: 300000,
    createdAt: 1700000000,
    updatedAt: 1700000000,
  }),
  getPlaylistTracks: vi.fn().mockResolvedValue([]),
  buildPlexConfig: vi.fn().mockReturnValue({ url: "http://localhost:32400", token: "test" }),
  triggerPlexScan: vi.fn().mockResolvedValue({ success: true, message: "Scan triggered" }),
  getTrackFilePaths: vi.fn().mockResolvedValue({ valid: [], missing: [] }),
  findLibraryByName: vi.fn().mockResolvedValue({
    id: "1",
    title: "Music",
    kind: "artist",
  }),
  queryPlexTracks: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  }),
  queryPlexAlbums: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  }),
  getAlbumTracks: vi.fn().mockResolvedValue([]),
  createPlaylist: vi.fn().mockResolvedValue({
    id: "200",
    title: "New Playlist",
    smart: false,
    itemCount: 0,
    durationMs: 0,
    createdAt: 1700000000,
    updatedAt: 1700000000,
  }),
  addTracksToPlaylist: vi.fn().mockResolvedValue(undefined),
  isValidPlexUrl: vi.fn().mockReturnValue(true),
}));

const mockResolveRequiredMediaServerAdapter = vi.hoisted(() => vi.fn());
const mockResolveOptionalScanAdapter = vi.hoisted(() => vi.fn());

const mockConvert = vi.hoisted(() => ({
  convertFile: vi.fn().mockResolvedValue(undefined),
  getConvertedFilename: vi.fn((filename: string, format: string) => {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    return `${base}.${format}`;
  }),
}));

const mockParallel = vi.hoisted(() => ({
  processInParallel: vi.fn(
    async (items: unknown[], fn: (item: unknown) => Promise<void>, _options: unknown) => {
      // Process sequentially in tests for predictability
      for (const item of items) {
        await fn(item);
      }
      // Return empty results array (not used in our tests)
      return [];
    },
  ),
}));

const mockProgressBar = vi.hoisted(() => {
  const mockInstance = {
    start: vi.fn(),
    updateFile: vi.fn(),
    stop: vi.fn(),
  };
  return {
    CopyProgressBar: vi.fn(() => mockInstance),
    instance: mockInstance,
  };
});

const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      scanAfterCopy: true,
    },
    copy: {
      workers: 4,
      progress: true,
    },
  }),
}));

const mockConfig = vi.hoisted(() => ({
  getAllowedLibraryRoots: vi.fn().mockReturnValue([]),
}));

const mockTableFormat = vi.hoisted(() => ({
  formatCopySummaryTable: vi.fn().mockReturnValue("Mock Summary Table"),
}));

const mockAudio = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
}));

const mockSyncHelper = vi.hoisted(() => ({
  syncTrackRating: vi.fn().mockResolvedValue({ success: true }),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/filesystem.js", () => mockFilesystem);
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockResolveRequiredMediaServerAdapter,
  resolveOptionalScanAdapter: mockResolveOptionalScanAdapter,
  extractTrackFilePaths: mockPlex.getTrackFilePaths,
}));
vi.mock("../lib/convert.js", () => mockConvert);
vi.mock("../lib/parallel.js", () => mockParallel);
vi.mock("../lib/progress-bar.js", () => mockProgressBar);
vi.mock("../lib/loaded-config.js", () => mockLoadedConfig);
vi.mock("../lib/config.js", () => mockConfig);
vi.mock("../lib/table-format.js", () => mockTableFormat);
vi.mock("../lib/audio.js", () => mockAudio);
vi.mock("../lib/sync-helper.js", () => mockSyncHelper);

// Import after mocks
import {
  executePlaylistExport,
  executePlaylistSync,
  listPlaylists,
  executePlaylistCreate,
  executePlaylistAdd,
} from "./plex-playlist.js";
import type { PlaylistCreateOptions } from "../types/plex.js";

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function toMediaTrack(value: unknown): MediaTrack {
  const item = record(value);
  const nativeRating = item["userRating"];
  return {
    id: String(item["ratingKey"] ?? item["id"]),
    kind: "track",
    title: String(item["title"] ?? ""),
    artist: String(item["artist"] ?? ""),
    album: String(item["album"] ?? ""),
    rating:
      typeof item["rating"] === "number"
        ? item["rating"]
        : typeof nativeRating === "number" && nativeRating > 0
          ? nativeRating / 10
          : null,
    playCount: Number(item["playCount"] ?? item["viewCount"] ?? 0),
    durationMs: Number(item["durationMs"] ?? item["duration"] ?? 0),
    filePath: String(item["filePath"] ?? ""),
  };
}

function toMediaAlbum(value: unknown): MediaAlbum {
  const item = record(value);
  const nativeRating = item["userRating"];
  return {
    id: String(item["ratingKey"] ?? item["id"]),
    kind: "album",
    title: String(item["title"] ?? ""),
    artist: String(item["artist"] ?? ""),
    rating:
      typeof item["rating"] === "number"
        ? item["rating"]
        : typeof nativeRating === "number" && nativeRating > 0
          ? nativeRating / 10
          : null,
    trackCount: Number(item["trackCount"] ?? 0),
  };
}

function toMediaPlaylist(value: unknown): MediaPlaylist {
  const item = record(value);
  return {
    id: String(item["id"] ?? item["ratingKey"]),
    title: String(item["title"] ?? ""),
    smart: Boolean(item["smart"]),
    itemCount: Number(item["itemCount"] ?? item["leafCount"] ?? 0),
    durationMs: Number(item["durationMs"] ?? item["duration"] ?? 0),
    createdAt: Number(item["createdAt"] ?? item["addedAt"] ?? 0),
    updatedAt: Number(item["updatedAt"] ?? 0),
  };
}

function toMediaLibrary(value: unknown): MediaServerLibrary {
  const item = record(value);
  const kind = item["kind"] ?? item["type"];
  return {
    id: String(item["id"] ?? item["key"]),
    title: String(item["title"] ?? ""),
    kind: kind === "album" || kind === "track" ? kind : "artist",
  };
}

function toMediaPage<T extends MediaTrack | MediaAlbum>(
  value: unknown,
  itemKey: "tracks" | "albums",
  mapper: (item: unknown) => T,
): MediaPage<T> {
  const result = record(value);
  const rawItems = (result["items"] ?? result[itemKey] ?? []) as readonly unknown[];
  return {
    items: rawItems.map(mapper),
    total: Number(result["total"] ?? result["totalSize"] ?? rawItems.length),
    offset: Number(result["offset"] ?? 0),
    returned: Number(result["returned"] ?? result["pageItemCount"] ?? rawItems.length),
    hasMore: Boolean(result["hasMore"]),
  };
}

function createMockMediaServerAdapter(plexConfig: {
  url: string;
  token: string;
}): MediaServerAdapter {
  return {
    type: "plex",
    capabilities: {
      query: true,
      library: true,
      scan: true,
      playlist: true,
      collection: true,
      metadata: true,
    },
    features: DEFAULT_MEDIA_SERVER_FEATURES,
    query: {
      libraryContentVersion: async () => ({
        libraryId: "library-1",
        value: "content-version-1",
      }),
      trackById: async () => {
        throw new Error("unused");
      },
      tracks: async (options) =>
        toMediaPage(await mockPlex.queryPlexTracks(plexConfig, options), "tracks", toMediaTrack),
      albums: async (options) =>
        toMediaPage(await mockPlex.queryPlexAlbums(plexConfig, options), "albums", toMediaAlbum),
      artists: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        offset: 0,
        returned: 0,
        hasMore: false,
      }),
      albumTracks: async (albumKey) =>
        (await mockPlex.getAlbumTracks(plexConfig, albumKey)).map(toMediaTrack),
    },
    library: {
      list: vi.fn().mockResolvedValue([]),
      byName: async (name) => toMediaLibrary(await mockPlex.findLibraryByName(plexConfig, name)),
    },
    scan: {
      trigger: () => mockPlex.triggerPlexScan(plexConfig),
      triggerPath: vi.fn(),
      triggerSource: vi.fn(),
    },
    playlist: {
      list: async () => (await mockPlex.getPlaylists(plexConfig)).map(toMediaPlaylist),
      byName: async (name) => toMediaPlaylist(await mockPlex.findPlaylistByName(plexConfig, name)),
      delete: vi.fn(),
      tracks: async (playlistKey) =>
        (await mockPlex.getPlaylistTracks(plexConfig, playlistKey)).map(toMediaTrack),
      create: async (name, options) =>
        toMediaPlaylist(await mockPlex.createPlaylist(plexConfig, name, options)),
      addTracks: (playlistKey, trackKeys) =>
        mockPlex.addTracksToPlaylist(plexConfig, playlistKey, [...trackKeys]),
    },
    collection: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      byName: vi.fn(),
      items: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      addItems: vi.fn(),
      delete: vi.fn(),
    },
    metadata: {
      updateTrackRating: vi.fn(),
    },
  };
}

// Type alias for partial query options used in tests
// The compatibility query options require library/type,
// but the implementation only uses the filter fields. We cast to allow partial data in tests.
type TestQueryOptions = NonNullable<PlaylistCreateOptions["queryOptions"]>;

// Test data
const mockPlaylist = {
  id: "123",
  title: "Test Playlist",
  smart: false,
  itemCount: 2,
  durationMs: 300000,
  createdAt: 1700000000,
  updatedAt: 1700000000,
};

const mockTracks = [
  {
    id: "1",
    kind: "track" as const,
    title: "Track 1",
    artist: "Artist A",
    album: "Album 1",
    rating: 0.8,
    playCount: 10,
    durationMs: 180000,
    filePath: "/music/Artist A/Album 1/track1.flac",
  },
  {
    id: "2",
    kind: "track" as const,
    title: "Track 2",
    artist: "Artist A",
    album: "Album 1",
    rating: 1,
    playCount: 5,
    durationMs: 200000,
    filePath: "/music/Artist A/Album 1/track2.flac",
  },
];

function setAdapterResolverMocks(): void {
  mockResolveRequiredMediaServerAdapter.mockImplementation(
    (overrides?: { plexUrl?: string; plexToken?: string }) => {
      const loadedConfig = mockLoadedConfig.getLoadedConfig();
      const url = overrides?.plexUrl ?? loadedConfig.plex?.url;
      const token = overrides?.plexToken ?? loadedConfig.plex?.token;

      if (!url || !token) {
        throw new Error(
          "Plex URL and token are required. Set in config or use --plex-url and --plex-token",
        );
      }

      if (!mockPlex.isValidPlexUrl(url)) {
        throw new Error(`Invalid Plex URL format: ${url}`);
      }

      return createMockMediaServerAdapter({ url, token });
    },
  );

  mockResolveOptionalScanAdapter.mockImplementation(
    (overrides?: {
      plexUrl?: string;
      plexToken?: string;
      plexScan?: boolean;
      plexPerSource?: boolean;
      plexLibrary?: string;
    }) => {
      const loadedConfig = mockLoadedConfig.getLoadedConfig();
      const scanEnabled = overrides?.plexScan ?? loadedConfig.plex?.scanAfterCopy ?? false;
      const libraryName = overrides?.plexLibrary ?? loadedConfig.plex?.libraryName;
      const scanPerSource = overrides?.plexPerSource ?? loadedConfig.plex?.scanPerSource ?? false;

      if (!scanEnabled) {
        return { adapter: undefined, scanPerSource, libraryName };
      }

      try {
        const adapter = mockResolveRequiredMediaServerAdapter(overrides);
        return { adapter, scanPerSource, libraryName };
      } catch {
        return { adapter: undefined, scanPerSource, libraryName };
      }
    },
  );
}

// =============================================================================
// Helper to reset all mocks to default state
// =============================================================================

function resetMocksToDefaults() {
  vi.clearAllMocks(); // NOT resetAllMocks!
  setAdapterResolverMocks();

  // Reset config
  mockLoadedConfig.getLoadedConfig.mockReturnValue({
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      scanAfterCopy: true,
    },
    copy: {
      workers: 4,
      progress: true,
    },
  });

  // Reset Plex functions to default success responses
  mockPlex.isValidPlexUrl.mockReturnValue(true);
  mockPlex.findLibraryByName.mockResolvedValue({
    id: "1",
    title: "Music",
    kind: "artist",
  });
  mockPlex.getPlaylists.mockResolvedValue([]);
  mockPlex.findPlaylistByName.mockResolvedValue({
    id: "123",
    title: "Test Playlist",
    smart: false,
    itemCount: 2,
    durationMs: 300000,
    createdAt: 1700000000,
    updatedAt: 1700000000,
  });
  mockPlex.getPlaylistTracks.mockResolvedValue([]);
  mockPlex.queryPlexTracks.mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  });
  mockPlex.queryPlexAlbums.mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  });
  mockPlex.getAlbumTracks.mockResolvedValue([]);
  mockPlex.createPlaylist.mockResolvedValue({
    id: "200",
    title: "New Playlist",
    smart: false,
    itemCount: 0,
    durationMs: 0,
    createdAt: 1700000000,
    updatedAt: 1700000000,
  });
  mockPlex.addTracksToPlaylist.mockResolvedValue(undefined);
  mockPlex.buildPlexConfig.mockReturnValue({ url: "http://localhost:32400", token: "test" });
  mockPlex.triggerPlexScan.mockResolvedValue({ success: true, message: "Scan triggered" });
  mockPlex.getTrackFilePaths.mockResolvedValue({ valid: [], missing: [] });

  // Reset filesystem functions
  mockFilesystem.pathExists.mockResolvedValue(false);
  mockFilesystem.ensureDir.mockResolvedValue(undefined);
  mockFilesystem.copyOrLink.mockResolvedValue("copy");
  mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
  mockFilesystem.remove.mockResolvedValue(undefined);
  mockFilesystem.sanitizeForFilesystem.mockImplementation((name: string) => name);

  // Reset audio functions
  mockAudio.findAudioFiles.mockResolvedValue([]);
}

describe("executePlaylistExport", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks(); // NOT resetAllMocks!
    setAdapterResolverMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-playlist-test-"));

    // Re-establish default mock implementations after clearAllMocks
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockPlex.findPlaylistByName.mockResolvedValue(mockPlaylist);
    mockPlex.getPlaylistTracks.mockResolvedValue(mockTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist A/Album 1/track1.flac", "/music/Artist A/Album 1/track2.flac"],
      missing: [],
    });
    mockPlex.buildPlexConfig.mockReturnValue({ url: "http://localhost:32400", token: "test" });
    mockPlex.triggerPlexScan.mockResolvedValue({ success: true, message: "Scan triggered" });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should export all tracks from playlist", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.totalTracks).toBe(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);

    expect(mockPlex.findPlaylistByName).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:32400", token: "test-token" }),
      "Test Playlist",
    );
    expect(mockPlex.getPlaylistTracks).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:32400", token: "test-token" }),
      "123",
    );
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(2);
  });

  it("should skip existing files", async () => {
    // File already exists
    mockFilesystem.pathExists.mockResolvedValue(true);

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });

  it("should handle hardlink option", async () => {
    mockFilesystem.copyOrLink.mockResolvedValue("hardlink");

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      hardlink: true,
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
      "/music/Artist A/Album 1/track1.flac",
      expect.any(String),
      true, // hardlink = true
    );
  });

  it("should handle convert option", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      convertFormat: "mp3",
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(mockConvert.convertFile).toHaveBeenCalledWith(
      "/music/Artist A/Album 1/track1.flac",
      expect.stringContaining(".mp3"),
      "mp3",
    );
  });

  it("should collect failed operations without stopping", async () => {
    const permissionError = new Error("Permission denied");
    (permissionError as NodeJS.ErrnoException).code = "EACCES";
    mockFilesystem.copyOrLink.mockRejectedValue(permissionError);

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.path).toBe("/music/Artist A/Album 1/track1.flac");
    expect(result.failed[0]?.message).toBe("Permission denied");
    expect(result.failed[0]?.code).toBe("EACCES");
  });

  it("should trigger Plex scan when configured", async () => {
    mockPlex.triggerPlexScan.mockResolvedValue({
      success: true,
      message: "Scan triggered",
      libraryName: "Music",
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      plexScan: true,
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(mockPlex.triggerPlexScan).toHaveBeenCalled();
    expect(mockLogger.logSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Plex library scan triggered"),
    );
  });

  it("should respect dry-run mode", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      dryRun: true,
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    expect(mockFilesystem.ensureDir).not.toHaveBeenCalled();
    expect(mockPlex.triggerPlexScan).not.toHaveBeenCalled();
    expect(mockLogger.logDebug).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });

  it("should validate path traversal (artist name with ../)", async () => {
    // Setup tracks with malicious path structure
    // Path: /music/Artist/Album/../../../escape/track.flac
    // extractPlexPathInfo extracts:
    //   albumDir = /music/Artist/Album/../../../escape
    //   artistDir = /music/Artist/Album/../../.. (which basename returns '..')
    // This creates artistName = '..' which escapes when joined to destination
    const maliciousTracks = [
      {
        ratingKey: "1",
        title: "Track 1",
        artist: "..",
        album: "escape",
        userRating: 8,
        viewCount: 10,
        duration: 180000,
        filePath: "/music/Artist/Album/../../../escape/track1.flac",
      },
    ];

    mockPlex.getPlaylistTracks.mockResolvedValue(maliciousTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist/Album/../../../escape/track1.flac"],
      missing: [],
    });

    // With preserveStructure, the path will use the extracted artist name '..'
    // which causes path.join(dest, '..', 'escape') to escape the base directory
    await expect(
      executePlaylistExport({
        playlistName: "Test Playlist",
        destination: tempDir,
        preserveStructure: true,
        progress: false,
      }),
    ).rejects.toThrow("Path traversal detected");

    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });

  it("should preserve folder structure when preserveStructure is true", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      preserveStructure: true,
      progress: false,
    });

    expect(result.created).toBe(2);
    // With preserveStructure, paths should include Artist/Album structure
    expect(mockFilesystem.ensureDir).toHaveBeenCalledWith(
      expect.stringContaining(path.join("Artist A", "Album 1")),
    );
  });

  it("should handle empty playlist gracefully", async () => {
    mockPlex.getPlaylistTracks.mockResolvedValue([]);

    const result = await executePlaylistExport({
      playlistName: "Empty Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.totalTracks).toBe(0);
    expect(result.created).toBe(0);
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });

  it("should skip missing files", async () => {
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist A/Album 1/track1.flac"],
      missing: ["/music/Artist A/Album 1/track2.flac"],
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    // Only one valid file should be processed
    expect(result.created).toBe(1);
    expect(mockLogger.logDebug).toHaveBeenCalledWith("1 files are missing and will be skipped");
  });

  it("should skip Plex scan when disabled", async () => {
    await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      plexScan: false,
      progress: false,
    });

    expect(mockPlex.triggerPlexScan).not.toHaveBeenCalled();
  });
});

describe("executePlaylistSync", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setAdapterResolverMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-playlist-sync-test-"));

    // Re-establish default mock implementations
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockFilesystem.remove.mockResolvedValue(undefined);
    mockPlex.findPlaylistByName.mockResolvedValue(mockPlaylist);
    mockPlex.getPlaylistTracks.mockResolvedValue(mockTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist A/Album 1/track1.flac", "/music/Artist A/Album 1/track2.flac"],
      missing: [],
    });
    mockPlex.buildPlexConfig.mockReturnValue({ url: "http://localhost:32400", token: "test" });
    mockPlex.triggerPlexScan.mockResolvedValue({ success: true, message: "Scan triggered" });
    mockAudio.findAudioFiles.mockResolvedValue([]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should export new tracks", async () => {
    const result = await executePlaylistSync({
      playlistName: "Test Playlist",
      destination: tempDir,
      flat: true, // Use flat mode to test sync logic without subfolder complexity
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(2);
  });

  it("should remove deleted tracks when --delete-removed", async () => {
    // Simulate existing file that is no longer in the playlist
    const oldFile = path.join(tempDir, "old-track.flac");
    mockAudio.findAudioFiles.mockResolvedValue([oldFile]);
    // pathExists returns true for destination directory check
    mockFilesystem.pathExists.mockImplementation(async (filePath: string) => {
      if (filePath === tempDir) return true;
      return false;
    });

    const result = await executePlaylistSync({
      playlistName: "Test Playlist",
      destination: tempDir,
      deleteRemoved: true,
      flat: true, // Use flat mode to test sync logic without subfolder complexity
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(result.removed).toBe(1);
    expect(mockFilesystem.remove).toHaveBeenCalledWith(oldFile);
    expect(mockLogger.logSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Removed 1 files no longer in playlist"),
    );
  });

  it("should not remove without --delete-removed", async () => {
    // Simulate existing file that is no longer in the playlist
    const oldFile = path.join(tempDir, "old-track.flac");
    mockAudio.findAudioFiles.mockResolvedValue([oldFile]);

    const result = await executePlaylistSync({
      playlistName: "Test Playlist",
      destination: tempDir,
      deleteRemoved: false,
      flat: true, // Use flat mode to test sync logic without subfolder complexity
      progress: false,
    });

    expect(result.created).toBe(2);
    expect(result.removed).toBeUndefined();
    expect(mockFilesystem.remove).not.toHaveBeenCalled();
  });

  it("should handle dry-run with --delete-removed", async () => {
    const oldFile = path.join(tempDir, "old-track.flac");
    mockAudio.findAudioFiles.mockResolvedValue([oldFile]);
    mockFilesystem.pathExists.mockImplementation(async (filePath: string) => {
      if (filePath === tempDir) return true;
      return false;
    });

    const result = await executePlaylistSync({
      playlistName: "Test Playlist",
      destination: tempDir,
      deleteRemoved: true,
      dryRun: true,
      flat: true, // Use flat mode to test sync logic without subfolder complexity
      progress: false,
    });

    expect(result.removed).toBe(1);
    expect(mockFilesystem.remove).not.toHaveBeenCalled();
    expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });

  it("should collect failed remove operations", async () => {
    const oldFile = path.join(tempDir, "old-track.flac");
    mockAudio.findAudioFiles.mockResolvedValue([oldFile]);
    mockFilesystem.pathExists.mockImplementation(async (filePath: string) => {
      if (filePath === tempDir) return true;
      return false;
    });

    const removeError = new Error("Cannot remove file");
    (removeError as NodeJS.ErrnoException).code = "EPERM";
    mockFilesystem.remove.mockRejectedValue(removeError);

    const result = await executePlaylistSync({
      playlistName: "Test Playlist",
      destination: tempDir,
      deleteRemoved: true,
      flat: true, // Use flat mode to test sync logic without subfolder complexity
      progress: false,
    });

    // Export should succeed
    expect(result.created).toBe(2);
    // Remove failed but was recorded
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(oldFile);
    expect(result.failed[0]?.message).toContain("Failed to remove");
    expect(result.failed[0]?.code).toBe("EPERM");
  });
});

describe("listPlaylists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdapterResolverMocks();

    // Reset mock implementations
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
      },
    });
    mockPlex.getPlaylists.mockResolvedValue([]);
  });

  it("projects generic playlist metadata to the legacy list result", async () => {
    const adapterMock = createPlexPlaylistAdapterMock();
    adapterMock.playlist.list.mockResolvedValue([
      createMediaPlaylistFixture({
        id: "opaque/playlist:id",
        title: "Projected Playlist",
        itemCount: 7,
        durationMs: 42_000,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ]);
    mockResolveRequiredMediaServerAdapter.mockReturnValue(adapterMock.adapter);

    const result = await listPlaylists({});

    expect(result).toEqual([
      {
        ratingKey: "opaque/playlist:id",
        title: "Projected Playlist",
        smart: false,
        leafCount: 7,
        duration: 42_000,
        addedAt: 0,
        updatedAt: 0,
      },
    ]);
  });

  it("should return all playlists", async () => {
    const playlists = [
      {
        ratingKey: "1",
        title: "Playlist 1",
        smart: false,
        leafCount: 10,
        duration: 600000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      {
        ratingKey: "2",
        title: "Playlist 2",
        smart: true,
        leafCount: 5,
        duration: 300000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      {
        ratingKey: "3",
        title: "Empty Playlist",
        smart: false,
        leafCount: 0,
        duration: 0,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
    ];
    mockPlex.getPlaylists.mockResolvedValue(playlists);

    const result = await listPlaylists({});

    expect(result).toHaveLength(3);
    expect(mockPlex.getPlaylists).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:32400", token: "test-token" }),
    );
  });

  it("should filter exportable playlists (leafCount > 0)", async () => {
    const playlists = [
      {
        ratingKey: "1",
        title: "Playlist 1",
        smart: false,
        leafCount: 10,
        duration: 600000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      {
        ratingKey: "2",
        title: "Playlist 2",
        smart: true,
        leafCount: 5,
        duration: 300000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
      {
        ratingKey: "3",
        title: "Empty Playlist",
        smart: false,
        leafCount: 0,
        duration: 0,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
    ];
    mockPlex.getPlaylists.mockResolvedValue(playlists);

    const result = await listPlaylists({ exportable: true });

    expect(result).toHaveLength(2);
    expect(result.some((p) => p.title === "Empty Playlist")).toBe(false);
  });

  it("should throw error when Plex URL is not configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: undefined,
        token: "test-token",
      },
    });

    await expect(listPlaylists({})).rejects.toThrow("Plex URL and token are required");
  });

  it("should throw error when Plex token is not configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: undefined,
      },
    });

    await expect(listPlaylists({})).rejects.toThrow("Plex URL and token are required");
  });

  it("should use CLI options to override config", async () => {
    const playlists = [
      {
        ratingKey: "1",
        title: "Playlist 1",
        smart: false,
        leafCount: 10,
        duration: 600000,
        addedAt: 1700000000,
        updatedAt: 1700000000,
      },
    ];
    mockPlex.getPlaylists.mockResolvedValue(playlists);

    await listPlaylists({
      plexUrl: "http://custom-plex:32400",
      plexToken: "custom-token",
    });

    expect(mockPlex.getPlaylists).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://custom-plex:32400", token: "custom-token" }),
    );
  });
});

describe("executePlaylistExport - Config playlistDefaults Consumption", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setAdapterResolverMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-playlist-defaults-test-"));

    // Re-establish default mock implementations
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockPlex.findPlaylistByName.mockResolvedValue(mockPlaylist);
    mockPlex.getPlaylistTracks.mockResolvedValue(mockTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist A/Album 1/track1.flac", "/music/Artist A/Album 1/track2.flac"],
      missing: [],
    });
    mockPlex.buildPlexConfig.mockReturnValue({ url: "http://localhost:32400", token: "test" });
    mockPlex.triggerPlexScan.mockResolvedValue({ success: true, message: "Scan triggered" });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Note: playlistDefaults (smart, updateExisting) are for playlist creation in Plex,
  // not for export operations. These tests verify that the config loads correctly
  // without errors when playlistDefaults is present (for future playlist creation support).

  it("should export successfully when playlistDefaults.smart is configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        playlistDefaults: {
          smart: true,
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    // Export should succeed - playlistDefaults doesn't affect export behavior
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.created).toBe(2);
  });

  it("should export successfully when playlistDefaults.updateExisting is configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        playlistDefaults: {
          updateExisting: true,
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.created).toBe(2);
  });

  it("should export successfully with both playlistDefaults.smart and updateExisting configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        playlistDefaults: {
          smart: true,
          updateExisting: true,
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.created).toBe(2);
  });

  it("should export successfully when playlistDefaults is not configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        // No playlistDefaults section
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.created).toBe(2);
  });

  it("should export successfully when playlistDefaults is empty object", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        playlistDefaults: {},
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.created).toBe(2);
  });

  it("should export successfully with partial playlistDefaults configuration", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        playlistDefaults: {
          smart: true,
          // updateExisting not set
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    expect(result.playlistName).toBe("Test Playlist");
    expect(result.created).toBe(2);
  });

  it("should export tracks successfully with playlistDefaults configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        playlistDefaults: {
          smart: true,
          updateExisting: true,
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
    });

    // Export should complete successfully
    expect(result.playlistName).toBe("Test Playlist");
    expect(result.totalTracks).toBe(2);
    expect(result.created).toBe(2);
    expect(result.failed).toHaveLength(0);
  });
});

describe("executePlaylistExport - Sync-on-Copy Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setAdapterResolverMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-playlist-sync-test-"));

    // Re-establish default mock implementations
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockPlex.findPlaylistByName.mockResolvedValue(mockPlaylist);
    mockPlex.getPlaylistTracks.mockResolvedValue(mockTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist A/Album 1/track1.flac", "/music/Artist A/Album 1/track2.flac"],
      missing: [],
    });
    mockPlex.buildPlexConfig.mockReturnValue({ url: "http://localhost:32400", token: "test" });
    mockPlex.triggerPlexScan.mockResolvedValue({ success: true, message: "Scan triggered" });
    mockSyncHelper.syncTrackRating.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should call syncTrackRating after export when syncRatings is true", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    expect(result.created).toBe(2);
    // Both tracks have userRating > 0 (8 and 10), so sync should be called for each
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(2);
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.stringContaining("track1.flac"),
      8, // userRating from mockTracks[0]
      expect.objectContaining({
        dryRun: false,
      }),
    );
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.stringContaining("track2.flac"),
      10, // userRating from mockTracks[1]
      expect.objectContaining({
        dryRun: false,
      }),
    );
  });

  it("should not call syncTrackRating when syncRatings is false (default)", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      // syncRatings not specified, defaults to false
    });

    expect(result.created).toBe(2);
    expect(mockSyncHelper.syncTrackRating).not.toHaveBeenCalled();
  });

  it("should skip sync for unrated tracks (userRating === 0)", async () => {
    // Create tracks with one rated and one unrated
    const tracksWithUnrated = [
      {
        ratingKey: "1",
        title: "Track 1",
        artist: "Artist A",
        album: "Album 1",
        userRating: 8, // rated
        viewCount: 10,
        duration: 180000,
        filePath: "/music/Artist A/Album 1/track1.flac",
      },
      {
        ratingKey: "2",
        title: "Track 2",
        artist: "Artist A",
        album: "Album 1",
        userRating: 0, // unrated
        viewCount: 5,
        duration: 200000,
        filePath: "/music/Artist A/Album 1/track2.flac",
      },
    ];

    mockPlex.getPlaylistTracks.mockResolvedValue(tracksWithUnrated);

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    expect(result.created).toBe(2);
    // Only track1 should have sync called (track2 has userRating === 0)
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(1);
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.stringContaining("track1.flac"),
      8,
      expect.any(Object),
    );
  });

  it("should not fail export when sync fails", async () => {
    // Make sync fail
    mockSyncHelper.syncTrackRating.mockResolvedValue({
      success: false,
      message: "Unsupported format",
    });

    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    // Export should still succeed
    expect(result.created).toBe(2);
    expect(result.failed).toHaveLength(0);
    // Sync was attempted
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(2);
    // Debug message should be logged for failures
    expect(mockLogger.logDebug).toHaveBeenCalledWith(expect.stringContaining("Rating sync failed"));
  });

  it("should display warning when syncRatings and hardlink are both enabled", async () => {
    await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
      hardlink: true,
    });

    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      "Warning: syncRatings with hardlink mode modifies source files",
    );
  });

  it("should pass custom popmEmail and vorbisScale to syncTrackRating", async () => {
    await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
      popmEmail: "custom@email.com",
      vorbisScale: "stars",
    });

    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        popmEmail: "custom@email.com",
        vorbisScale: "stars",
        dryRun: false,
      }),
    );
  });

  it("should sync with dryRun when export is in dryRun mode", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
      dryRun: true,
    });

    expect(result.created).toBe(2);
    // In dry-run mode, sync should not be called (file copy is skipped)
    // The syncTrackRating is only called inside the non-dryRun branch
    expect(mockSyncHelper.syncTrackRating).not.toHaveBeenCalled();
  });

  it("should sync ratings with preserveStructure mode", async () => {
    const result = await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      syncRatings: true,
      preserveStructure: true,
    });

    expect(result.created).toBe(2);
    // Sync should still be called in preserve structure mode
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(2);
  });

  it("should use config defaults for sync options", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        scanAfterCopy: true,
        syncRatingsOnCopy: true, // Enable sync via config
        syncOnCopyDefaults: {
          popmEmail: "config@email.com",
          vorbisScale: "percent",
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    await executePlaylistExport({
      playlistName: "Test Playlist",
      destination: tempDir,
      progress: false,
      // syncRatings not specified - should use config default (true)
    });

    // Sync should be called because config has syncRatingsOnCopy: true
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        popmEmail: "config@email.com",
        vorbisScale: "percent",
      }),
    );
  });
});

// =============================================================================
// executePlaylistCreate Tests
// =============================================================================

describe("executePlaylistCreate", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("uses generic capabilities and opaque IDs at the adapter boundary", async () => {
    const adapterMock = createPlexPlaylistAdapterMock();
    const track = createMediaTrackFixture({ id: "opaque:track/one" });
    const playlist = createMediaPlaylistFixture({
      id: "opaque:playlist/one",
      title: "Generic Boundary",
      itemCount: 0,
    });
    adapterMock.library.byName.mockResolvedValue(createMediaLibraryFixture({ id: "music/id" }));
    adapterMock.query.tracks.mockResolvedValue({
      items: [track],
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });
    adapterMock.playlist.byName.mockRejectedValue(new Error("not found"));
    adapterMock.playlist.create.mockResolvedValue(playlist);
    adapterMock.playlist.tracks.mockResolvedValue([track]);
    mockResolveRequiredMediaServerAdapter.mockReturnValue(adapterMock.adapter);

    const result = await executePlaylistCreate({
      playlistName: "Generic Boundary",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
    });

    expect(adapterMock.query.tracks).toHaveBeenCalledWith({
      kind: "track",
      library: "Music",
      filter: {
        match: "all",
        rules: [{ type: "rule", field: "genre", operator: "contains", value: "Jazz" }],
      },
      offset: 0,
      limit: 500,
    });
    expect(adapterMock.playlist.addTracks).toHaveBeenCalledWith("opaque:playlist/one", [
      "opaque:track/one",
    ]);
    expect(result.ratingKey).toBe("opaque:playlist/one");
  });

  it("should create new playlist from filter criteria", async () => {
    const tracks = [
      { ...mockTracks[0], ratingKey: "1" },
      { ...mockTracks[1], ratingKey: "2" },
    ];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 2,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName should throw to indicate playlist doesn't exist
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Playlist not found"));

    const createdPlaylist = {
      ratingKey: "200",
      title: "Jazz Favorites",
      smart: false,
      leafCount: 0,
      duration: 0,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.createPlaylist.mockResolvedValue(createdPlaylist);
    // Re-fetch after add returns the tracks we added (action uses this for accurate count)
    mockPlex.getPlaylistTracks.mockResolvedValue(tracks);

    const result = await executePlaylistCreate({
      playlistName: "Jazz Favorites",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
    });

    expect(result.playlistName).toBe("Jazz Favorites");
    expect(result.tracksAdded).toBe(2);
    expect(result.action).toBe("created");
    expect(result.smart).toBe(false);
    expect(mockPlex.findLibraryByName).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:32400", token: "test-token" }),
      "Music",
    );
    expect(mockPlex.createPlaylist).toHaveBeenCalledWith(expect.any(Object), "Jazz Favorites", {
      smart: false,
    });
    expect(mockPlex.addTracksToPlaylist).toHaveBeenCalledWith(expect.any(Object), "200", [
      "1",
      "2",
    ]);
  });

  it("should use advanced offset on second page when first page has zero items but hasMore true", async () => {
    const tracks = [
      { ...mockTracks[0], ratingKey: "1" },
      { ...mockTracks[1], ratingKey: "2" },
    ];
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Playlist not found"));
    mockPlex.queryPlexTracks
      .mockResolvedValueOnce({
        tracks: [],
        totalSize: 600,
        offset: 0,
        pageItemCount: 500,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        tracks,
        totalSize: 600,
        offset: 500,
        pageItemCount: 100,
        hasMore: false,
      });
    mockPlex.createPlaylist.mockResolvedValue({
      ratingKey: "200",
      title: "Multi Page",
      smart: false,
      leafCount: 0,
      duration: 0,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    });
    mockPlex.getPlaylistTracks.mockResolvedValue(tracks);

    const result = await executePlaylistCreate({
      playlistName: "Multi Page",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
    });

    expect(mockPlex.queryPlexTracks).toHaveBeenCalledTimes(2);
    expect(mockPlex.queryPlexTracks).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ offset: 500 }),
    );
    expect(result.tracksAdded).toBe(2);
    expect(result.action).toBe("created");
  });

  it("should update existing playlist when updateExisting=true", async () => {
    const tracks = [
      { ...mockTracks[0], ratingKey: "1" },
      { ...mockTracks[1], ratingKey: "2" },
    ];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 2,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName should return an existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "Existing Playlist",
      smart: false,
      leafCount: 5,
      duration: 600000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);
    const existingTracksList = Array.from({ length: 5 }, (_, i) => ({
      ...mockTracks[0],
      ratingKey: `e${i}`,
    }));
    const afterAddTracks = [...existingTracksList, ...tracks];
    mockPlex.getPlaylistTracks
      .mockResolvedValueOnce(existingTracksList)
      .mockResolvedValueOnce(afterAddTracks);

    const result = await executePlaylistCreate({
      playlistName: "Existing Playlist",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      updateExisting: true,
    });

    expect(result.playlistName).toBe("Existing Playlist");
    expect(result.tracksAdded).toBe(2);
    expect(result.action).toBe("updated");
    expect(result.ratingKey).toBe("100");
    // Should NOT create a new playlist
    expect(mockPlex.createPlaylist).not.toHaveBeenCalled();
    // Should add tracks to existing playlist
    expect(mockPlex.addTracksToPlaylist).toHaveBeenCalledWith(expect.any(Object), "100", [
      "1",
      "2",
    ]);
  });

  it("should throw when playlist exists and updateExisting=false", async () => {
    const tracks = [{ ...mockTracks[0], ratingKey: "1" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName should return an existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "Existing Playlist",
      smart: false,
      leafCount: 5,
      duration: 600000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    await expect(
      executePlaylistCreate({
        playlistName: "Existing Playlist",
        libraryName: "Music",
        queryOptions: { genre: "Jazz" } as TestQueryOptions,
        updateExisting: false,
      }),
    ).rejects.toThrow(
      'Playlist "Existing Playlist" already exists. Use --update-existing to add tracks to it.',
    );

    // Should NOT create or add tracks
    expect(mockPlex.createPlaylist).not.toHaveBeenCalled();
    expect(mockPlex.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  it("should handle empty filter results with clear error", async () => {
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks: [],
      totalSize: 0,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Not found"));

    await expect(
      executePlaylistCreate({
        playlistName: "Empty Playlist",
        libraryName: "Music",
        queryOptions: { genre: "NonexistentGenre" } as TestQueryOptions,
      }),
    ).rejects.toThrow("Filter returned no matching tracks");

    // Playlist should NOT be created
    expect(mockPlex.createPlaylist).not.toHaveBeenCalled();
    expect(mockPlex.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  it("should respect dry-run mode (no API calls)", async () => {
    const tracks = [
      { ...mockTracks[0], ratingKey: "1" },
      { ...mockTracks[1], ratingKey: "2" },
    ];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 2,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Not found"));

    const result = await executePlaylistCreate({
      playlistName: "Dry Run Playlist",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      dryRun: true,
    });

    expect(result.playlistName).toBe("Dry Run Playlist");
    expect(result.tracksAdded).toBe(2);
    expect(result.action).toBe("created");
    expect(result.ratingKey).toBe("dry-run");
    // Should NOT call create or add in dry-run mode
    expect(mockPlex.createPlaylist).not.toHaveBeenCalled();
    expect(mockPlex.addTracksToPlaylist).not.toHaveBeenCalled();
    // Should log dry-run message
    expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });

  it("should output JSON format when requested", async () => {
    const tracks = [{ ...mockTracks[0], ratingKey: "1" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Not found"));

    // Action returns result only; command layer emits JSON (no console.log in action)
    const result = await executePlaylistCreate({
      playlistName: "JSON Playlist",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      dryRun: true,
      json: true,
    });

    expect(result.playlistName).toBe("JSON Playlist");
    expect(result.tracksAdded).toBe(1);
    expect(result.action).toBe("created");
  });

  it("should load named filters from config", async () => {
    // Setup config with a named filter
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
      },
      plexFilters: {
        "jazz-favorites": {
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
      { ...mockTracks[0], ratingKey: "1" },
      { ...mockTracks[1], ratingKey: "2" },
    ];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 2,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Not found"));

    // Mock createPlaylist to return the correct title
    const createdPlaylist = {
      ratingKey: "200",
      title: "Jazz from Filter",
      smart: false,
      leafCount: 0,
      duration: 0,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.createPlaylist.mockResolvedValue(createdPlaylist);
    mockPlex.getPlaylistTracks.mockResolvedValue(tracks);

    const result = await executePlaylistCreate({
      playlistName: "Jazz from Filter",
      filterName: "jazz-favorites",
    });

    expect(result.playlistName).toBe("Jazz from Filter");
    expect(result.tracksAdded).toBe(2);
    // Library should be taken from filter config
    expect(mockPlex.findLibraryByName).toHaveBeenCalledWith(expect.any(Object), "Music");
    expect(mockLogger.logDebug).toHaveBeenCalledWith(
      expect.stringContaining("Loaded Plex filter: jazz-favorites"),
    );
  });

  it("should throw error when filter not found in config", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
      },
      plexFilters: {
        "existing-filter": { match: "all", rules: [] },
      },
    });

    await expect(
      executePlaylistCreate({
        playlistName: "Test",
        filterName: "nonexistent-filter",
        libraryName: "Music",
      }),
    ).rejects.toThrow('Filter "nonexistent-filter" not found in plexFilters config');
  });

  it("should throw error when library is not provided and not in filter", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
      },
    });

    await expect(
      executePlaylistCreate({
        playlistName: "Test",
        queryOptions: { genre: "Jazz" } as TestQueryOptions,
        // No libraryName and no filter with library
      }),
    ).rejects.toThrow("Library name is required");
  });

  it("should throw error when no filters or filter name provided", async () => {
    await expect(
      executePlaylistCreate({
        playlistName: "Test",
        libraryName: "Music",
        // No queryOptions and no filterName
      }),
    ).rejects.toThrow("No filters provided");
  });

  it("should create smart playlist when smart=true", async () => {
    const tracks = [{ ...mockTracks[0], ratingKey: "1" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Not found"));

    const createdPlaylist = {
      ratingKey: "200",
      title: "Smart Playlist",
      smart: true,
      leafCount: 0,
      duration: 0,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.createPlaylist.mockResolvedValue(createdPlaylist);

    const result = await executePlaylistCreate({
      playlistName: "Smart Playlist",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      smart: true,
    });

    expect(result.smart).toBe(true);
    expect(mockPlex.createPlaylist).toHaveBeenCalledWith(expect.any(Object), "Smart Playlist", {
      smart: true,
    });
  });

  it("should use CLI overrides for plexUrl and plexToken", async () => {
    const tracks = [{ ...mockTracks[0], ratingKey: "1" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Not found"));

    await executePlaylistCreate({
      playlistName: "CLI Override Test",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      url: "http://custom-server:32400",
      token: "custom-token",
    });

    expect(mockPlex.findLibraryByName).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://custom-server:32400",
        token: "custom-token",
      }),
      "Music",
    );
  });
});

// =============================================================================
// executePlaylistAdd Tests
// =============================================================================

describe("executePlaylistAdd", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should add tracks to existing playlist", async () => {
    const tracks = [
      { ...mockTracks[0], ratingKey: "10" },
      { ...mockTracks[1], ratingKey: "11" },
    ];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 2,
      offset: 0,
      hasMore: false,
    });

    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "My Playlist",
      smart: false,
      leafCount: 5,
      duration: 600000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    // Current tracks in playlist (for counting); second call = after add (re-fetch)
    const currentTracks = Array.from({ length: 5 }, (_, i) => ({
      ...mockTracks[0],
      ratingKey: String(i + 1),
    }));
    const afterAddTracks = [...currentTracks, ...tracks];
    mockPlex.getPlaylistTracks
      .mockResolvedValueOnce(currentTracks)
      .mockResolvedValueOnce(afterAddTracks);

    const result = await executePlaylistAdd({
      playlistName: "My Playlist",
      libraryName: "Music",
      queryOptions: { artist: "Miles Davis" } as TestQueryOptions,
    });

    expect(result.playlistName).toBe("My Playlist");
    expect(result.tracksAdded).toBe(2);
    expect(result.totalTracks).toBe(7); // 5 existing + 2 new
    expect(result.ratingKey).toBe("100");
    expect(mockPlex.addTracksToPlaylist).toHaveBeenCalledWith(expect.any(Object), "100", [
      "10",
      "11",
    ]);
  });

  it("should throw when playlist does not exist", async () => {
    // findPlaylistByName throws (playlist doesn't exist)
    mockPlex.findPlaylistByName.mockRejectedValue(new Error("Playlist not found"));

    await expect(
      executePlaylistAdd({
        playlistName: "Nonexistent Playlist",
        libraryName: "Music",
        queryOptions: { genre: "Jazz" } as TestQueryOptions,
      }),
    ).rejects.toThrow(
      'Playlist "Nonexistent Playlist" not found. Use "plex playlist create" to create a new playlist.',
    );

    // Should NOT call addTracksToPlaylist
    expect(mockPlex.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  it("should return correct track counts", async () => {
    const newTracks = [
      { ...mockTracks[0], ratingKey: "20" },
      { ...mockTracks[1], ratingKey: "21" },
      { ...mockTracks[0], ratingKey: "22" },
    ];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks: newTracks,
      totalSize: 3,
      offset: 0,
      hasMore: false,
    });

    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "Count Test Playlist",
      smart: false,
      leafCount: 10,
      duration: 1200000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    // Current tracks; second call = after add (re-fetch for accurate count)
    const currentTracks = Array.from({ length: 10 }, (_, i) => ({
      ...mockTracks[0],
      ratingKey: String(i + 1),
    }));
    const afterAddTracks = [...currentTracks, ...newTracks];
    mockPlex.getPlaylistTracks
      .mockResolvedValueOnce(currentTracks)
      .mockResolvedValueOnce(afterAddTracks);

    const result = await executePlaylistAdd({
      playlistName: "Count Test Playlist",
      libraryName: "Music",
      queryOptions: { genre: "Rock" } as TestQueryOptions,
    });

    expect(result.tracksAdded).toBe(3);
    expect(result.totalTracks).toBe(13); // 10 existing + 3 new
  });

  it("should handle dry-run mode", async () => {
    const tracks = [{ ...mockTracks[0], ratingKey: "30" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "Dry Run Add Test",
      smart: false,
      leafCount: 5,
      duration: 600000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    // Current tracks
    const currentTracks = Array.from({ length: 5 }, (_, i) => ({
      ...mockTracks[0],
      ratingKey: String(i + 1),
    }));
    mockPlex.getPlaylistTracks.mockResolvedValue(currentTracks);

    const result = await executePlaylistAdd({
      playlistName: "Dry Run Add Test",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      dryRun: true,
    });

    expect(result.tracksAdded).toBe(1);
    expect(result.totalTracks).toBe(6);
    // Should NOT call addTracksToPlaylist in dry-run mode
    expect(mockPlex.addTracksToPlaylist).not.toHaveBeenCalled();
    // Should log dry-run message
    expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });

  it("should throw error when filter returns no tracks", async () => {
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks: [],
      totalSize: 0,
      offset: 0,
      hasMore: false,
    });

    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "Empty Filter Test",
      smart: false,
      leafCount: 5,
      duration: 600000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    await expect(
      executePlaylistAdd({
        playlistName: "Empty Filter Test",
        libraryName: "Music",
        queryOptions: { genre: "NonexistentGenre" } as TestQueryOptions,
      }),
    ).rejects.toThrow("Filter returned no matching tracks");

    expect(mockPlex.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  it("should throw error when no filters provided", async () => {
    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "No Filter Test",
      smart: false,
      leafCount: 5,
      duration: 600000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    await expect(
      executePlaylistAdd({
        playlistName: "No Filter Test",
        libraryName: "Music",
        // No queryOptions and no filterName
      }),
    ).rejects.toThrow("No filters provided");
  });

  it("should use named filter from config", async () => {
    // Setup config with a named filter
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
      },
      plexFilters: {
        "rock-filter": {
          match: "all",
          library: "Music",
          type: "track",
          rules: [{ type: "rule", field: "genre", operator: "contains", value: "Rock" }],
        },
      },
    });

    const tracks = [{ ...mockTracks[0], ratingKey: "40" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "Rock Playlist",
      smart: false,
      leafCount: 3,
      duration: 360000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    // Current tracks; second call = after add (re-fetch)
    const currentTracks = Array.from({ length: 3 }, (_, i) => ({
      ...mockTracks[0],
      ratingKey: String(i + 1),
    }));
    const afterAddTracks = [...currentTracks, ...tracks];
    mockPlex.getPlaylistTracks
      .mockResolvedValueOnce(currentTracks)
      .mockResolvedValueOnce(afterAddTracks);

    const result = await executePlaylistAdd({
      playlistName: "Rock Playlist",
      filterName: "rock-filter",
    });

    expect(result.tracksAdded).toBe(1);
    expect(result.totalTracks).toBe(4);
    expect(mockLogger.logDebug).toHaveBeenCalledWith(
      expect.stringContaining("Loaded Plex filter: rock-filter"),
    );
  });

  it("should output JSON when requested", async () => {
    const tracks = [{ ...mockTracks[0], ratingKey: "50" }];
    mockPlex.queryPlexTracks.mockResolvedValue({
      tracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });

    // Existing playlist
    const existingPlaylist = {
      ratingKey: "100",
      title: "JSON Add Test",
      smart: false,
      leafCount: 2,
      duration: 240000,
      addedAt: 1700000000,
      updatedAt: 1700000000,
    };
    mockPlex.findPlaylistByName.mockResolvedValue(existingPlaylist);

    // Current tracks (dry-run only uses initial count for estimated total)
    const currentTracks = Array.from({ length: 2 }, (_, i) => ({
      ...mockTracks[0],
      ratingKey: String(i + 1),
    }));
    mockPlex.getPlaylistTracks.mockResolvedValue(currentTracks);

    // Action returns result only; command layer emits JSON (no console.log in action)
    const result = await executePlaylistAdd({
      playlistName: "JSON Add Test",
      libraryName: "Music",
      queryOptions: { genre: "Jazz" } as TestQueryOptions,
      dryRun: true,
      json: true,
    });

    expect(result.playlistName).toBe("JSON Add Test");
    expect(result.tracksAdded).toBe(1);
    expect(result.totalTracks).toBe(3);
  });
});
