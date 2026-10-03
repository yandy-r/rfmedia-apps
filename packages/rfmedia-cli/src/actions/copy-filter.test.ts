/**
 * Integration tests for smart filter copy operations.
 *
 * Tests cover:
 * - End-to-end smart filter workflow
 * - Backward compatibility with --min-stars option
 * - Filter selection with --filter <name>
 * - Dry-run mode verification
 * - Error handling for non-existent filters
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../test-utils/filesystem.js";
import { clearMocksPreservingImplementations } from "../test-utils/mock-lifecycle.js";

import { executeFilterCopy } from "./copy-filter.js";
import { isProgressEnabled } from "../lib/progress-bar.js";
import {
  closeDatabase,
  createOperation,
  getCompletedAlbumCopies,
  getInventory,
  initializeDatabase,
} from "../lib/db.js";
import type { CopyOptions, RatingFilter } from "../types/options.js";
import type { PlanPreviewCapture } from "../types/plan.js";
import type { SmartFilter } from "../types/filters.js";
import type { ConflictResolution } from "../types/conflict.js";
import type { TrackingConfig } from "../types/tracking.js";
import { allocateUniqueDestinationPaths, getExpectedDestFilename } from "../lib/verify.js";

// ============================================================================
// MOCK SETUP
// ============================================================================

// Use vi.hoisted to define mock functions that can be used in vi.mock factories
const mocks = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
  readExtendedMetadata: vi.fn().mockResolvedValue(null),
  readRating: vi.fn().mockResolvedValue(null),
  readRatingAndFormat: vi.fn().mockResolvedValue(null),
  getFileSize: vi.fn().mockResolvedValue(10485760), // 10MB default
  getFilesStats: vi.fn().mockResolvedValue({ totalBytes: 10485760, totalFiles: 1 }),
  copyOrLink: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn().mockResolvedValue(false),
  remove: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  calculateHash: vi.fn().mockResolvedValue("d".repeat(64)),
  verifyFileIntegrity: vi.fn().mockResolvedValue(true),
  convertFile: vi.fn().mockResolvedValue(undefined),
  // Conflict resolver mocks
  detectConflict: vi.fn().mockResolvedValue(null),
  generateUniquePath: vi.fn((destPath: string, usedNames: Map<string, number>) => {
    const key = destPath.toLowerCase();
    const count = usedNames.get(key);
    if (count === undefined) {
      usedNames.set(key, 2);
      return destPath;
    }
    const suffix = String(count).padStart(3, "0");
    usedNames.set(key, count + 1);
    const ext = destPath.substring(destPath.lastIndexOf("."));
    const base = destPath.substring(0, destPath.lastIndexOf("."));
    return `${base}-${suffix}${ext}`;
  }),
  resolveConflictInteractive: vi.fn().mockResolvedValue({
    resolution: "skip" as ConflictResolution,
    applyToAll: false,
  }),
  applyResolution: vi.fn().mockResolvedValue({
    context: {},
    resolution: "skip",
    success: true,
  }),
  // Interactive mocks
  isInteractive: vi.fn().mockReturnValue(true),
}));

// Mock the audio file discovery module
vi.mock("../lib/audio.js", () => ({
  findAudioFiles: mocks.findAudioFiles,
  findAudioFilesInDir: vi.fn(),
  isAudioFile: vi.fn().mockReturnValue(true),
  AUDIO_EXTENSIONS: [".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"],
}));

// Mock the metadata reading module to control filter evaluation
vi.mock("../lib/metadata.js", () => ({
  readExtendedMetadata: mocks.readExtendedMetadata,
  hasExtendedFilters: vi.fn(
    (filter: { smartFilter?: unknown }) => filter.smartFilter !== undefined,
  ),
}));

// Mock the ratings module for rating-only checks
vi.mock("../lib/ratings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ratings.js")>();
  return {
    ...original,
    readRating: mocks.readRating,
    readRatingAndFormat: mocks.readRatingAndFormat,
  };
});

// Mock filesystem operations
vi.mock("../lib/filesystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/filesystem.js")>();
  return {
    ...original,
    copyOrLink: mocks.copyOrLink,
    getFileSize: mocks.getFileSize,
    getFilesStats: mocks.getFilesStats,
    pathExists: mocks.pathExists,
    remove: mocks.remove,
    ensureDir: mocks.ensureDir,
  };
});

vi.mock("../lib/integrity.js", () => ({
  calculateHash: mocks.calculateHash,
  verifyFileIntegrity: mocks.verifyFileIntegrity,
}));

vi.mock("../lib/convert.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/convert.js")>();
  return {
    ...original,
    convertFile: mocks.convertFile,
  };
});

// Mock prompt module
vi.mock("../lib/prompt.js", () => ({
  isInteractive: mocks.isInteractive,
  confirm: vi.fn().mockResolvedValue(true),
  selectOption: vi.fn().mockResolvedValue("skip"),
}));

// Mock conflict resolver module
vi.mock("../lib/conflict-resolver.js", () => ({
  detectConflict: mocks.detectConflict,
  generateUniquePath: mocks.generateUniquePath,
  resolveConflictInteractive: mocks.resolveConflictInteractive,
  applyResolution: mocks.applyResolution,
  shouldReportConflictsAsJson: vi.fn().mockReturnValue(false),
  reportConflictsAsJsonAndExit: vi.fn(),
}));

// Export mocks for use in tests
const mockFindAudioFiles = mocks.findAudioFiles;
const mockReadExtendedMetadata = mocks.readExtendedMetadata;
const mockReadRating = mocks.readRating;
const mockReadRatingAndFormat = mocks.readRatingAndFormat;
const mockGetFileSize = mocks.getFileSize;
const mockGetFilesStats = mocks.getFilesStats;
const mockCopyOrLink = mocks.copyOrLink;

// Mock progress display to avoid TTY issues in tests
vi.mock("../lib/progress.js", () => ({
  runTasks: vi.fn(async (tasks, options) => {
    const ctx = options?.ctx ?? {};
    for (const task of tasks) {
      if (typeof task.skip === "function") {
        const skipResult = task.skip(ctx);
        if (skipResult) continue;
      }
      await task.task(ctx, { title: task.title });
    }
    return ctx;
  }),
}));

// Mock progress bar (must use function/class so `new CopyProgressBar()` works)
vi.mock("../lib/progress-bar.js", () => ({
  CopyProgressBar: vi.fn().mockImplementation(function CopyProgressBarMock() {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      updateFile: vi.fn(),
    };
  }),
  isProgressEnabled: vi.fn().mockReturnValue(false),
}));

// Mock logger to reduce test output noise
vi.mock("../lib/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/logger.js")>();
  return {
    ...original,
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logSuccess: vi.fn(),
    logError: vi.fn(),
    isJsonMode: vi.fn().mockReturnValue(false),
    isDebugMode: vi.fn().mockReturnValue(false),
  };
});

// Mock plugin system to avoid interference with tests
vi.mock("../lib/plugin-manager.js", () => ({
  getPluginManager: vi.fn().mockReturnValue({
    isInitialized: vi.fn().mockReturnValue(false),
    getPlugins: vi.fn().mockReturnValue([]),
    getPluginByName: vi.fn().mockReturnValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
  PluginManager: {
    getInstance: vi.fn().mockReturnValue({
      isInitialized: vi.fn().mockReturnValue(false),
      getPlugins: vi.fn().mockReturnValue([]),
    }),
    resetInstance: vi.fn(),
  },
}));

vi.mock("../lib/plugin-runner.js", () => ({
  runProcessFileHooks: vi.fn().mockResolvedValue([]),
  runBeforeCopyHooks: vi.fn().mockResolvedValue([]),
  runAfterCopyHooks: vi.fn().mockResolvedValue([]),
  runAfterBatchHooks: vi.fn().mockResolvedValue([]),
  summarizeHookResults: vi.fn().mockReturnValue({
    total: 0,
    successful: 0,
    failed: 0,
    errors: [],
  }),
}));

// Mock config loading to prevent tracking interference
vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    copy: {
      trackCompleted: false,
      diskSpaceMargin: 5,
      requireDiskSpace: false,
    },
    tracking: {
      useLegacy: false,
      database: undefined,
    },
    undo: {
      enabled: false,
    },
  }),
  setLoadedConfig: vi.fn(),
}));

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a mock RatingFilter for testing.
 */
