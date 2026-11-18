/**
 * Tests for playlist.ts - Smart playlist action handlers.
 *
 * Tests playlist creation from filters and Plex playlists, update, list,
 * show, and delete operations with proper mock setup.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";
import {
  createMediaPlaylistFixture,
  createMediaTrackFixture,
} from "./test-helpers/media-server-fixtures.js";

// Mock definitions with vi.hoisted() - must be defined before vi.mock() calls
const mockLogger = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  formatDryRun: vi.fn((msg: string) => `[DRY RUN] ${msg}`),
  isJsonMode: vi.fn().mockReturnValue(false),
  outputJson: vi.fn(),
}));

const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(false), // Default: file does not exist
  ensureDir: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}));

const mockAudio = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
}));

const mockMetadata = vi.hoisted(() => ({
  readExtendedMetadata: vi.fn().mockResolvedValue(null),
}));

const mockRatings = vi.hoisted(() => ({
  evaluateSmartFilter: vi.fn().mockReturnValue(true),
}));

const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    filters: {},
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      allowedLibraryRoots: ["/music"],
    },
  }),
}));

const mockParallel = vi.hoisted(() => ({
  processInParallel: vi.fn(
    async (items: unknown[], fn: (item: unknown) => Promise<unknown>, _options: unknown) => {
      // Process sequentially in tests for predictability
      const results: Array<{ success: boolean; value: unknown; index: number; error?: Error }> = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const value = await fn(items[i]);
          results.push({ success: true, value, index: i });
        } catch (error) {
          results.push({ success: false, value: undefined, index: i, error: error as Error });
        }
      }
      return results;
    },
  ),
  getDefaultWorkers: vi.fn().mockReturnValue(4),
}));

const mockM3u = vi.hoisted(() => ({
  writeM3UPlaylist: vi.fn().mockResolvedValue({
    success: true,
    trackCount: 0,
    outputPath: "",
  }),
}));

const mockPlex = vi.hoisted(() => ({
  findPlaylistByName: vi.fn().mockResolvedValue({
    id: "123",
    title: "Test Plex Playlist",
    smart: false,
    itemCount: 2,
    durationMs: 300000,
    createdAt: 1700000000,
    updatedAt: 1700000000,
  }),
  getPlaylistTracks: vi.fn().mockResolvedValue([]),
  getTrackFilePaths: vi.fn().mockResolvedValue({ valid: [], missing: [] }),
}));

const mockResolveRequiredMediaServerAdapter = vi.hoisted(() => vi.fn());

const mockDb = vi.hoisted(() => ({
  initializeDatabase: vi.fn().mockResolvedValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
  }),
  createSmartPlaylist: vi.fn().mockReturnValue(1),
  getSmartPlaylist: vi.fn().mockReturnValue(null),
  listSmartPlaylists: vi.fn().mockReturnValue([]),
  updateSmartPlaylist: vi.fn(),
  deleteSmartPlaylist: vi.fn().mockReturnValue(true),
  recordPlaylistHistory: vi.fn(),
  getSmartPlaylistHistory: vi.fn().mockReturnValue([]),
}));

const mockPrompt = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const mockCommon = vi.hoisted(() => ({
  isMachineFormat: vi.fn().mockReturnValue(false),
  getOutputFormat: vi.fn().mockReturnValue("text" as const),
}));

const mockFormatters = vi.hoisted(() => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("@rfmedia/common", () => mockCommon);
vi.mock("../lib/formatters/index.js", () => mockFormatters);
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/filesystem.js", () => mockFilesystem);
vi.mock("../lib/audio.js", () => mockAudio);
vi.mock("../lib/metadata.js", () => mockMetadata);
vi.mock("../lib/ratings.js", () => mockRatings);
vi.mock("../lib/loaded-config.js", () => mockLoadedConfig);
vi.mock("../lib/parallel.js", () => mockParallel);
vi.mock("../lib/m3u.js", () => mockM3u);
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockResolveRequiredMediaServerAdapter,
  extractTrackFilePaths: mockPlex.getTrackFilePaths,
}));
vi.mock("../lib/db.js", () => ({
  initializeDatabase: mockDb.initializeDatabase,
  createSmartPlaylist: mockDb.createSmartPlaylist,
  getSmartPlaylist: mockDb.getSmartPlaylist,
  listSmartPlaylists: mockDb.listSmartPlaylists,
  updateSmartPlaylist: mockDb.updateSmartPlaylist,
  deleteSmartPlaylist: mockDb.deleteSmartPlaylist,
  recordPlaylistHistory: mockDb.recordPlaylistHistory,
  getSmartPlaylistHistory: mockDb.getSmartPlaylistHistory,
}));
vi.mock("../lib/prompt.js", () => mockPrompt);

// Import after mocks
import {
  executePlaylistCreate,
  executePlaylistUpdate,
  listSmartPlaylists,
  showSmartPlaylist,
  deleteSmartPlaylist,
} from "./playlist.js";

function createMockMediaServerAdapter() {
  return createMediaServerAdapterMock({
    playlist: {
      byName: mockPlex.findPlaylistByName,
      tracks: mockPlex.getPlaylistTracks,
    },
  }).adapter;
}

// Test data
const mockFilter = {
  type: "group" as const,
  match: "all" as const,
  rules: [{ type: "rule" as const, field: "rating" as const, operator: ">=" as const, value: 0.8 }],
};

const mockMetadataResult = {
  format: { duration: 180 },
  common: {
    title: "Test Track",
    artist: "Test Artist",
    album: "Test Album",
  },
};

const mockPlexTracks = [
  createMediaTrackFixture({
    id: "1",
    title: "Plex Track 1",
    artist: "Plex Artist",
    album: "Plex Album",
    durationMs: 180000,
    filePath: "/music/plex-track1.flac",
    rating: 0.8,
    playCount: 10,
  }),
  createMediaTrackFixture({
    id: "2",
    title: "Plex Track 2",
    artist: "Plex Artist",
    album: "Plex Album",
    durationMs: 200000,
    filePath: "/music/plex-track2.flac",
    rating: 1,
    playCount: 5,
  }),
];

// =============================================================================
// Helper to reset all mocks to default state
// =============================================================================

function resetMocksToDefaults() {
  vi.clearAllMocks(); // NOT resetAllMocks!
  mockResolveRequiredMediaServerAdapter.mockReturnValue(createMockMediaServerAdapter());

  // Reset config
  mockLoadedConfig.getLoadedConfig.mockReturnValue({
    filters: {},
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      allowedLibraryRoots: ["/music"],
    },
  });

  // Reset filesystem - default to file not existing
  mockFilesystem.pathExists.mockResolvedValue(false);
  mockFilesystem.ensureDir.mockResolvedValue(undefined);
  mockFilesystem.remove.mockResolvedValue(undefined);

  // Reset audio
  mockAudio.findAudioFiles.mockResolvedValue([]);

  // Reset metadata
  mockMetadata.readExtendedMetadata.mockResolvedValue(null);

  // Reset ratings
  mockRatings.evaluateSmartFilter.mockReturnValue(true);

  // Reset parallel
  mockParallel.getDefaultWorkers.mockReturnValue(4);

  // Reset M3U
  mockM3u.writeM3UPlaylist.mockResolvedValue({
    success: true,
    trackCount: 0,
    outputPath: "",
  });

  // Reset Plex
  mockPlex.findPlaylistByName.mockResolvedValue(
    createMediaPlaylistFixture({
      id: "123",
      title: "Test Plex Playlist",
      itemCount: 2,
      durationMs: 300000,
      createdAt: 1700000000,
      updatedAt: 1700000000,
    }),
  );
  mockPlex.getPlaylistTracks.mockResolvedValue([]);
  mockPlex.getTrackFilePaths.mockResolvedValue({ valid: [], missing: [] });

  // Reset database
  mockDb.initializeDatabase.mockResolvedValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
  });
  mockDb.createSmartPlaylist.mockReturnValue(1);
  mockDb.getSmartPlaylist.mockReturnValue(null);
  mockDb.listSmartPlaylists.mockReturnValue([]);
  mockDb.updateSmartPlaylist.mockImplementation(() => {});
  mockDb.deleteSmartPlaylist.mockReturnValue(true);
  mockDb.recordPlaylistHistory.mockImplementation(() => {});
  mockDb.getSmartPlaylistHistory.mockReturnValue([]);

  // Reset prompt
  mockPrompt.confirm.mockResolvedValue(true);

  // Reset logger
  mockLogger.isJsonMode.mockReturnValue(false);

  // Reset format-aware output mocks
  mockCommon.isMachineFormat.mockReturnValue(false);
  mockCommon.getOutputFormat.mockReturnValue("text" as const);
  mockFormatters.formatOutput.mockResolvedValue(undefined);
}

// =============================================================================
// executePlaylistCreate Tests - Filter Source
// =============================================================================

describe("executePlaylistCreate - Filter Source", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetMocksToDefaults();
    tempDir = await mkdtemp(path.join(tmpdir(), "playlist-filter-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should create playlist from filter with matching tracks", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Library path exists, output file does not
    mockFilesystem.pathExists.mockImplementation(async (p: string) => {
      if (p === "/music") return true;
      return false; // Output file doesn't exist
    });

    mockAudio.findAudioFiles.mockResolvedValue(["/music/track1.flac", "/music/track2.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(true);
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 2,
      outputPath: path.join(tempDir, "test.m3u8"),
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Test Playlist",
      output: path.join(tempDir, "test.m3u8"),
      filter: "favorites",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(2);
    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalledTimes(1);
    expect(mockDb.createSmartPlaylist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "Test Playlist",
        sourceType: "filter",
        sourceName: "favorites",
      }),
    );
    expect(mockDb.recordPlaylistHistory).toHaveBeenCalled();
  });

  it("should sequence matched tracks before writing and recording history", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: {
        radio: {
          ...mockFilter,
          separation: { artist: 1 },
        },
      },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });
    mockFilesystem.pathExists.mockImplementation(async (filePath: string) => filePath === "/music");
    mockAudio.findAudioFiles.mockResolvedValue([
      "/music/a1.flac",
      "/music/a2.flac",
      "/music/b1.flac",
      "/music/b2.flac",
    ]);
    mockMetadata.readExtendedMetadata.mockImplementation(async (filePath: string) => ({
      format: { duration: 180 },
      common: {
        title: path.basename(filePath),
        artist: filePath.includes("/a") ? "Artist A" : "Artist B",
      },
    }));

    await executePlaylistCreate({
      name: "Radio",
      output: path.join(tempDir, "radio.m3u8"),
      filter: "radio",
    });

    const expectedOrder = ["/music/a1.flac", "/music/b1.flac", "/music/a2.flac", "/music/b2.flac"];
    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: expectedOrder.map((filePath) =>
          expect.objectContaining({
            filePath,
          }),
        ),
      }),
    );
    expect(mockDb.recordPlaylistHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expectedOrder.map((filePath) => expect.objectContaining({ filePath })),
    );
  });

  it("should retain lexical path order when the filter has no separation policy", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });
    mockFilesystem.pathExists.mockImplementation(async (filePath: string) => filePath === "/music");
    mockAudio.findAudioFiles.mockResolvedValue(["/music/z.flac", "/music/a.flac", "/music/m.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);

    await executePlaylistCreate({
      name: "Lexical",
      output: path.join(tempDir, "lexical.m3u8"),
      filter: "favorites",
    });

    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: ["/music/a.flac", "/music/m.flac", "/music/z.flac"].map((filePath) =>
          expect.objectContaining({ filePath }),
        ),
      }),
    );
  });

  it("should handle filter with no matching tracks", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Library path exists, output file does not
    mockFilesystem.pathExists.mockImplementation(async (p: string) => {
      if (p === "/music") return true;
      return false;
    });

    mockAudio.findAudioFiles.mockResolvedValue(["/music/track1.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(false); // No matches

    // Act
    const result = await executePlaylistCreate({
      name: "Empty Playlist",
      output: path.join(tempDir, "empty.m3u8"),
      filter: "favorites",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(0);
    expect(mockM3u.writeM3UPlaylist).not.toHaveBeenCalled();
    expect(mockLogger.logWarn).toHaveBeenCalledWith("No tracks matched the filter criteria.");
  });

  it("should throw error when filter not found in config", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { "existing-filter": mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Act & Assert
    await expect(
      executePlaylistCreate({
        name: "Test Playlist",
        output: path.join(tempDir, "test.m3u8"),
        filter: "nonexistent-filter",
      }),
    ).rejects.toThrow('Filter "nonexistent-filter" not found');
  });

  it("should respect dry-run mode (no file written)", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Library path exists
    mockFilesystem.pathExists.mockImplementation(async (p: string) => {
      if (p === "/music") return true;
      return false;
    });

    mockAudio.findAudioFiles.mockResolvedValue(["/music/track1.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(true);

    // Act
    const result = await executePlaylistCreate({
      name: "Dry Run Playlist",
      output: path.join(tempDir, "dryrun.m3u8"),
      filter: "favorites",
      dryRun: true,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(1);
    expect(mockM3u.writeM3UPlaylist).not.toHaveBeenCalled();
    expect(mockDb.createSmartPlaylist).not.toHaveBeenCalled();
    // Dry-run output now goes through printDryRunTrackPreview (console.error), not logInfo
  });

  it("should throw error when output file exists without force flag", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });
    // Mock that output file exists
    mockFilesystem.pathExists.mockResolvedValue(true);

    const outputPath = path.join(tempDir, "existing.m3u8");

    // Act & Assert
    await expect(
      executePlaylistCreate({
        name: "Test Playlist",
        output: outputPath,
        filter: "favorites",
      }),
    ).rejects.toThrow("Output file already exists");
  });

  it("should overwrite existing file with force flag", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Mock that library path exists and output file exists
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockAudio.findAudioFiles.mockResolvedValue(["/music/track1.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(true);
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 1,
      outputPath: path.join(tempDir, "force.m3u8"),
    });

    const outputPath = path.join(tempDir, "force.m3u8");

    // Act - force flag should bypass the existence check
    const result = await executePlaylistCreate({
      name: "Force Playlist",
      output: outputPath,
      filter: "favorites",
      force: true,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalled();
  });

  it("should handle relative path output", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Library path exists
    mockFilesystem.pathExists.mockImplementation(async (p: string) => {
      if (p === "/music") return true;
      return false;
    });

    mockAudio.findAudioFiles.mockResolvedValue(["/music/track1.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(true);
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 1,
      outputPath: path.join(tempDir, "relative.m3u8"),
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Relative Playlist",
      output: path.join(tempDir, "relative.m3u8"),
      filter: "favorites",
      relative: true,
      baseDir: "/music",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePaths: true,
        baseDir: "/music",
      }),
    );
  });

  it("should collect failed metadata reads without stopping", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Library path exists
    mockFilesystem.pathExists.mockImplementation(async (p: string) => {
      if (p === "/music") return true;
      return false;
    });

    mockAudio.findAudioFiles.mockResolvedValue([
      "/music/track1.flac",
      "/music/track2.flac",
      "/music/track3.flac",
    ]);

    // First track succeeds, second fails, third succeeds
    mockMetadata.readExtendedMetadata
      .mockResolvedValueOnce(mockMetadataResult)
      .mockResolvedValueOnce(null) // Fails to read metadata
      .mockResolvedValueOnce(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(true);
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 2,
      outputPath: path.join(tempDir, "partial.m3u8"),
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Partial Playlist",
      output: path.join(tempDir, "partial.m3u8"),
      filter: "favorites",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(2);
    // Track with failed metadata should be skipped but operation continues
    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalled();
  });

  it("should throw error when neither filter nor plexPlaylist is specified", async () => {
    // Act & Assert
    await expect(
      executePlaylistCreate({
        name: "Test Playlist",
        output: path.join(tempDir, "test.m3u8"),
        // Neither filter nor plexPlaylist provided
      }),
    ).rejects.toThrow("Either --filter or --plex-playlist must be specified");
  });

  it("should handle missing library paths configuration", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        // No allowedLibraryRoots
      },
    });

    // Also unset the environment variable
    const originalEnv = process.env["RFMEDIA_PLEX_LIBRARY_ROOTS"];
    delete process.env["RFMEDIA_PLEX_LIBRARY_ROOTS"];

    // Act & Assert
    await expect(
      executePlaylistCreate({
        name: "Test Playlist",
        output: path.join(tempDir, "test.m3u8"),
        filter: "favorites",
      }),
    ).rejects.toThrow("No library paths configured");

    // Restore environment variable if it was set
    if (originalEnv) {
      process.env["RFMEDIA_PLEX_LIBRARY_ROOTS"] = originalEnv;
    }
  });

  it("should update existing playlist when name already exists", async () => {
    // Arrange
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: { favorites: mockFilter },
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        allowedLibraryRoots: ["/music"],
      },
    });

    // Mock that library paths exist but output file check is bypassed by force
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockAudio.findAudioFiles.mockResolvedValue(["/music/track1.flac"]);
    mockMetadata.readExtendedMetadata.mockResolvedValue(mockMetadataResult);
    mockRatings.evaluateSmartFilter.mockReturnValue(true);
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 1,
      outputPath: path.join(tempDir, "existing.m3u8"),
    });

    // Simulate existing playlist in database
    mockDb.getSmartPlaylist.mockReturnValue({
      id: 42,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      name: "Existing Playlist",
      output_path: path.join(tempDir, "existing.m3u8"),
      source_type: "filter",
      source_name: "favorites",
      relative_paths: 0,
      track_count: 5,
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Existing Playlist",
      output: path.join(tempDir, "existing.m3u8"),
      filter: "favorites",
      force: true,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(mockDb.updateSmartPlaylist).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ trackCount: 1 }),
    );
    expect(mockDb.createSmartPlaylist).not.toHaveBeenCalled();
  });
});

// =============================================================================
// executePlaylistCreate Tests - Plex Playlist Source
// =============================================================================

describe("executePlaylistCreate - Plex Playlist Source", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetMocksToDefaults();
    tempDir = await mkdtemp(path.join(tmpdir(), "playlist-plex-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should create playlist from Plex playlist source", async () => {
    // Arrange
    mockPlex.getPlaylistTracks.mockResolvedValue(mockPlexTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/plex-track1.flac", "/music/plex-track2.flac"],
      missing: [],
    });
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 2,
      outputPath: path.join(tempDir, "plex.m3u8"),
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Plex Favorites",
      output: path.join(tempDir, "plex.m3u8"),
      plexPlaylist: "Test Plex Playlist",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(2);
    expect(mockPlex.findPlaylistByName).toHaveBeenCalledWith("Test Plex Playlist");
    expect(mockPlex.getPlaylistTracks).toHaveBeenCalledWith("123");
    expect(mockM3u.writeM3UPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: [
          expect.objectContaining({
            filePath: "/music/plex-track1.flac",
            durationMs: 180000,
          }),
          expect.objectContaining({
            filePath: "/music/plex-track2.flac",
            durationMs: 200000,
          }),
        ],
      }),
    );
    expect(mockDb.createSmartPlaylist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "Plex Favorites",
        sourceType: "plex-playlist",
        sourceName: "Test Plex Playlist",
      }),
    );
  });

  it("should throw error when Plex playlist not found", async () => {
    // Arrange
    mockPlex.findPlaylistByName.mockRejectedValue(new Error('Playlist "Nonexistent" not found'));

    // Act & Assert
    await expect(
      executePlaylistCreate({
        name: "Test Playlist",
        output: path.join(tempDir, "test.m3u8"),
        plexPlaylist: "Nonexistent",
      }),
    ).rejects.toThrow('Playlist "Nonexistent" not found');
  });

  it("should handle Plex playlist with missing file paths", async () => {
    // Arrange
    mockPlex.getPlaylistTracks.mockResolvedValue(mockPlexTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/plex-track1.flac"],
      missing: ["/music/plex-track2.flac"], // One file missing
    });
    mockM3u.writeM3UPlaylist.mockResolvedValue({
      success: true,
      trackCount: 1,
      outputPath: path.join(tempDir, "partial.m3u8"),
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Partial Plex Playlist",
      output: path.join(tempDir, "partial.m3u8"),
      plexPlaylist: "Test Plex Playlist",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("unresolvable file paths"),
    );
  });

  it("should handle empty Plex playlist", async () => {
    // Arrange
    mockPlex.findPlaylistByName.mockResolvedValue(
      createMediaPlaylistFixture({
        id: "456",
        title: "Empty Plex Playlist",
        itemCount: 0,
        durationMs: 0,
      }),
    );
    mockPlex.getPlaylistTracks.mockResolvedValue([]);

    // Act
    const result = await executePlaylistCreate({
      name: "Empty Plex Playlist",
      output: path.join(tempDir, "empty.m3u8"),
      plexPlaylist: "Empty Plex Playlist",
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(0);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(expect.stringContaining("has no tracks"));
  });

  it("should throw error when Plex configuration is missing", async () => {
    mockResolveRequiredMediaServerAdapter.mockImplementationOnce(() => {
      throw new Error(
        "Plex configuration is missing. Set plex.url and plex.token in your config file.",
      );
    });

    // Act & Assert
    await expect(
      executePlaylistCreate({
        name: "Test Playlist",
        output: path.join(tempDir, "test.m3u8"),
        plexPlaylist: "Test Playlist",
      }),
    ).rejects.toThrow("Plex configuration is missing");
  });

  it("should respect dry-run mode for Plex playlist source", async () => {
    // Arrange
    mockPlex.getPlaylistTracks.mockResolvedValue(mockPlexTracks);
    mockPlex.getTrackFilePaths.mockResolvedValue({
      valid: ["/music/plex-track1.flac", "/music/plex-track2.flac"],
      missing: [],
    });

    // Act
    const result = await executePlaylistCreate({
      name: "Dry Run Plex Playlist",
      output: path.join(tempDir, "dryrun.m3u8"),
      plexPlaylist: "Test Plex Playlist",
      dryRun: true,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.trackCount).toBe(2);
    expect(mockM3u.writeM3UPlaylist).not.toHaveBeenCalled();
    expect(mockDb.createSmartPlaylist).not.toHaveBeenCalled();
  });
});

// =============================================================================
// executePlaylistUpdate Tests
// =============================================================================

describe("executePlaylistUpdate", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should throw error when neither name nor --all is provided", async () => {
    // Act & Assert
    await expect(executePlaylistUpdate({})).rejects.toThrow(
      "Either a playlist name or --all must be specified",
    );
  });

  it("should throw error when playlist name not found", async () => {
    // Arrange
    mockDb.getSmartPlaylist.mockReturnValue(null);

    // Act & Assert
    await expect(executePlaylistUpdate({ name: "Nonexistent Playlist" })).rejects.toThrow(
      'Playlist "Nonexistent Playlist" not found',
    );
  });

  it("should return early when --all is used but no playlists exist", async () => {
    // Arrange
    mockDb.listSmartPlaylists.mockReturnValue([]);

    // Act
    const result = await executePlaylistUpdate({ all: true });

    // Assert
    expect(result.updated).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(mockLogger.logWarn).toHaveBeenCalledWith("No playlists found in database.");
  });
});

// =============================================================================
// listSmartPlaylists Tests
// =============================================================================

describe("listSmartPlaylists", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should return empty array when no playlists exist", async () => {
    // Arrange
    mockDb.listSmartPlaylists.mockReturnValue([]);

    // Act
    const result = await listSmartPlaylists({});

    // Assert
    expect(result).toHaveLength(0);
    // listSmartPlaylists now returns data only; formatting is handled by the command layer
  });

  it("should return all playlists", async () => {
    // Arrange
    const mockPlaylists = [
      {
        id: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-15T00:00:00Z",
        name: "Playlist One",
        output_path: "/playlists/one.m3u8",
        source_type: "filter" as const,
        source_name: "favorites",
        relative_paths: 0,
        track_count: 50,
      },
      {
        id: 2,
        created_at: "2024-01-02T00:00:00Z",
        updated_at: "2024-01-16T00:00:00Z",
        name: "Playlist Two",
        output_path: "/playlists/two.m3u8",
        source_type: "plex-playlist" as const,
        source_name: "My Plex Playlist",
        relative_paths: 1,
        track_count: 25,
      },
    ];
    mockDb.listSmartPlaylists.mockReturnValue(mockPlaylists);

    // Act
    const result = await listSmartPlaylists({});

    // Assert
    expect(result).toHaveLength(2);
    // listSmartPlaylists now returns data only; formatting is handled by the command layer
  });

  it("should return playlists for JSON format handling by command layer", async () => {
    // Arrange
    const mockPlaylists = [
      {
        id: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-15T00:00:00Z",
        name: "Playlist One",
        output_path: "/playlists/one.m3u8",
        source_type: "filter" as const,
        source_name: "favorites",
        relative_paths: 0,
        track_count: 50,
      },
    ];
    mockDb.listSmartPlaylists.mockReturnValue(mockPlaylists);

    // Act
    const result = await listSmartPlaylists({ json: true });

    // Assert - listSmartPlaylists returns data; JSON formatting is handled by the command layer
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Playlist One");
  });
});

// =============================================================================
// showSmartPlaylist Tests
// =============================================================================

describe("showSmartPlaylist", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should throw error when playlist not found", async () => {
    // Arrange
    mockDb.getSmartPlaylist.mockReturnValue(null);

    // Act & Assert
    await expect(showSmartPlaylist("Nonexistent", {})).rejects.toThrow(
      'Playlist "Nonexistent" not found',
    );
  });

  it("should return playlist details with history", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };
    const mockHistory = [
      { id: 1, playlist_id: 1, generated_at: "2024-01-15T00:00:00Z", track_count: 50 },
      { id: 2, playlist_id: 1, generated_at: "2024-01-10T00:00:00Z", track_count: 45 },
    ];

    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);
    mockDb.getSmartPlaylistHistory.mockReturnValue(mockHistory);

    // Act
    const result = await showSmartPlaylist("Test Playlist", {});

    // Assert
    expect(result.playlist).toEqual(mockPlaylist);
    expect(result.history).toHaveLength(2);
    // Console formatting is now handled by the command layer, not the action
  });

  it("should output JSON format when requested", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };

    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);
    mockDb.getSmartPlaylistHistory.mockReturnValue([]);
    mockCommon.isMachineFormat.mockReturnValue(true);
    mockCommon.getOutputFormat.mockReturnValue("json" as const);

    // Act
    await showSmartPlaylist("Test Playlist", { json: true });

    // Assert
    expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        command: "playlist show",
        result: expect.objectContaining({
          name: "Test Playlist",
        }),
      }),
    );
  });
});

// =============================================================================
// deleteSmartPlaylist Tests
// =============================================================================

describe("deleteSmartPlaylist", () => {
  beforeEach(() => {
    resetMocksToDefaults();
  });

  it("should throw error when playlist not found", async () => {
    // Arrange
    mockDb.getSmartPlaylist.mockReturnValue(null);

    // Act & Assert
    await expect(deleteSmartPlaylist("Nonexistent", {})).rejects.toThrow(
      'Playlist "Nonexistent" not found',
    );
  });

  it("should cancel deletion when user declines confirmation", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };
    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);
    mockPrompt.confirm.mockResolvedValue(false);

    // Act
    await deleteSmartPlaylist("Test Playlist", {});

    // Assert
    expect(mockDb.deleteSmartPlaylist).not.toHaveBeenCalled();
    expect(mockLogger.logInfo).toHaveBeenCalledWith("Deletion cancelled.");
  });

  it("should delete playlist when user confirms", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };
    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);
    mockPrompt.confirm.mockResolvedValue(true);

    // Act
    await deleteSmartPlaylist("Test Playlist", {});

    // Assert
    expect(mockDb.deleteSmartPlaylist).toHaveBeenCalledWith(expect.anything(), 1);
    expect(mockLogger.logSuccess).toHaveBeenCalledWith(
      expect.stringContaining('Deleted playlist "Test Playlist"'),
    );
  });

  it("should skip confirmation with force flag", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };
    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);

    // Act
    await deleteSmartPlaylist("Test Playlist", { force: true });

    // Assert
    expect(mockPrompt.confirm).not.toHaveBeenCalled();
    expect(mockDb.deleteSmartPlaylist).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("should also delete M3U file when deleteFile option is set", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };
    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);
    mockFilesystem.pathExists.mockResolvedValue(true);

    // Act
    await deleteSmartPlaylist("Test Playlist", { force: true, deleteFile: true });

    // Assert
    expect(mockFilesystem.remove).toHaveBeenCalledWith("/playlists/test.m3u8");
    expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("Deleted M3U file"));
  });

  it("should warn when M3U file not found for deletion", async () => {
    // Arrange
    const mockPlaylist = {
      id: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
      name: "Test Playlist",
      output_path: "/playlists/test.m3u8",
      source_type: "filter" as const,
      source_name: "favorites",
      relative_paths: 0,
      track_count: 50,
    };
    mockDb.getSmartPlaylist.mockReturnValue(mockPlaylist);
    mockFilesystem.pathExists.mockResolvedValue(false);

    // Act
    await deleteSmartPlaylist("Test Playlist", { force: true, deleteFile: true });

    // Assert
    expect(mockFilesystem.remove).not.toHaveBeenCalled();
    expect(mockLogger.logWarn).toHaveBeenCalledWith(expect.stringContaining("M3U file not found"));
  });
});
