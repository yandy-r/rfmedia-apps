/**
 * Tests for plex-sync.ts - Plex metadata sync action handlers.
 *
 * Tests rating synchronization between local files and Plex Media Server
 * in push, pull, and bidirectional modes with proper mock setup.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaPage, MediaTrack } from "../types/media-server.js";
import { createPlexSyncAdapterMock } from "./plex-sync-adapter.mock.js";

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

const mockAdapter = vi.hoisted(() => ({
  queryTracks: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    returned: 0,
    hasMore: false,
  }),
  updateTrackRating: vi.fn().mockResolvedValue({
    success: true,
    message: "Rating updated",
  }),
}));

const mockResolveRequiredMediaServerAdapter = vi.hoisted(() => vi.fn());

const mockRatings = vi.hoisted(() => ({
  readRating: vi.fn().mockResolvedValue(null),
}));

const mockTagWriter = vi.hoisted(() => ({
  writeRating: vi.fn().mockResolvedValue({
    success: true,
    message: "Rating written",
    format: "flac",
  }),
}));

const mockAudio = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
}));

const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(true),
}));

const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    plex: {
      url: "http://localhost:32400",
      token: "test-token",
      syncDefaults: {
        popmEmail: "no@email",
        vorbisScale: "normalized",
      },
    },
    copy: {
      workers: 4,
      progress: true,
    },
  }),
}));

const mockParallel = vi.hoisted(() => ({
  processInParallel: vi.fn(
    async <T, R>(
      items: T[],
      fn: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
      _options?: { workers?: number; onProgress?: (completed: number, total: number) => void },
    ) => {
      // Process sequentially in tests for predictability
      const results: Array<{ success: boolean; value?: R; error?: Error; index: number }> = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === undefined) continue;
        try {
          const value = await fn(item, i, undefined);
          results.push({ success: true, value, index: i });
        } catch (error) {
          results.push({
            success: false,
            error: error instanceof Error ? error : new Error(String(error)),
            index: i,
          });
        }
      }
      return results;
    },
  ),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockResolveRequiredMediaServerAdapter,
}));
vi.mock("../lib/ratings.js", () => mockRatings);
vi.mock("../lib/tag-writer.js", () => mockTagWriter);
vi.mock("../lib/audio.js", () => mockAudio);
vi.mock("../lib/filesystem.js", () => mockFilesystem);
vi.mock("../lib/loaded-config.js", () => mockLoadedConfig);
vi.mock("../lib/parallel.js", () => mockParallel);

// Import after mocks
import { executeMetadataSync } from "./plex-sync.js";

const syncAdapterMock = createPlexSyncAdapterMock();

// Test data
const createMockTrack = (
  overrides: Partial<{
    id: string;
    title: string;
    artist: string;
    album: string;
    rating: number | null;
    playCount: number;
    durationMs: number;
    filePath: string;
  }> = {},
): MediaTrack => ({
  id: "123",
  kind: "track",
  title: "Test Track",
  artist: "Test Artist",
  album: "Test Album",
  rating: null,
  playCount: 10,
  durationMs: 180000,
  filePath: "/music/test.flac",
  ...overrides,
});

function createTrackPage(
  items: readonly MediaTrack[],
  overrides: Partial<MediaPage<MediaTrack>> = {},
): MediaPage<MediaTrack> {
  return {
    items,
    total: items.length,
    offset: 0,
    returned: items.length,
    hasMore: false,
    ...overrides,
  };
}

describe("executeMetadataSync", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Clear mocks but preserve implementations
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-sync-test-"));
    mockResolveRequiredMediaServerAdapter.mockReturnValue(syncAdapterMock.adapter);

    // Re-establish default mock implementations after clearAllMocks
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      plex: {
        url: "http://localhost:32400",
        token: "test-token",
        syncDefaults: {
          popmEmail: "no@email",
          vorbisScale: "normalized",
        },
      },
      copy: {
        workers: 4,
        progress: true,
      },
    });

    syncAdapterMock.queryTracks.mockImplementation((options) => mockAdapter.queryTracks(options));
    syncAdapterMock.updateTrackRating.mockImplementation((trackId, rating) =>
      mockAdapter.updateTrackRating(trackId, rating),
    );
    mockAdapter.queryTracks.mockResolvedValue(createTrackPage([]));
    mockAdapter.updateTrackRating.mockResolvedValue({
      success: true,
      message: "Rating updated",
    });

    mockRatings.readRating.mockResolvedValue(null);

    mockTagWriter.writeRating.mockResolvedValue({
      success: true,
      message: "Rating written",
      format: "flac",
    });

    mockAudio.findAudioFiles.mockResolvedValue([]);
    mockFilesystem.pathExists.mockResolvedValue(true);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("push mode", () => {
    it("should push file ratings to Plex", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.totalTracks).toBe(1);
      expect(result.synced).toBe(1);
      expect(mockAdapter.updateTrackRating).toHaveBeenCalledWith("123", 0.8);
    });

    it("should skip files already in sync", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(result.synced).toBe(0);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
    });

    it("should compare normalized ratings at the adapter's representable native step", async () => {
      const sameStepFile = "/music/same-step.flac";
      const nextStepFile = "/music/next-step.flac";
      mockAudio.findAudioFiles.mockResolvedValue([sameStepFile, nextStepFile]);
      mockAdapter.queryTracks.mockResolvedValue(
        createTrackPage([
          createMockTrack({ id: "same-step", filePath: sameStepFile, rating: 0.8 }),
          createMockTrack({ id: "next-step", filePath: nextStepFile, rating: 0.8 }),
        ]),
      );
      mockRatings.readRating.mockImplementation(async (filePath: string) => ({
        value: filePath === sameStepFile ? 0.82 : 0.86,
        source: "Vorbis" as const,
      }));

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(result.synced).toBe(1);
      expect(mockAdapter.updateTrackRating).toHaveBeenCalledOnce();
      expect(mockAdapter.updateTrackRating).toHaveBeenCalledWith("next-step", 0.86);
    });

    it("should skip files without ratings", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(result.synced).toBe(0);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
    });

    it.each([
      ["zero", 0],
      ["half-star", 0.1],
      ["half-scale", 0.5],
      ["full", 1],
    ])(
      "should push a %s normalized rating without Plex-scale conversion",
      async (_label, rating) => {
        const testFile = "/music/test.flac";
        mockAudio.findAudioFiles.mockResolvedValue([testFile]);
        mockAdapter.queryTracks.mockResolvedValue(
          createTrackPage([
            createMockTrack({ filePath: testFile, rating: rating === 0 ? 0.1 : null }),
          ]),
        );
        mockRatings.readRating.mockResolvedValue({ value: rating, source: "Vorbis" });

        const result = await executeMetadataSync({
          direction: { type: "push" },
          library: "Music",
          sourcePath: "/music",
          progress: false,
        });

        expect(result.synced).toBe(1);
        expect(mockAdapter.updateTrackRating).toHaveBeenCalledWith("123", rating);
      },
    );

    it("should collect failures without stopping", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });
      mockAdapter.updateTrackRating.mockResolvedValue({
        success: false,
        message: "Connection refused",
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.message).toBe("Connection refused");
    });

    it("should handle multiple files with mixed results", async () => {
      const files = ["/music/track1.flac", "/music/track2.flac", "/music/track3.flac"];
      mockAudio.findAudioFiles.mockResolvedValue(files);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [
          createMockTrack({ id: "1", filePath: files[0], rating: null }),
          createMockTrack({ id: "2", filePath: files[1], rating: 0.8 }),
          createMockTrack({ id: "3", filePath: files[2], rating: null }),
        ],
        total: 3,
        offset: 0,
        returned: 3,
        hasMore: false,
      });
      mockRatings.readRating.mockImplementation(async (filePath: string) => {
        if (filePath === files[0]) return { value: 0.8, source: "Vorbis" as const };
        if (filePath === files[1]) return { value: 0.8, source: "Vorbis" as const };
        if (filePath === files[2]) return null;
        return null;
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      // track1: rating pushed (0 -> 8)
      // track2: skipped (already 8)
      // track3: skipped (no file rating)
      expect(result.totalTracks).toBe(3);
      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(2);
    });

    it("should handle no matched files gracefully", async () => {
      mockAudio.findAudioFiles.mockResolvedValue(["/music/unmatched.flac"]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: "/music/other.flac" })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.totalTracks).toBe(0);
      expect(mockLogger.logWarn).toHaveBeenCalledWith(expect.stringContaining("No files matched"));
    });
  });

  describe("pull mode", () => {
    it("should pull Plex ratings to files", async () => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.synced).toBe(1);
      expect(mockTagWriter.writeRating).toHaveBeenCalledWith(
        testFile,
        0.8,
        expect.objectContaining({
          popmEmail: "no@email",
          vorbisScale: "normalized",
        }),
      );
    });

    it("should skip tracks without Plex ratings", async () => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it.each([
      ["zero", 0],
      ["half-star", 0.1],
      ["half-scale", 0.5],
      ["full", 1],
    ])("should pull a %s normalized rating to the file boundary", async (_label, rating) => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue(
        createTrackPage([createMockTrack({ filePath: testFile, rating })]),
      );
      mockRatings.readRating.mockResolvedValue(null);

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.synced).toBe(1);
      expect(mockTagWriter.writeRating).toHaveBeenCalledWith(testFile, rating, expect.any(Object));
    });

    it("should skip files already in sync", async () => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should skip files outside source path", async () => {
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: "/other/test.flac", rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.totalTracks).toBe(0);
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should skip non-existent files", async () => {
      const testFile = "/music/missing.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockFilesystem.pathExists.mockResolvedValue(false);

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      // totalTracks counts tracks matching source path (before pathExists check)
      // The file path matches "/music" prefix, so it's counted in totalTracks
      // but skipped during processing because the file doesn't exist
      expect(result.totalTracks).toBe(1);
      expect(result.skipped).toBe(1);
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should collect tag write failures", async () => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);
      mockTagWriter.writeRating.mockResolvedValue({
        success: false,
        message: "File is read-only",
        format: "flac",
      });

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.message).toBe("File is read-only");
    });

    it("should use custom popmEmail and vorbisScale options", async () => {
      const testFile = "/music/test.mp3";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        popmEmail: "custom@email.com",
        vorbisScale: "stars",
        progress: false,
      });

      expect(mockTagWriter.writeRating).toHaveBeenCalledWith(
        testFile,
        0.8,
        expect.objectContaining({
          popmEmail: "custom@email.com",
          vorbisScale: "stars",
        }),
      );
    });
  });

  describe("bidirectional mode", () => {
    it("should resolve conflicts using prefer option (plex)", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.6 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.conflicts).toBe(1);
      expect(result.synced).toBe(1);
      // Should write Plex rating (0.6) to file
      expect(mockTagWriter.writeRating).toHaveBeenCalledWith(testFile, 0.6, expect.any(Object));
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
    });

    it("should resolve conflicts using prefer option (file)", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.6 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "file" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.conflicts).toBe(1);
      expect(result.synced).toBe(1);
      // The adapter accepts the normalized file rating directly.
      expect(mockAdapter.updateTrackRating).toHaveBeenCalledWith("123", 0.8);
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should push file rating when only file has rating", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.conflicts).toBe(0);
      expect(result.synced).toBe(1);
      expect(mockAdapter.updateTrackRating).toHaveBeenCalled();
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should pull Plex rating when only Plex has rating", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "file" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.conflicts).toBe(0);
      expect(result.synced).toBe(1);
      expect(mockTagWriter.writeRating).toHaveBeenCalledWith(testFile, 0.8, expect.any(Object));
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
    });

    it("should skip tracks unrated on both sides", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should skip tracks already in sync", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should handle ratings within sync tolerance", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      // 0.82 should be within 0.05 tolerance of 0.8
      mockRatings.readRating.mockResolvedValue({
        value: 0.82,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.skipped).toBe(1);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
    });

    it("should filter unrated tracks with onlyRated option", async () => {
      const files = ["/music/rated.flac", "/music/unrated.flac"];
      mockAudio.findAudioFiles.mockResolvedValue(files);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [
          createMockTrack({ id: "1", filePath: files[0], rating: 0.8 }),
          createMockTrack({ id: "2", filePath: files[1], rating: null }),
        ],
        total: 2,
        offset: 0,
        returned: 2,
        hasMore: false,
      });
      mockRatings.readRating.mockImplementation(async (filePath: string) => {
        if (filePath === files[0]) return { value: 0.6, source: "Vorbis" as const };
        return null;
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        onlyRated: true,
        progress: false,
      });

      // Only the rated track should be processed
      expect(result.totalTracks).toBe(1);
    });
  });

  describe("dry-run mode", () => {
    it("should not make changes in dry-run push mode", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        dryRun: true,
        progress: false,
      });

      expect(result.synced).toBe(1);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
      expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("should not make changes in dry-run pull mode", async () => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        dryRun: true,
        progress: false,
      });

      expect(result.synced).toBe(1);
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
      expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("should not make changes in dry-run bidirectional mode", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.6 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const result = await executeMetadataSync({
        direction: { type: "both", prefer: "plex" },
        library: "Music",
        sourcePath: "/music",
        dryRun: true,
        progress: false,
      });

      expect(result.synced).toBe(1);
      expect(result.conflicts).toBe(1);
      expect(mockAdapter.updateTrackRating).not.toHaveBeenCalled();
      expect(mockTagWriter.writeRating).not.toHaveBeenCalled();
      expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("should log conflict resolution in dry-run mode", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.6 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      await executeMetadataSync({
        direction: { type: "both", prefer: "file" },
        library: "Music",
        sourcePath: "/music",
        dryRun: true,
        progress: false,
      });

      expect(mockLogger.logInfo).toHaveBeenCalledWith(expect.stringContaining("Conflict"));
    });
  });

  describe("error handling", () => {
    it("should throw error when Plex config is missing", async () => {
      mockResolveRequiredMediaServerAdapter.mockImplementationOnce(() => {
        throw new Error(
          "Plex configuration is missing. Set plex.url and plex.token in config file.",
        );
      });

      await expect(
        executeMetadataSync({
          direction: { type: "push" },
          library: "Music",
          sourcePath: "/music",
          progress: false,
        }),
      ).rejects.toThrow("Plex configuration is missing");
    });

    it("should handle Plex API errors", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: null })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });
      mockAdapter.updateTrackRating.mockResolvedValue({
        success: false,
        message: "Authentication failed (401) - check your plex token",
        statusCode: 401,
      });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.message).toContain("401");
    });

    it("should handle tag write errors", async () => {
      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);
      mockTagWriter.writeRating.mockResolvedValue({
        success: false,
        message: "Unsupported format: m4a",
        format: undefined,
      });

      const result = await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.message).toBe("Unsupported format: m4a");
    });
  });

  describe("pagination", () => {
    it("should handle paginated Plex results", async () => {
      const testFile = "/music/test.flac";
      mockAudio.findAudioFiles.mockResolvedValue([testFile]);

      // First page
      mockAdapter.queryTracks
        .mockResolvedValueOnce({
          items: [],
          total: 1000,
          offset: 0,
          returned: 500,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
          total: 1000,
          offset: 500,
          returned: 1,
          hasMore: false,
        });

      const result = await executeMetadataSync({
        direction: { type: "push" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      // Should have made two API calls for pagination
      expect(mockAdapter.queryTracks).toHaveBeenCalledTimes(2);
      expect(mockAdapter.queryTracks).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ kind: "track", offset: 500 }),
      );
      expect(result.totalTracks).toBe(1);
    });

    it("should throw when pagination is stalled (hasMore true with zero returned count)", async () => {
      mockAudio.findAudioFiles.mockResolvedValue(["/music/test.flac"]);

      mockAdapter.queryTracks.mockResolvedValueOnce({
        items: [],
        total: 1,
        offset: 0,
        returned: 0,
        hasMore: true,
      });

      await expect(
        executeMetadataSync({
          direction: { type: "push" },
          library: "Music",
          sourcePath: "/music",
          progress: false,
        }),
      ).rejects.toThrow("Pagination stalled while querying tracks");

      expect(mockAdapter.queryTracks).toHaveBeenCalledTimes(1);
    });
  });

  describe("config defaults", () => {
    it("should use syncDefaults from config", async () => {
      mockLoadedConfig.getLoadedConfig.mockReturnValue({
        plex: {
          url: "http://localhost:32400",
          token: "test-token",
          syncDefaults: {
            onlyRated: true,
            popmEmail: "custom@test.com",
            vorbisScale: "percent",
          },
        },
        copy: {
          workers: 2,
        },
      });

      const testFile = "/music/test.flac";
      mockAdapter.queryTracks.mockResolvedValue({
        items: [createMockTrack({ filePath: testFile, rating: 0.8 })],
        total: 1,
        offset: 0,
        returned: 1,
        hasMore: false,
      });
      mockRatings.readRating.mockResolvedValue(null);

      await executeMetadataSync({
        direction: { type: "pull" },
        library: "Music",
        sourcePath: "/music",
        progress: false,
      });

      expect(mockTagWriter.writeRating).toHaveBeenCalledWith(
        testFile,
        0.8,
        expect.objectContaining({
          popmEmail: "custom@test.com",
          vorbisScale: "percent",
        }),
      );
    });
  });
});