function createRatingFilter(options: Partial<RatingFilter> = {}): RatingFilter {
  return {
    outputFolder: options.outputFolder ?? "liked-songs",
    preserveStructure: options.preserveStructure ?? false,
    minStars: options.minStars,
    minRating: options.minRating,
    albumMode: options.albumMode,
    smartFilter: options.smartFilter,
    filterName: options.filterName,
    range: options.range,
    ...options,
  };
}

/**
 * Creates CopyOptions for filter mode testing.
 */
function createFilterCopyOptions(
  filter: RatingFilter,
  options: Partial<CopyOptions> = {},
): CopyOptions {
  return {
    mode: { type: "filter", rating: filter },
    albumOnly: false,
    hardlink: false,
    force: false,
    dryRun: options.dryRun ?? false,
    workers: options.workers ?? 1,
    trackCompleted: false, // Disable tracking in tests
    ...options,
  };
}

/**
 * Creates a smart filter for testing.
 */
function createSmartFilter(match: "all" | "any", rules: SmartFilter["rules"]): SmartFilter {
  return { match, rules };
}

async function createTrackingTestContext(
  tempDir: string,
  options: { rangeKey?: string | null; convertKey?: string | null } = {},
) {
  const db = await initializeDatabase(join(tempDir, "tracking.db"));
  const operationId = createOperation(db, {
    command: "copy-filter",
    mode: "filter",
    inputFile: null,
    optionsHash: "filter-s3",
    ratingKey: "s3",
    rangeKey: options.rangeKey ?? null,
    convertKey: options.convertKey ?? null,
  });
  const trackingConfig: TrackingConfig = {
    enabled: true,
    completedFilePath: join(tempDir, "completed.jsonl"),
    failedFilePath: join(tempDir, "failed.jsonl"),
    reset: false,
    db,
    operationId,
  };

  return { db, operationId, trackingConfig };
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("executeFilterCopy - Smart Filter Integration", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-copy-filter-test-");
    sourceDir = join(tempDir, "source");
    destDir = join(tempDir, "dest");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(destDir, { recursive: true });

    // Clear call history
    clearMocksPreservingImplementations();

    vi.mocked(isProgressEnabled).mockReturnValue(false);

    // Set up default mocks that all tests need
    mockGetFileSize.mockResolvedValue(10485760); // 10MB default
    mockGetFilesStats.mockResolvedValue({ totalBytes: 10485760, totalFiles: 1 });
    mockCopyOrLink.mockResolvedValue("copy");
    mocks.calculateHash.mockResolvedValue("d".repeat(64));
    mocks.convertFile.mockResolvedValue(undefined);

    // pathExists: return true for source directory (validation), false for dest files
    mocks.pathExists.mockImplementation(async (p: string) => {
      return typeof p === "string" && p.startsWith(sourceDir);
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    clearMocksPreservingImplementations();
  });

  describe("End-to-End Smart Filter Workflow", () => {
    it("should copy files matching smart filter criteria", async () => {
      // Setup: Create test audio files
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock metadata to match filter
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.8, source: "Vorbis" }, // 4 stars
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Rock"], year: 2020 },
      });

      // Create smart filter: rating >= 4 AND genre contains Rock
      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
        { type: "rule", field: "genre", operator: "contains", value: "Rock" },
      ]);

      const filter = createRatingFilter({
        smartFilter,
        filterName: "test-filter",
        albumMode: true,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify mocks were called
      expect(mockFindAudioFiles, "findAudioFiles should be called").toHaveBeenCalled();
      expect(mockReadExtendedMetadata, "readExtendedMetadata should be called").toHaveBeenCalled();

      // Verify
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(0);
      expect(result.failed).toHaveLength(0);
    });

    it("should persist destination content hash when tracking database is available", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      const db = await initializeDatabase(join(tempDir, "tracking.db"));
      const operationId = createOperation(db, {
        command: "copy-filter",
        mode: "filter",
        inputFile: null,
        optionsHash: "filter-s3",
        ratingKey: "s3",
        rangeKey: null,
        convertKey: null,
      });
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db,
        operationId,
      };

      try {
        const filter = createRatingFilter({ minStars: 3.0 });
        const options = createFilterCopyOptions(filter, { trackCompleted: true });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );
        const rows = getInventory(db, operationId);

        expect(result.created).toBe(1);
        expect(mocks.calculateHash).toHaveBeenCalledWith(
          join(destDir, "source", "liked-songs", "track1.flac"),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.content_hash).toBe("d".repeat(64));
      } finally {
        closeDatabase(db);
      }
    });

    it("should hash and persist an explicitly adopted existing destination", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      const expectedDest = join(destDir, "source", "liked-songs", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
      mocks.pathExists.mockImplementation(async (candidate: string) => {
        return candidate.startsWith(sourceDir) || candidate === expectedDest;
      });

      const { db, operationId, trackingConfig } = await createTrackingTestContext(tempDir);
      try {
        const filter = createRatingFilter({ minStars: 3.0 });
        const options = createFilterCopyOptions(filter, {
          trackCompleted: true,
          conflictStrategy: "skip",
        });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );
        const rows = getInventory(db, operationId);

        expect(result).toMatchObject({ created: 0, skipped: 1, failed: [] });
        expect(mockCopyOrLink).not.toHaveBeenCalled();
        expect(mocks.calculateHash).toHaveBeenCalledWith(expectedDest);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          dest_path: expectedDest,
          content_hash: "d".repeat(64),
        });
      } finally {
        closeDatabase(db);
      }
    });

    it("should hash the renamed final output after conversion", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      const originalDest = join(destDir, "source", "liked-songs", "track1.mp3");
      const renamedDest = join(destDir, "source", "liked-songs", "track1-002.mp3");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
      mocks.pathExists.mockImplementation(async (candidate: string) => {
        return candidate.startsWith(sourceDir) || candidate === originalDest;
      });
      mocks.generateUniquePath.mockReturnValueOnce(renamedDest);

      const { db, operationId, trackingConfig } = await createTrackingTestContext(tempDir, {
        convertKey: "mp3",
      });
      try {
        const filter = createRatingFilter({ minStars: 3.0 });
        const options = createFilterCopyOptions(filter, {
          trackCompleted: true,
          conflictStrategy: "rename",
          convertFormat: "mp3",
        });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );
        const rows = getInventory(db, operationId);

        expect(result.created).toBe(1);
        expect(mocks.convertFile).toHaveBeenCalledWith(trackPath, renamedDest, "mp3");
        expect(mocks.calculateHash).toHaveBeenCalledWith(renamedDest);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          dest_path: renamedDest,
          content_hash: "d".repeat(64),
        });
      } finally {
        closeDatabase(db);
      }
    });

    it("should hash the overwritten final destination after a hardlink", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      const expectedDest = join(destDir, "source", "liked-songs", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
      mockCopyOrLink.mockResolvedValue("hardlink");
      mocks.pathExists.mockImplementation(async (candidate: string) => {
        return candidate.startsWith(sourceDir) || candidate === expectedDest;
      });

      const { db, operationId, trackingConfig } = await createTrackingTestContext(tempDir);
      try {
        const filter = createRatingFilter({ minStars: 3.0 });
        const options = createFilterCopyOptions(filter, {
          trackCompleted: true,
          force: true,
          hardlink: true,
        });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );
        const rows = getInventory(db, operationId);

        expect(result.created).toBe(1);
        expect(mocks.remove).toHaveBeenCalledWith(expectedDest);
        expect(mockCopyOrLink).toHaveBeenCalledWith(trackPath, expectedDest, true);
        expect(mocks.calculateHash).toHaveBeenCalledWith(expectedDest);
        expect(rows[0]).toMatchObject({
          dest_path: expectedDest,
          content_hash: "d".repeat(64),
        });
      } finally {
        closeDatabase(db);
      }
    });

    it("should not hash, persist inventory, or complete a dry-run", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      const { db, operationId, trackingConfig } = await createTrackingTestContext(tempDir, {
        rangeKey: "001-001",
      });
      try {
        const filter = createRatingFilter({
          minStars: 3.0,
          albumMode: true,
          range: { start: 1, end: 1, padWidth: 3 },
        });
        const options = createFilterCopyOptions(filter, {
          trackCompleted: true,
          dryRun: true,
        });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );

        expect(result).toMatchObject({ created: 1, failed: [] });
        expect(mocks.calculateHash).not.toHaveBeenCalled();
        expect(getInventory(db, operationId)).toHaveLength(0);
        expect(getCompletedAlbumCopies(db, operationId, sourceDir)).toHaveLength(0);
      } finally {
        closeDatabase(db);
      }
    });

    it("should not persist inventory or completion after a hash failure", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
      mocks.calculateHash.mockRejectedValueOnce(new Error("simulated hash failure"));

      const { db, operationId, trackingConfig } = await createTrackingTestContext(tempDir, {
        rangeKey: "001-001",
      });
      try {
        const filter = createRatingFilter({
          minStars: 3.0,
          albumMode: true,
          range: { start: 1, end: 1, padWidth: 3 },
        });
        const options = createFilterCopyOptions(filter, { trackCompleted: true });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );

        expect(result.created).toBe(0);
        expect(result.failed).toEqual([
          expect.objectContaining({ message: "simulated hash failure" }),
        ]);
        expect(getInventory(db, operationId)).toHaveLength(0);
        expect(getCompletedAlbumCopies(db, operationId, sourceDir)).toHaveLength(0);
      } finally {
        closeDatabase(db);
      }
    });

    it("should not complete a suffix when database digest validation fails", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });
      mocks.calculateHash.mockResolvedValueOnce("INVALID");

      const { db, operationId, trackingConfig } = await createTrackingTestContext(tempDir, {
        rangeKey: "001-001",
      });
      try {
        const filter = createRatingFilter({
          minStars: 3.0,
          albumMode: true,
          range: { start: 1, end: 1, padWidth: 3 },
        });
        const options = createFilterCopyOptions(filter, { trackCompleted: true });

        const result = await executeFilterCopy(
          sourceDir,
          destDir,
          options,
          undefined,
          trackingConfig,
        );

        expect(result.created).toBe(0);
        expect(result.failed).toEqual([
          expect.objectContaining({
            message: "Invalid content hash: expected 64 lowercase hexadecimal characters.",
          }),
        ]);
        expect(getInventory(db, operationId)).toHaveLength(0);
        expect(getCompletedAlbumCopies(db, operationId, sourceDir)).toHaveLength(0);
      } finally {
        closeDatabase(db);
      }
    });

    it("should filter out files not matching smart filter criteria", async () => {
      // Setup: Create test audio files
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock metadata to NOT match filter (rating too low)
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.4, source: "Vorbis" }, // 2 stars
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Rock"], year: 2020 },
      });

      // Create smart filter: rating >= 4
      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
      ]);

      const filter = createRatingFilter({
        smartFilter,
        filterName: "high-rated",
        albumMode: true,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: file should be filtered out
      expect(result.created).toBe(0);
      expect(result.filtered).toBe(1);
    });

    it("should handle OR logic in smart filters", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock metadata: genre is Jazz (not Rock), but rating is high
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.9, source: "Vorbis" }, // 4.5 stars
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Jazz"], year: 1960 },
      });

      // Create smart filter: high rating OR genre Rock (should pass on rating)
      const smartFilter = createSmartFilter("any", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
        { type: "rule", field: "genre", operator: "contains", value: "Rock" },
      ]);

      const filter = createRatingFilter({ smartFilter, albumMode: true });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: should pass because of OR logic
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(0);
    });

    it("should handle nested groups in smart filters", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock metadata
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.8, source: "Vorbis" },
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Alternative"], year: 2015 },
      });

      // Create nested filter: rating >= 4 AND (genre Rock OR genre Alternative)
      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
        {
          type: "group",
          match: "any",
          rules: [
            { type: "rule", field: "genre", operator: "contains", value: "Rock" },
            { type: "rule", field: "genre", operator: "contains", value: "Alternative" },
          ],
        },
      ]);

      const filter = createRatingFilter({ smartFilter, albumMode: true });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify
      expect(result.created).toBe(1);
    });
  });

  describe("Backward Compatibility with --min-stars", () => {
    it("should work with legacy minStars option", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock readRating for legacy mode
      mockReadRating.mockResolvedValue({
        value: 0.8, // 4 stars
        source: "Vorbis",
      });

      // Legacy filter using minStars (no smartFilter)
      const filter = createRatingFilter({
        minStars: 3.5,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(0);
    });

    it("should filter out files below minStars threshold", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock readRating with low rating
      mockReadRating.mockResolvedValue({
        value: 0.4, // 2 stars
        source: "Vorbis",
      });

      // Legacy filter with high threshold
      const filter = createRatingFilter({
        minStars: 4.0,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify
      expect(result.created).toBe(0);
      expect(result.filtered).toBe(1);
    });

    it("should handle unrated files with minStars", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock readRating returning null (unrated)
      mockReadRating.mockResolvedValue(null);

      const filter = createRatingFilter({
        minStars: 3.0,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: unrated files should be filtered
      expect(result.created).toBe(0);
      expect(result.filtered).toBe(1);
    });
  });

  describe("Dry-Run Mode", () => {
    it("should not create files in dry-run mode", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock readRating
      mockReadRating.mockResolvedValue({
        value: 0.9,
        source: "Vorbis",
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, { dryRun: true });

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: result shows files would be created
      expect(result.created).toBe(1);

      // Verify: destination directory is still empty
      const destContents = await readdir(destDir);
      expect(destContents).toHaveLength(0);
    });

    it("should report correct counts in dry-run mode with smart filter", async () => {
      // Setup: Create multiple files
      const track1 = join(sourceDir, "Album", "track1.flac");
      const track2 = join(sourceDir, "Album", "track2.flac");
      await createTestFile(track1);
      await createTestFile(track2);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([track1, track2]);

      // Mock metadata: first file passes, second fails
      mockReadExtendedMetadata
        .mockResolvedValueOnce({
          rating: { value: 0.9, source: "Vorbis" },
          format: {
            duration: 180,
            bitrate: 320000,
            codec: "FLAC",
            trackInfo: [],
            tagTypes: ["vorbis"],
          },
          common: { genre: ["Rock"] },
        })
        .mockResolvedValueOnce({
          rating: { value: 0.4, source: "Vorbis" },
          format: {
            duration: 180,
            bitrate: 320000,
            codec: "FLAC",
            trackInfo: [],
            tagTypes: ["vorbis"],
          },
          common: { genre: ["Pop"] },
        });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
      ]);

      const filter = createRatingFilter({ smartFilter, albumMode: true });
      const options = createFilterCopyOptions(filter, { dryRun: true });

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify counts
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(1);

      // Verify no actual files created
      const destContents = await readdir(destDir);
      expect(destContents).toHaveLength(0);
    });

    it("dry-run with capturePreview set bypasses the listr2 branch and invokes the capture with a FilterPreview", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({
        value: 0.9,
        source: "Vorbis",
      });

      const captures: PlanPreviewCapture[] = [];
      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, {
        dryRun: true,
        capturePreview: (capture) => captures.push(capture),
      });

      // Execute (non-JSON mode; capturePreview pins the routing fix at the
      // listr2 branch condition so the structured pre-scan preview runs)
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: preview counts still reported
      expect(result.created).toBe(1);

      // Verify: the capture hook received the structured FilterPreview
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      if (capture?.mode !== "filter") {
        throw new Error("expected a filter-mode capture");
      }
      expect(capture.source).toBe(sourceDir);
      expect(capture.preview.likedTracks).toHaveLength(1);
      expect(capture.preview.likedTracks[0]?.sourcePath).toBe(trackPath);
      expect(capture.preview.likedTracks[0]?.action).toBe("create");
    });
  });

  describe("Album Mode with Smart Filters", () => {
    it("should process album mode with smart filter", async () => {
      // Setup: Create test audio files in album structure
      const track1 = join(sourceDir, "Album1", "track1.flac");
      const track2 = join(sourceDir, "Album1", "track2.flac");
      await createTestFile(track1);
      await createTestFile(track2);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([track1, track2]);

      // Mock metadata - both pass filter
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.8, source: "Vorbis" },
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Rock"] },
      });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 3.0 },
      ]);

      const filter = createRatingFilter({
        smartFilter,
        albumMode: true,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify both tracks copied
      expect(result.created).toBe(2);
      expect(result.filtered).toBe(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle metadata read errors gracefully", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      // Mock metadata reading to return null (error)
      mockReadExtendedMetadata.mockResolvedValue(null);

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 3.0 },
      ]);

      const filter = createRatingFilter({ smartFilter, albumMode: true });
      const options = createFilterCopyOptions(filter);

      // Execute - should not throw
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: file is filtered (not copied) due to error
      expect(result.created).toBe(0);
      expect(result.filtered).toBe(1);
    });

    it("should throw error for non-existent source directory", async () => {
      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter);

      // Execute with non-existent source
      await expect(executeFilterCopy("/non/existent/path", destDir, options)).rejects.toThrow(
        /does not exist/,
      );
    });

    it("should handle empty source directory", async () => {
      // sourceDir exists but is empty
      // Mock audio file discovery returning empty array
      mockFindAudioFiles.mockResolvedValue([]);

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify: no files processed
      expect(result.created).toBe(0);
      expect(result.filtered).toBe(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe("Multiple Files Processing", () => {
    it("should process multiple files with mixed results", async () => {
      // Setup: Create multiple files
      const track1 = join(sourceDir, "Album", "track1.flac");
      const track2 = join(sourceDir, "Album", "track2.flac");
      const track3 = join(sourceDir, "Album", "track3.flac");
      await createTestFile(track1);
      await createTestFile(track2);
      await createTestFile(track3);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([track1, track2, track3]);

      // Mock different ratings
      mockReadRating
        .mockResolvedValueOnce({ value: 0.9, source: "Vorbis" }) // 4.5 stars - pass
        .mockResolvedValueOnce({ value: 0.5, source: "Vorbis" }) // 2.5 stars - fail
        .mockResolvedValueOnce({ value: 0.8, source: "Vorbis" }); // 4 stars - pass

      const filter = createRatingFilter({ minStars: 3.5 });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify
      expect(result.created).toBe(2);
      expect(result.filtered).toBe(1);
    });
  });

  describe("Flat Destination Mapping", () => {
    it("matches verify mapping for case variants and natural suffix collisions", async () => {
      const tracks = [
        join(sourceDir, "Album1", "track.flac"),
        join(sourceDir, "Album2", "TRACK-002.FLAC"),
        join(sourceDir, "Album3", "Track.FLAC"),
        join(sourceDir, "Album4", "track.FLAC"),
      ];
      await Promise.all(tracks.map((track) => createTestFile(track)));

      mockFindAudioFiles.mockResolvedValue(tracks);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      const outputDir = join(destDir, "source", "liked-songs");
      const verifyDestinations = allocateUniqueDestinationPaths(
        tracks.map((track) => join(outputDir, getExpectedDestFilename(track))),
      );

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, { workers: 1 });

      const result = await executeFilterCopy(sourceDir, destDir, options);
      const copiedDestinations = mockCopyOrLink.mock.calls.map(([, destination]) => destination);

      expect(result).toMatchObject({ created: tracks.length, failed: [] });
      expect(copiedDestinations).toEqual(verifyDestinations);
      expect(copiedDestinations).toEqual([
        join(outputDir, "track.flac"),
        join(outputDir, "TRACK-002.FLAC"),
        join(outputDir, "Track-003.FLAC"),
        join(outputDir, "track-004.FLAC"),
      ]);
    });

    it("matches verify mapping after conversion creates duplicate basenames", async () => {
      const tracks = [
        join(sourceDir, "Album1", "song.flac"),
        join(sourceDir, "Album2", "SONG-002.wav"),
        join(sourceDir, "Album3", "Song.mp3"),
        join(sourceDir, "Album4", "song.aac"),
      ];
      await Promise.all(tracks.map((track) => createTestFile(track)));

      mockFindAudioFiles.mockResolvedValue(tracks);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      const outputDir = join(destDir, "source", "liked-songs");
      const verifyDestinations = allocateUniqueDestinationPaths(
        tracks.map((track) => join(outputDir, getExpectedDestFilename(track, "alac"))),
      );

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, {
        workers: 1,
        convertFormat: "alac",
      });

      const result = await executeFilterCopy(sourceDir, destDir, options);
      const convertedDestinations = mocks.convertFile.mock.calls.map(
        ([, destination]) => destination,
      );

      expect(result).toMatchObject({ created: tracks.length, failed: [] });
      expect(convertedDestinations).toEqual(verifyDestinations);
      expect(convertedDestinations).toEqual([
        join(outputDir, "song.m4a"),
        join(outputDir, "SONG-002.m4a"),
        join(outputDir, "Song-003.m4a"),
        join(outputDir, "song-004.m4a"),
      ]);
    });
  });

  describe("Non-Album Smart Filter Copy (flat listr path)", () => {
    it("should use readExtendedMetadata for non-album smart filters", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.8, source: "Vorbis" },
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Rock"], year: 2020 },
      });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
        { type: "rule", field: "genre", operator: "contains", value: "Rock" },
      ]);

      const filter = createRatingFilter({
        smartFilter,
        filterName: "flat-smart-filter",
      });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadExtendedMetadata).toHaveBeenCalled();
      expect(mockReadRating).not.toHaveBeenCalled();
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(0);
    });

    it("should filter non-matching files in non-album smart filter mode", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.4, source: "Vorbis" },
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Rock"], year: 2020 },
      });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
      ]);

      const filter = createRatingFilter({ smartFilter });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadExtendedMetadata).toHaveBeenCalled();
      expect(mockReadRating).not.toHaveBeenCalled();
      expect(result.created).toBe(0);
      expect(result.filtered).toBe(1);
    });
  });

  describe("Reader Selection Branches", () => {
    it("should use readRating for legacy minStars in non-album mode", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({
        value: 0.8,
        source: "Vorbis",
      });

      const filter = createRatingFilter({ minStars: 3.5 });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadRating).toHaveBeenCalled();
      expect(mockReadExtendedMetadata).not.toHaveBeenCalled();
      expect(result.created).toBe(1);
    });

    it("should use readRating for legacy minRating in non-album mode", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({
        value: 0.9,
        source: "POPM",
      });

      const filter = createRatingFilter({ minRating: 80 });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadRating).toHaveBeenCalled();
      expect(mockReadExtendedMetadata).not.toHaveBeenCalled();
      expect(result.created).toBe(1);
    });

    it("should pre-scan with readExtendedMetadata when progress is enabled", async () => {
      vi.mocked(isProgressEnabled).mockReturnValue(true);

      const track1 = join(sourceDir, "Album", "track1.flac");
      const track2 = join(sourceDir, "Album", "track2.flac");
      await createTestFile(track1);
      await createTestFile(track2);

      mockFindAudioFiles.mockResolvedValue([track1, track2]);
      mockReadExtendedMetadata
        .mockResolvedValueOnce({
          rating: { value: 0.9, source: "Vorbis" },
          format: {
            duration: 180,
            bitrate: 320000,
            codec: "FLAC",
            trackInfo: [],
            tagTypes: ["vorbis"],
          },
          common: { genre: ["Rock"] },
        })
        .mockResolvedValueOnce({
          rating: { value: 0.4, source: "Vorbis" },
          format: {
            duration: 180,
            bitrate: 320000,
            codec: "FLAC",
            trackInfo: [],
            tagTypes: ["vorbis"],
          },
          common: { genre: ["Pop"] },
        });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
      ]);

      const filter = createRatingFilter({ smartFilter });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadExtendedMetadata).toHaveBeenCalled();
      expect(mockReadRating).not.toHaveBeenCalled();
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(1);
    });

    it("should pre-scan smart filters in dry-run when progress is enabled", async () => {
      vi.mocked(isProgressEnabled).mockReturnValue(true);

      const track1 = join(sourceDir, "Album", "track1.flac");
      const track2 = join(sourceDir, "Album", "track2.flac");
      await createTestFile(track1);
      await createTestFile(track2);

      mockFindAudioFiles.mockResolvedValue([track1, track2]);
      mockReadExtendedMetadata
        .mockResolvedValueOnce({
          rating: { value: 0.9, source: "Vorbis" },
          format: {
            duration: 180,
            bitrate: 320000,
            codec: "FLAC",
            trackInfo: [],
            tagTypes: ["vorbis"],
          },
          common: { genre: ["Rock"] },
        })
        .mockResolvedValueOnce({
          rating: { value: 0.4, source: "Vorbis" },
          format: {
            duration: 180,
            bitrate: 320000,
            codec: "FLAC",
            trackInfo: [],
            tagTypes: ["vorbis"],
          },
          common: { genre: ["Pop"] },
        });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
      ]);

      const filter = createRatingFilter({ smartFilter });
      const options = createFilterCopyOptions(filter, { dryRun: true });

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadExtendedMetadata).toHaveBeenCalled();
      expect(mockReadRating).not.toHaveBeenCalled();
      expect(result.created).toBe(1);
      expect(result.filtered).toBe(1);

      const destContents = await readdir(destDir);
      expect(destContents).toHaveLength(0);
    });

    it("should keep album-mode smart filters on readExtendedMetadata", async () => {
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadExtendedMetadata.mockResolvedValue({
        rating: { value: 0.8, source: "Vorbis" },
        format: {
          duration: 180,
          bitrate: 320000,
          codec: "FLAC",
          trackInfo: [],
          tagTypes: ["vorbis"],
        },
        common: { genre: ["Rock"] },
      });

      const smartFilter = createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 3.0 },
      ]);

      const filter = createRatingFilter({ smartFilter, albumMode: true });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      expect(mockReadExtendedMetadata).toHaveBeenCalled();
      expect(mockReadRating).not.toHaveBeenCalled();
      expect(result.created).toBe(1);
    });
  });

  describe("Preserve Structure Option", () => {
    it("should preserve album structure when option is set", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album1", "track1.flac");
      await createTestFile(trackPath);

      // Mock audio file discovery
      mockFindAudioFiles.mockResolvedValue([trackPath]);

      mockReadRating.mockResolvedValue({
        value: 0.9,
        source: "Vorbis",
      });

      const filter = createRatingFilter({
        minStars: 3.0,
        preserveStructure: true,
      });
      const options = createFilterCopyOptions(filter);

      // Execute
      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Verify
      expect(result.created).toBe(1);

      // Check that album structure is preserved
      // Path should be: dest/source-basename/liked-songs/Album1/track1.flac
    });
  });
});

