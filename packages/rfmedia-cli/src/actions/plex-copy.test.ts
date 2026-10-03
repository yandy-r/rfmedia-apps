/**
 * Tests for plex-copy.ts - Plex-based copy action.
 *
 * Tests file copy operations based on Plex query results in both
 * query-results mode (from saved query) and query mode (execute new query).
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlexCopyAdapterMock } from "./plex-copy-adapter.mock.js";

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
}));

const mockActionHelpers = vi.hoisted(() => ({
  extractTrackFilePaths: vi.fn().mockResolvedValue({ valid: [], missing: [] }),
  resolveOptionalScanAdapter: vi.fn().mockReturnValue({
    adapter: undefined,
    scanPerSource: false,
  }),
}));

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

const mockDb = vi.hoisted(() => ({
  initializeDatabase: vi.fn().mockResolvedValue({}),
  closeDatabase: vi.fn(),
  getPlexQuery: vi.fn().mockReturnValue(null),
  getPlexQueryResults: vi.fn().mockReturnValue([]),
}));

const mockConfig = vi.hoisted(() => ({
  resolveUndoDatabasePath: vi.fn().mockReturnValue("/tmp/test.db"),
  getAllowedLibraryRoots: vi.fn().mockReturnValue([]), // Empty array = no filtering
}));

const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockResolvedValue({
    undo: { database: "/tmp/test.db" },
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      scanAfterCopy: true,
    },
  }),
}));

const mockPlexQuery = vi.hoisted(() => ({
  executePlexQuery: vi.fn().mockResolvedValue({
    tracks: [],
    totalSize: 0,
    offset: 0,
    hasMore: false,
  }),
}));

const mockRange = vi.hoisted(() => ({
  formatSuffix: vi.fn((num: number, padWidth: number) => String(num).padStart(padWidth, "0")),
  detectHighestSuffix: vi.fn().mockResolvedValue(null),
  buildAutoRange: vi.fn((count: number, highestSuffix: number, padWidth: number) => ({
    start: highestSuffix + 1,
    end: highestSuffix + count,
    padWidth,
  })),
}));

const mockTableFormat = vi.hoisted(() => ({
  formatCopySummaryTable: vi.fn().mockReturnValue("Mock Summary Table"),
}));

const mockPathInfo = vi.hoisted(() => ({
  extractPathInfo: vi.fn(
    (filePath: string, sourceDir: string, _fallback: string, _isLibraryRoot: boolean) => {
      // Extract artist/album from relative path: Artist/Album/track.ext
      // The sourceDir is the library root (3 levels up from file)
      const relativePath = path.relative(sourceDir, filePath);
      const parts = relativePath.split(path.sep);

      // For paths with Artist/Album/track structure
      if (parts.length >= 3) {
        return {
          artistName: parts[0] || "Unknown Artist",
          albumName: parts[1] || "Unknown Album",
        };
      }

      // For simple test paths without proper structure, use defaults
      return { artistName: "Artist 1", albumName: "Album 1" };
    },
  ),
}));

const mockSyncHelper = vi.hoisted(() => ({
  syncTrackRating: vi.fn().mockResolvedValue({ success: true }),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/filesystem.js", () => mockFilesystem);
vi.mock("../lib/adapters/action-helpers.js", () => mockActionHelpers);
vi.mock("../lib/convert.js", () => mockConvert);
vi.mock("../lib/parallel.js", () => mockParallel);
vi.mock("../lib/progress-bar.js", () => mockProgressBar);
vi.mock("../lib/db.js", () => mockDb);
vi.mock("../lib/config.js", () => mockConfig);
vi.mock("../lib/loaded-config.js", () => mockLoadedConfig);
vi.mock("./plex-query.js", () => mockPlexQuery);
vi.mock("../lib/range.js", () => mockRange);
vi.mock("../lib/table-format.js", () => mockTableFormat);
vi.mock("../lib/path-info.js", () => mockPathInfo);
vi.mock("../lib/sync-helper.js", () => mockSyncHelper);

// Import after mocks
import { executePlexCopy } from "./plex-copy.js";

let adapterMock = createPlexCopyAdapterMock();

function resetAdapterMock(): void {
  adapterMock = createPlexCopyAdapterMock();
  mockActionHelpers.extractTrackFilePaths.mockResolvedValue({ valid: [], missing: [] });
  mockActionHelpers.resolveOptionalScanAdapter.mockReturnValue({
    adapter: adapterMock.adapter,
    scanPerSource: false,
    libraryName: "Music",
  });
}

function mockSingleSavedCopySource(filePath = "/music/Artist 1/Album 1/track1.flac"): void {
  mockDb.getPlexQuery.mockReturnValue({
    id: 123,
    name: "Test Query",
    library_name: "Music",
    media_type: "track",
    result_count: 1,
  });
  mockDb.getPlexQueryResults.mockReturnValue([
    {
      id: 1,
      query_id: 123,
      rating_key: "1",
      media_type: "track",
      title: "Track 1",
      artist: "Artist 1",
      album: "Album 1",
      user_rating: 8,
      view_count: 10,
      year: 2024,
      file_path: filePath,
      track_count: null,
      album_count: null,
    },
  ]);
  mockActionHelpers.extractTrackFilePaths.mockResolvedValue({ valid: [filePath], missing: [] });
}

describe("executePlexCopy - Query-Results Mode", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks(); // NOT resetAllMocks!
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should copy files from saved query results", async () => {
    // Setup mocks
    const queryId = 123;
    mockDb.getPlexQuery.mockReturnValue({
      id: queryId,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 2,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: queryId,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/artist1/album1/track1.flac",
        track_count: null,
        album_count: null,
      },
      {
        id: 2,
        query_id: queryId,
        rating_key: "2",
        media_type: "track",
        title: "Track 2",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 10,
        view_count: 5,
        year: 2024,
        file_path: "/music/artist1/album1/track2.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/artist1/album1/track1.flac", "/music/artist1/album1/track2.flac"],
      missing: [],
    });

    // Execute copy (query-results mode)
    const result = await executePlexCopy({
      mode: "query-results",
      queryId,
      destination: tempDir,
      progress: false, // Disable progress in tests
    });

    // Verify result
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.totalSize).toBeGreaterThan(0);

    // Verify database calls
    expect(mockDb.getPlexQuery).toHaveBeenCalledWith({}, queryId);
    expect(mockDb.getPlexQueryResults).toHaveBeenCalledWith({}, queryId);
    expect(mockActionHelpers.extractTrackFilePaths).toHaveBeenCalledWith(
      [
        { file_path: "/music/artist1/album1/track1.flac" },
        { file_path: "/music/artist1/album1/track2.flac" },
      ],
      { validateExistence: true },
    );

    // Verify file operations
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(2);
  });

  it("should throw error when query not found", async () => {
    mockDb.getPlexQuery.mockReturnValue(null);

    await expect(
      executePlexCopy({
        mode: "query-results",
        queryId: 999,
        destination: tempDir,
        progress: false,
      }),
    ).rejects.toThrow("Query not found: 999");
  });

  it("should return early when query has no results", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Empty Query",
      library_name: "Music",
      media_type: "track",
      result_count: 0,
    });

    mockDb.getPlexQueryResults.mockReturnValue([]);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(mockLogger.logDebug).toHaveBeenCalledWith("Query has no results");
  });

  it("should warn about missing files and skip them", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 2,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
      {
        id: 2,
        query_id: 123,
        rating_key: "2",
        media_type: "track",
        title: "Track 2",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 10,
        view_count: 5,
        year: 2024,
        file_path: "/music/track2.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: ["/music/track2.flac"], // One file is missing
    });

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(1);
    expect(mockLogger.logDebug).toHaveBeenCalledWith("1 files are missing and will be skipped");
  });
});

describe("executePlexCopy - Query Mode", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should execute query and copy results", async () => {
    const mockTracks = [
      {
        ratingKey: "1",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        userRating: 8,
        viewCount: 10,
        duration: 180000,
        year: 2024,
        filePath: "/music/track1.flac",
      },
    ];

    mockPlexQuery.executePlexQuery.mockResolvedValue({
      tracks: mockTracks,
      totalSize: 1,
      offset: 0,
      hasMore: false,
      queryId: 456, // Saved query
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 456,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    const result = await executePlexCopy({
      mode: "query",
      library: "Music",
      type: "track",
      minTrackRating: 4,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(1);
    expect(mockPlexQuery.executePlexQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        library: "Music",
        type: "track",
        minTrackRating: 4,
      }),
    );
    expect(mockActionHelpers.extractTrackFilePaths).toHaveBeenCalledWith(
      [{ file_path: "/music/track1.flac" }],
      { validateExistence: true },
    );
  });

  it("should narrowly project live compatibility tracks for paths and rating sync", async () => {
    mockPlexQuery.executePlexQuery.mockResolvedValue({
      tracks: [
        {
          ratingKey: "live-track",
          title: "Live Track",
          artist: "Artist 1",
          album: "Album 1",
          userRating: 8,
          viewCount: 10,
          duration: 180000,
          filePath: "/music/Artist 1/Album 1/live.flac",
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });
    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist 1/Album 1/live.flac"],
      missing: [],
    });

    const result = await executePlexCopy({
      mode: "query",
      library: "Music",
      type: "track",
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    expect(result.created).toBe(1);
    expect(mockActionHelpers.extractTrackFilePaths).toHaveBeenCalledWith(
      [{ file_path: "/music/Artist 1/Album 1/live.flac" }],
      { validateExistence: true },
    );
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String),
      8,
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("should throw error when library is not specified", async () => {
    await expect(
      executePlexCopy({
        mode: "query",
        library: "",
        type: "track",
        destination: tempDir,
        progress: false,
      }),
    ).rejects.toThrow("Library name is required for query mode");
  });

  it("should throw error when query returns non-track results", async () => {
    mockPlexQuery.executePlexQuery.mockResolvedValue({
      albums: [], // Albums, not tracks
      totalSize: 0,
      offset: 0,
      hasMore: false,
    });

    await expect(
      executePlexCopy({
        mode: "query",
        library: "Music",
        type: "album", // This should fail
        destination: tempDir,
        progress: false,
      }),
    ).rejects.toThrow("Plex copy only supports track queries");
  });
});

describe("executePlexCopy - Optional Scan", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-scan-test-"));
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockSingleSavedCopySource();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should delegate mapped lookup and full-scan fallback to the destination-aware scan", async () => {
    adapterMock.scan.triggerSource.mockResolvedValue({
      success: true,
      message: "path scan queued",
      libraryName: "Music",
    });

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(1);
    expect(adapterMock.scan.triggerSource).toHaveBeenCalledWith(tempDir);
    expect(adapterMock.scan.trigger).not.toHaveBeenCalled();
    expect(mockLogger.logSuccess).toHaveBeenCalledWith("Plex library scan triggered: Music");
  });

  it("should warn without changing the primary copy result when scanning fails", async () => {
    adapterMock.scan.triggerSource.mockResolvedValue({
      success: false,
      message: "library lookup and fallback scan failed",
    });

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result).toMatchObject({ created: 1, skipped: 0, failed: [] });
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      "Plex scan failed: library lookup and fallback scan failed",
    );
  });

  it("should skip scanning when the optional adapter is unconfigured", async () => {
    mockActionHelpers.resolveOptionalScanAdapter.mockReturnValue({
      adapter: undefined,
      scanPerSource: false,
    });

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(1);
    expect(adapterMock.scan.triggerSource).not.toHaveBeenCalled();
    expect(mockLogger.logWarn).not.toHaveBeenCalledWith(expect.stringContaining("scan"));
  });

  it("should report scan intent without resolving an adapter during dry-run", async () => {
    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      dryRun: true,
    });

    expect(result.created).toBe(1);
    expect(mockActionHelpers.resolveOptionalScanAdapter).not.toHaveBeenCalled();
    expect(adapterMock.scan.triggerSource).not.toHaveBeenCalled();
    expect(mockLogger.logDebug).toHaveBeenCalledWith("[DRY RUN] trigger Plex scan");
  });
});

describe("executePlexCopy - Copy Options", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should use hardlinks when hardlink option is true", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    mockFilesystem.copyOrLink.mockResolvedValue("hardlink");

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      hardlink: true,
      progress: false,
    });

    expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
      "/music/track1.flac",
      expect.any(String),
      true, // hardlink = true
    );
  });

  it("should convert files when convertFormat is specified", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      convertFormat: "mp3",
      progress: false,
    });

    expect(mockConvert.convertFile).toHaveBeenCalledWith(
      "/music/track1.flac",
      expect.stringContaining(".mp3"),
      "mp3",
    );
  });

  it("should preserve artist/album structure when preserveStructure is true", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        // Path must have Artist/Album/track structure for extractPlexPathInfo
        file_path: "/music/Artist 1/Album 1/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/Artist 1/Album 1/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      preserveStructure: true,
      progress: false,
    });

    // With preserveStructure, path is: {dst}/{Artist}/{outputFolder}/{Album}/
    // extractPlexPathInfo extracts artist and album from the file path hierarchy
    expect(mockFilesystem.ensureDir).toHaveBeenCalledWith(
      expect.stringContaining(path.join("Artist 1", "plex-liked", "Album 1")),
    );
  });

  it("should skip existing files when not in force mode", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // File already exists
    mockFilesystem.pathExists.mockResolvedValue(true);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });

  it("should handle dry-run mode correctly", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      dryRun: true,
      progress: false,
    });

    expect(result.created).toBe(1);
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    expect(mockLogger.logDebug).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });

  it("should collect errors for failed file operations", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // Ensure pathExists returns false so we proceed to copy
    mockFilesystem.pathExists.mockResolvedValue(false);

    // Simulate copy failure
    const permissionError = new Error("Permission denied");
    (permissionError as NodeJS.ErrnoException).code = "EACCES";
    mockFilesystem.copyOrLink.mockRejectedValue(permissionError);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    expect(result.created).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe("/music/track1.flac");
    expect(result.failed[0]?.message).toBe("Permission denied");
    expect(result.failed[0]?.code).toBe("EACCES");
  });

  it("should skip Plex scan when disabled", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      plexScan: false,
    });

    expect(mockActionHelpers.resolveOptionalScanAdapter).not.toHaveBeenCalled();
    expect(adapterMock.scan.triggerSource).not.toHaveBeenCalled();
  });
});

describe("executePlexCopy - Range/Count Options", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-range-test-"));

    // Re-establish default mock implementations after clearAllMocks
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockRange.detectHighestSuffix.mockResolvedValue(null);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should create multiple copies when range is specified", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // Ensure files don't exist so they get copied
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      range: { start: 1, end: 3, padWidth: 3 }, // Create 3 copies
    });

    // Should create 3 copies: track1-001.flac, track1-002.flac, track1-003.flac
    expect(result.created).toBe(3);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(3);

    // Verify each copy has the correct suffix in the destination path
    const copyOrLinkCalls = mockFilesystem.copyOrLink.mock.calls;
    expect(copyOrLinkCalls[0]?.[1]).toContain("track1-001.flac");
    expect(copyOrLinkCalls[1]?.[1]).toContain("track1-002.flac");
    expect(copyOrLinkCalls[2]?.[1]).toContain("track1-003.flac");
  });

  it("should auto-detect next range when count is specified", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // Simulate existing copies at 001-003
    mockRange.detectHighestSuffix.mockResolvedValue({ highestSuffix: 3, padWidth: 3 });

    // Ensure new files don't exist so they get copied
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      count: 2, // Create 2 more copies
    });

    // Should detect highest suffix (3) and create 2 more: 004, 005
    expect(mockRange.detectHighestSuffix).toHaveBeenCalledWith(tempDir);
    expect(mockRange.buildAutoRange).toHaveBeenCalledWith(2, 3, 3);

    // Should create 2 copies
    expect(result.created).toBe(2);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(2);
  });

  it("should start from 1 when count is specified and no existing copies", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // No existing copies
    mockRange.detectHighestSuffix.mockResolvedValue(null);

    // Ensure files don't exist so they get copied
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      count: 3,
    });

    // Should build range starting from 1
    expect(mockRange.buildAutoRange).toHaveBeenCalledWith(3, 0, 3);

    // Should create 3 copies
    expect(result.created).toBe(3);
  });

  it("should create single copy without suffix when no range/count specified", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // Ensure file doesn't exist so it gets copied
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      // No range or count specified
    });

    // Should create single copy without suffix
    expect(result.created).toBe(1);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(1);

    // Verify the destination does NOT have a suffix
    const destPath = mockFilesystem.copyOrLink.mock.calls[0]?.[1] as string;
    expect(destPath).toContain("track1.flac");
    expect(destPath).not.toMatch(/-\d{3}\.flac$/);
  });

  it("should skip existing files when creating multiple copies", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // First copy exists, second and third don't
    mockFilesystem.pathExists
      .mockResolvedValueOnce(true) // track1-001.flac exists
      .mockResolvedValueOnce(false) // track1-002.flac doesn't exist
      .mockResolvedValueOnce(false); // track1-003.flac doesn't exist

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      range: { start: 1, end: 3, padWidth: 3 },
    });

    // Should skip 1, create 2
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(2);
  });

  it("should handle range with dry-run mode", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      dryRun: true,
      range: { start: 1, end: 2, padWidth: 3 },
    });

    // Should report 2 created in dry-run
    expect(result.created).toBe(2);
    // Should not actually copy
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    // Should log dry-run messages
    expect(mockLogger.logDebug).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });
});

describe("executePlexCopy - Security", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-security-test-"));

    // Re-establish default mock implementations after clearAllMocks
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should safely resolve path traversal attempts in file paths", async () => {
    // extractPlexPathInfo uses path.basename() which strips traversal components,
    // so even malicious file paths result in safe directory names
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "../../../etc",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        // Path with traversal components - extractPlexPathInfo normalizes via path.basename
        file_path: "/music/../../../etc/album1/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/../../../etc/album1/track1.flac"],
      missing: [],
    });

    // Should NOT reject - extractPlexPathInfo uses path.basename which strips traversal
    // The path /music/../../../etc/album1/track1.flac normalizes to /etc/album1/track1.flac
    // path.basename(dirname(dirname)) = "etc" (safe), path.basename(dirname) = "album1" (safe)
    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
    });

    // File should be copied safely within the destination directory
    expect(result.created).toBe(1);
    expect(result.failed).toHaveLength(0);

    // Verify the copy destination stays within tempDir
    const destPath = mockFilesystem.copyOrLink.mock.calls[0]?.[1] as string;
    expect(destPath).toBeDefined();
    expect(path.resolve(destPath).startsWith(path.resolve(tempDir))).toBe(true);
  });

  it("should reject path traversal attempts in album name", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "../../secrets", // Malicious album name
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/artist1/../../secrets/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/artist1/../../secrets/track1.flac"],
      missing: [],
    });

    // Mock extractPathInfo to return the malicious path component
    mockPathInfo.extractPathInfo.mockReturnValue({
      artistName: "Artist 1",
      albumName: "../../secrets",
    });

    await expect(
      executePlexCopy({
        mode: "query-results",
        queryId: 123,
        destination: tempDir,
        albumMode: true, // Album mode uses album name in folder path
        progress: false,
      }),
    ).rejects.toThrow("Path traversal detected");

    // Should not have attempted to copy any files
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });
});

describe("executePlexCopy - Sync-on-Copy Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAdapterMock();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-plex-copy-sync-test-"));

    // Re-establish default mock implementations after clearAllMocks
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.ensureDir.mockResolvedValue(undefined);
    mockFilesystem.copyOrLink.mockResolvedValue("copy");
    mockFilesystem.getFileSize.mockResolvedValue(1024 * 1024);
    mockSyncHelper.syncTrackRating.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should call syncTrackRating after copy when syncRatings is true", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8, // Rated track
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    // Verify syncTrackRating was called with correct parameters
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(1);
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String), // destPath
      8, // plexRating
      expect.objectContaining({
        popmEmail: "no@email",
        vorbisScale: "normalized",
        dryRun: false,
      }),
    );
  });

  it("should not call syncTrackRating when syncRatings is false (default)", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: false, // Explicitly false
    });

    // Verify syncTrackRating was NOT called
    expect(mockSyncHelper.syncTrackRating).not.toHaveBeenCalled();
  });

  it("should skip sync for unrated tracks (userRating === 0)", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 2,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 0, // Unrated
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
      {
        id: 2,
        query_id: 123,
        rating_key: "2",
        media_type: "track",
        title: "Track 2",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8, // Rated
        view_count: 5,
        year: 2024,
        file_path: "/music/track2.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac", "/music/track2.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    // Should only sync the rated track, not the unrated one
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(1);
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String),
      8, // Only the rated track
      expect.any(Object),
    );
  });

  it("should not fail copy operation when sync fails", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    // Make sync fail
    mockSyncHelper.syncTrackRating.mockResolvedValue({
      success: false,
      message: "Write failed: permission denied",
    });

    // Copy should still succeed
    const result = await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
    });

    // Copy should succeed despite sync failure
    expect(result.created).toBe(1);
    expect(result.failed).toHaveLength(0);

    // Sync was attempted
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(1);

    // Debug log should be called about the failure
    expect(mockLogger.logDebug).toHaveBeenCalledWith(expect.stringContaining("Rating sync failed"));
  });

  it("should warn when syncRatings is true with hardlink mode", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    mockFilesystem.copyOrLink.mockResolvedValue("hardlink");

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
      hardlink: true,
    });

    // Should log warning about hardlink + syncRatings
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      "Warning: syncRatings with hardlink mode modifies source files",
    );
  });

  it("should log sync intent in dry-run mode", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
      dryRun: true,
    });

    // syncTrackRating should be called with dryRun: true
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String),
      8,
      expect.objectContaining({
        dryRun: true,
      }),
    );
  });

  it("should pass custom popmEmail and vorbisScale options", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
      popmEmail: "custom@example.com",
      vorbisScale: "stars",
    });

    // Verify custom options were passed
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledWith(
      expect.any(String),
      8,
      expect.objectContaining({
        popmEmail: "custom@example.com",
        vorbisScale: "stars",
      }),
    );
  });

  it("should only sync rating on first copy when using range mode", async () => {
    mockDb.getPlexQuery.mockReturnValue({
      id: 123,
      name: "Test Query",
      library_name: "Music",
      media_type: "track",
      result_count: 1,
    });

    mockDb.getPlexQueryResults.mockReturnValue([
      {
        id: 1,
        query_id: 123,
        rating_key: "1",
        media_type: "track",
        title: "Track 1",
        artist: "Artist 1",
        album: "Album 1",
        user_rating: 8,
        view_count: 10,
        year: 2024,
        file_path: "/music/track1.flac",
        track_count: null,
        album_count: null,
      },
    ]);

    mockActionHelpers.extractTrackFilePaths.mockResolvedValue({
      valid: ["/music/track1.flac"],
      missing: [],
    });

    await executePlexCopy({
      mode: "query-results",
      queryId: 123,
      destination: tempDir,
      progress: false,
      syncRatings: true,
      range: { start: 1, end: 3, padWidth: 3 }, // 3 copies
    });

    // Copy should create 3 copies
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(3);

    // But sync should only be called once (on first copy only)
    expect(mockSyncHelper.syncTrackRating).toHaveBeenCalledTimes(1);
  });
});