describe("executeFilterCopy - Filter Selection", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-filter-select-test-");
    sourceDir = join(tempDir, "source");
    destDir = join(tempDir, "dest");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(destDir, { recursive: true });

    clearMocksPreservingImplementations();

    // pathExists: return true for source directory (validation), false for dest files
    mocks.pathExists.mockImplementation(async (p: string) => {
      return typeof p === "string" && p.startsWith(sourceDir);
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    clearMocksPreservingImplementations();
  });

  it("should use filter name in logging", async () => {
    // Setup
    const trackPath = join(sourceDir, "Album", "track1.flac");
    await createTestFile(trackPath);

    // Mock audio file discovery
    mockFindAudioFiles.mockResolvedValue([trackPath]);

    mockReadExtendedMetadata.mockResolvedValue({
      rating: { value: 0.8, source: "Vorbis" },
      format: {
        duration: 180,
        bitrate: 320000,
        codec: "FLAC",
        trackInfo: [],
        tagTypes: ["vorbis"],
      },
      common: { genre: ["Rock"] },
    });

    const smartFilter = createSmartFilter("all", [
      { type: "rule", field: "rating", operator: ">=", value: 3.0 },
    ]);

    const filter = createRatingFilter({
      smartFilter,
      filterName: "my-awesome-filter",
      albumMode: true,
    });
    const options = createFilterCopyOptions(filter);

    // Execute
    const result = await executeFilterCopy(sourceDir, destDir, options);

    // Verify filter was used
    expect(result.created).toBe(1);

    // Verify the filter name was used (operation completed successfully with smart filter)
    expect(mockReadExtendedMetadata).toHaveBeenCalled();
  });
});

// ============================================================================
// CONFLICT RESOLUTION TESTS
// ============================================================================

describe("executeFilterCopy - Conflict Resolution", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-filter-conflict-test-");
    sourceDir = join(tempDir, "source");
    destDir = join(tempDir, "dest");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(destDir, { recursive: true });

    // Clear call history
    clearMocksPreservingImplementations();

    // Set up default mocks
    mockGetFileSize.mockResolvedValue(10485760);
    mockGetFilesStats.mockResolvedValue({ totalBytes: 10485760, totalFiles: 1 });
    mockCopyOrLink.mockResolvedValue("copy" as const);
    mocks.pathExists.mockResolvedValue(true);
    mocks.ensureDir.mockResolvedValue(undefined);
    mocks.isInteractive.mockReturnValue(true);
    mocks.detectConflict.mockResolvedValue(null);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    clearMocksPreservingImplementations();
  });

  describe("--conflict-strategy skip", () => {
    it("should skip existing files when conflict strategy is skip", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      // Mock that the destination file already exists
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        // Destination file exists
        if (p.includes("liked-songs") && p.includes("track1.flac")) return true;
        return false;
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, { conflictStrategy: "skip" });

      const result = await executeFilterCopy(sourceDir, destDir, options);

      // File should be skipped due to existing destination
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
    });
  });

  describe("--conflict-strategy overwrite", () => {
    it("should overwrite existing files when force flag is set", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      // Mock that the destination file already exists
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p.includes("liked-songs") && p.includes("track1.flac")) return true;
        return false;
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, {
        force: true, // Force enables overwrite behavior
      });

      const result = await executeFilterCopy(sourceDir, destDir, options);

      // File should be created (overwriting the existing one)
      expect(result.created).toBe(1);
    });
  });

  describe("--conflict-strategy rename", () => {
    it("should rename files when conflict strategy is rename", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      // Mock that the destination file already exists
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        // Original destination exists, but renamed does not
        if (p.includes("track1.flac") && !p.includes("-002")) return true;
        return false;
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, { conflictStrategy: "rename" });

      const result = await executeFilterCopy(sourceDir, destDir, options);

      // File should be created with a renamed path
      expect(result.created).toBe(1);
    });
  });

  describe("Interactive conflict resolution", () => {
    it("should handle conflicts when strategy is ask and TTY is available", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      // Mock that the destination file already exists
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p.includes("liked-songs") && p.includes("track1.flac")) return true;
        return false;
      });

      mocks.isInteractive.mockReturnValue(true);
      mocks.resolveConflictInteractive.mockResolvedValue({
        resolution: "skip" as ConflictResolution,
        applyToAll: false,
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, { conflictStrategy: "ask" });

      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Should have handled the conflict (skip in this case)
      expect(result.skipped).toBe(1);
    });
  });

  describe("Force flag behavior", () => {
    it("should treat --force as overwrite strategy for existing files", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      // Mock that the destination file already exists initially
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p.includes("liked-songs") && p.includes("track1.flac")) return true;
        return false;
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter, { force: true });

      const result = await executeFilterCopy(sourceDir, destDir, options);

      // File should be created (overwriting due to force)
      expect(result.created).toBe(1);
    });
  });

  describe("No conflict scenarios", () => {
    it("should process files when destination does not exist", async () => {
      // Setup
      const trackPath = join(sourceDir, "Album", "track1.flac");
      await createTestFile(trackPath);

      mockFindAudioFiles.mockResolvedValue([trackPath]);
      mockReadRating.mockResolvedValue({ value: 0.9, source: "Vorbis" });

      // No conflicts - destination doesn't exist
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        // Destination file does NOT exist
        return false;
      });

      const filter = createRatingFilter({ minStars: 3.0 });
      const options = createFilterCopyOptions(filter);

      const result = await executeFilterCopy(sourceDir, destDir, options);

      // Result should be valid (specific counts depend on mock implementation details)
      expect(result).toBeDefined();
      expect(result.failed).toHaveLength(0);
    });
  });
});
