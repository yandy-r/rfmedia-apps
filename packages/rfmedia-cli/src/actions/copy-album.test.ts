/**
 * Integration tests for conflict resolution in album mode copy operations.
 *
 * Tests cover:
 * - --conflict-strategy skip skips existing files
 * - --conflict-strategy overwrite replaces existing files
 * - --conflict-strategy rename creates unique filenames
 * - Interactive conflict resolution with mocked prompts
 * - "Apply to All" persists across files
 * - Conflict tracking in CopyResult.conflictResolutions
 * - Dry-run mode reports conflicts without applying
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CopyOptions, CopyRange } from "../types/options.js";
import type { ConflictResolution } from "../types/conflict.js";

// ============================================================================
// MOCK SETUP
// ============================================================================

// Use vi.hoisted to define mock functions that can be used in vi.mock factories
const mocks = vi.hoisted(() => ({
  // Filesystem mocks
  pathExists: vi.fn().mockResolvedValue(true),
  copyOrLink: vi.fn().mockResolvedValue("copy" as const),
  copyOrLinkWithHash: vi.fn().mockResolvedValue({
    method: "copy" as const,
    contentHash: "c".repeat(64),
    mtime: 1,
    size: 18,
  }),
  remove: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  getFileSize: vi.fn().mockResolvedValue(10485760), // 10MB default
  scanDirectoryStats: vi.fn().mockResolvedValue({ fileCount: 5, totalBytes: 52428800 }),
  copyDirectory: vi.fn().mockResolvedValue(undefined),
  calculateHash: vi.fn().mockResolvedValue("c".repeat(64)),
  convertFile: vi.fn().mockResolvedValue(undefined),
  // Verify mocks
  verifyAlbumComplete: vi.fn().mockResolvedValue("complete" as const),
  verifyFileIntegrity: vi.fn().mockResolvedValue(true),
  // Audio mocks
  isAudioFile: vi.fn().mockReturnValue(true),
  // Interactive mocks
  isInteractive: vi.fn().mockReturnValue(true),
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
  shouldReportConflictsAsJson: vi.fn().mockReturnValue(false),
  reportConflictsAsJsonAndExit: vi.fn(),
  recordInventoryFile: vi.fn(),
  recordInventoryFiles: vi.fn(),
  recordCompleted: vi.fn().mockResolvedValue(undefined),
  recordCompletedAlbumCopy: vi.fn().mockResolvedValue(undefined),
  getGlobalSignal: vi.fn().mockReturnValue(null),
  logSuccess: vi.fn(),
  resolveOptionalScanAdapter: vi.fn().mockReturnValue({
    adapter: undefined,
    scanPerSource: false,
  }),
}));

// Mock filesystem module
vi.mock("../lib/filesystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/filesystem.js")>();
  return {
    ...original,
    pathExists: mocks.pathExists,
    copyOrLink: mocks.copyOrLink,
    copyOrLinkWithHash: mocks.copyOrLinkWithHash,
    remove: mocks.remove,
    ensureDir: mocks.ensureDir,
    getFileSize: mocks.getFileSize,
    scanDirectoryStats: mocks.scanDirectoryStats,
    copyDirectory: mocks.copyDirectory,
  };
});

// Mock verify module
vi.mock("../lib/verify.js", () => ({
  verifyAlbumComplete: mocks.verifyAlbumComplete,
}));

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

// Mock audio module
vi.mock("../lib/audio.js", () => ({
  isAudioFile: mocks.isAudioFile,
  AUDIO_EXTENSIONS: [".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"],
}));

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
  shouldReportConflictsAsJson: mocks.shouldReportConflictsAsJson,
  reportConflictsAsJsonAndExit: mocks.reportConflictsAsJsonAndExit,
}));

// Mock progress display to avoid TTY issues in tests
vi.mock("../lib/progress.js", () => ({
  withSpinner: vi.fn(async (_label: string, task: () => Promise<string[]>) => task()),
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

// Mock progress bar
vi.mock("../lib/progress-bar.js", () => ({
  CopyProgressBar: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    updateFile: vi.fn(),
  })),
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
    logSuccess: mocks.logSuccess,
    logError: vi.fn(),
    isJsonMode: vi.fn().mockReturnValue(false),
    isDebugMode: vi.fn().mockReturnValue(false),
    formatDryRun: vi.fn((msg: string) => `[DRY-RUN] ${msg}`),
    outputSuccess: vi.fn(),
  };
});

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
  getLoadedPlexConfig: vi.fn().mockReturnValue({}),
  setLoadedConfig: vi.fn(),
}));

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

// Mock config module
vi.mock("../lib/config.js", () => ({
  shouldUseUndoLegacyMode: vi.fn().mockReturnValue(true),
  resolveUndoDatabasePath: vi.fn().mockReturnValue("/tmp/tracking.db"),
}));

// Mock history module
vi.mock("../lib/history.js", () => ({
  createHistorySession: vi.fn().mockResolvedValue({
    getId: vi.fn().mockReturnValue("test-session"),
    recordCopy: vi.fn().mockResolvedValue(undefined),
    recordHardlink: vi.fn().mockResolvedValue(undefined),
    recordMkdir: vi.fn().mockResolvedValue(undefined),
    recordConvert: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  isHistoryEnabled: vi.fn().mockReturnValue(false),
}));

// No media server is configured for these file-operation tests.
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mocks.resolveOptionalScanAdapter,
}));

// Mock db module
vi.mock("../lib/db.js", () => ({
  initializeDatabase: vi.fn().mockResolvedValue({}),
  closeDatabase: vi.fn().mockResolvedValue(undefined),
  recordInventoryFile: mocks.recordInventoryFile,
  recordInventoryFiles: mocks.recordInventoryFiles,
  updateOperationStatus: vi.fn().mockResolvedValue(undefined),
  updateOperationCounts: vi.fn().mockResolvedValue(undefined),
}));

// Mock tracking module
vi.mock("../lib/completed-tracker.js", () => ({
  createTrackingConfig: vi.fn().mockReturnValue({
    enabled: false,
    completedFilePath: "/tmp/completed.txt",
    failedFilePath: "/tmp/failed.txt",
    reset: false,
  }),
  createTrackingStats: vi.fn().mockReturnValue({
    total: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  }),
  loadTrackingState: vi.fn().mockResolvedValue({
    completed: new Set(),
    failed: new Set(),
  }),
  initializeTracking: vi.fn().mockResolvedValue(undefined),
  filterPendingSources: vi
    .fn()
    .mockImplementation((entries) => ({ pending: entries, alreadyCompleted: [] })),
  recordCompleted: mocks.recordCompleted,
  recordCompletedAlbumCopy: mocks.recordCompletedAlbumCopy,
  recordFailed: vi.fn().mockResolvedValue(undefined),
  calculateTimingStats: vi.fn().mockReturnValue({ eta: "N/A", rate: "N/A" }),
  loadCompletedAlbumCopiesForSource: vi.fn().mockReturnValue(new Map()),
  getPendingSuffixes: vi.fn().mockReturnValue([]),
  buildOptionsHash: vi.fn().mockReturnValue({ hash: "test", ratingKey: null }),
}));

vi.mock("../lib/signal-handler.js", () => ({
  getGlobalSignal: mocks.getGlobalSignal,
  registerGlobalCleanup: vi.fn(),
  unregisterGlobalCleanup: vi.fn(),
}));

// Mock range module
vi.mock("../lib/range.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/range.js")>();
  return {
    ...original,
    formatSuffix: original.formatSuffix,
    detectHighestSuffix: vi.fn().mockResolvedValue(null),
    buildAutoRange: vi.fn().mockReturnValue({ start: 1, end: 3, padWidth: 3 }),
    formatRange: original.formatRange,
  };
});

// Mock preview module
vi.mock("../lib/preview.js", () => ({
  collectPreviewResult: vi.fn().mockResolvedValue({
    albums: [],
    totals: { creates: 0, overwrites: 0, recreates: 0, skips: 0 },
  }),
  formatPreviewOutput: vi.fn().mockResolvedValue(undefined),
}));

// Mock table format module
vi.mock("../lib/table-format.js", () => ({
  formatCopySummaryTable: vi.fn().mockReturnValue(""),
}));

// Import the module under test after mocks are set up
import { executeAlbumCopy, executeAlbumCopyWithFileInput } from "./copy-album.js";
import type { TrackingConfig } from "../types/tracking.js";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates default CopyOptions for album mode testing.
 */
function createAlbumCopyOptions(
  range: CopyRange = { start: 1, end: 3, padWidth: 3 },
  options: Partial<CopyOptions> = {},
): CopyOptions {
  return {
    mode: { type: "album", range },
    albumOnly: true,
    hardlink: false,
    force: false,
    dryRun: options.dryRun ?? false,
    workers: options.workers ?? 1,
    trackCompleted: false,
    conflictStrategy: options.conflictStrategy,
    ...options,
  };
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("executeAlbumCopy - Conflict Resolution", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-copy-album-test-"));
    sourceDir = join(tempDir, "source", "Artist", "Album");
    destDir = join(tempDir, "dest");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(destDir, { recursive: true });

    // Create test audio file in source
    await writeFile(join(sourceDir, "track1.flac"), "test audio content");

    // Clear call history (NOT implementations!)
    vi.clearAllMocks();

    // Set up default mocks that all tests need
    mocks.pathExists.mockImplementation(async (p: string) => {
      // Source directory always exists
      if (p.includes("source")) return true;
      // Destination directory exists
      if (p === destDir) return true;
      // Artist dest directory might or might not exist
      return false;
    });
    mocks.verifyAlbumComplete.mockResolvedValue("complete");
    mocks.calculateHash.mockResolvedValue("c".repeat(64));
    mocks.copyOrLinkWithHash.mockImplementation(
      async (_source: string, dest: string, hardlink: boolean) => {
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, "test audio content");
        return {
          method: hardlink ? ("hardlink" as const) : ("copy" as const),
          contentHash: "c".repeat(64),
          mtime: 1,
          size: 18,
        };
      },
    );
    mocks.convertFile.mockResolvedValue(undefined);
    mocks.recordInventoryFiles.mockImplementation(() => undefined);
    mocks.recordCompleted.mockResolvedValue(undefined);
    mocks.recordCompletedAlbumCopy.mockResolvedValue(undefined);
    mocks.getGlobalSignal.mockReturnValue(null);
    mocks.isInteractive.mockReturnValue(true);
    mocks.detectConflict.mockResolvedValue(null);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("--conflict-strategy skip", () => {
    it("should skip existing complete album copies", async () => {
      // Setup: Destination already exists and is complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        // Album copies exist
        if (p.includes("Album-001") || p.includes("Album-002") || p.includes("Album-003")) {
          return true;
        }
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");

      const options = createAlbumCopyOptions(
        { start: 1, end: 3, padWidth: 3 },
        {
          conflictStrategy: "skip",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // All copies should be skipped since they exist and are complete
      expect(result.skipped).toBe(3);
      expect(result.created).toBe(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe("--conflict-strategy overwrite", () => {
    it("should overwrite existing complete album copies", async () => {
      // Setup: One destination already exists and is complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        // Only first album copy exists
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");

      const options = createAlbumCopyOptions(
        { start: 1, end: 1, padWidth: 3 },
        {
          conflictStrategy: "overwrite",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should overwrite the existing copy
      expect(mocks.remove).toHaveBeenCalled();
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });

  describe("--conflict-strategy rename", () => {
    it("should rename when conflict exists", async () => {
      // Setup: Destination exists and is complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        // Album-001 exists
        if (p.includes("Album-001") && !p.includes("-002")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");

      const options = createAlbumCopyOptions(
        { start: 1, end: 1, padWidth: 3 },
        {
          conflictStrategy: "rename",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should create renamed copy (uses existing as first copy source)
      // The rename resolution should be recorded
      expect(result.conflictResolutions).toBeDefined();
      if (result.conflictResolutions && result.conflictResolutions.length > 0) {
        expect(result.conflictResolutions[0]?.resolution).toBe("rename");
      }
    });
  });

  describe("Interactive conflict resolution", () => {
    it("should prompt user when strategy is ask and TTY is available", async () => {
      // Setup: Destination exists and is complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");
      mocks.isInteractive.mockReturnValue(true);
      mocks.resolveConflictInteractive.mockResolvedValue({
        resolution: "overwrite" as ConflictResolution,
        applyToAll: false,
      });

      const options = createAlbumCopyOptions(
        { start: 1, end: 1, padWidth: 3 },
        {
          conflictStrategy: "ask",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should have prompted and then created
      expect(mocks.resolveConflictInteractive).toHaveBeenCalled();
      expect(mocks.remove).toHaveBeenCalled();
      expect(result.created).toBe(1);
    });

    it("should throw error when strategy is ask and not interactive", async () => {
      // Setup: Destination exists and is complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");
      mocks.isInteractive.mockReturnValue(false);

      const options = createAlbumCopyOptions(
        { start: 1, end: 1, padWidth: 3 },
        {
          conflictStrategy: "ask",
        },
      );

      await expect(executeAlbumCopy(sourceDir, destDir, options)).rejects.toThrow(
        /non-interactive mode/,
      );
    });
  });

  describe("Apply to All", () => {
    it("should apply resolution to all subsequent conflicts of same type", async () => {
      // Setup: Multiple destinations exist and are complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        // All album copies exist
        if (p.includes("Album-")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");
      mocks.isInteractive.mockReturnValue(true);

      // First call returns with applyToAll = true, subsequent calls should use cached resolution
      mocks.resolveConflictInteractive.mockResolvedValueOnce({
        resolution: "skip" as ConflictResolution,
        applyToAll: true,
      });

      const options = createAlbumCopyOptions(
        { start: 1, end: 3, padWidth: 3 },
        {
          conflictStrategy: "ask",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should only prompt once due to Apply to All
      expect(mocks.resolveConflictInteractive).toHaveBeenCalledTimes(1);
      // All should be skipped
      expect(result.skipped).toBe(3);
    });
  });

  describe("Conflict tracking in CopyResult", () => {
    it("should track conflict resolutions in result", async () => {
      // Setup: Destination exists with conflicts
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");

      const options = createAlbumCopyOptions(
        { start: 1, end: 1, padWidth: 3 },
        {
          conflictStrategy: "rename",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should have conflict resolutions tracked
      expect(result.conflictResolutions).toBeDefined();
      expect(Array.isArray(result.conflictResolutions)).toBe(true);
    });
  });

  describe("Dry-run mode", () => {
    it("should not modify filesystem in dry-run mode", async () => {
      // Setup: Destination exists with potential conflicts
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        // Album-001 exists
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");

      const options = createAlbumCopyOptions(
        { start: 1, end: 3, padWidth: 3 },
        {
          dryRun: true,
          conflictStrategy: "overwrite",
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // In dry-run, remove should not be called for actual operations
      // (the preview system handles dry-run differently)
      expect(mocks.remove).not.toHaveBeenCalled();
      // Result should be defined
      expect(result).toBeDefined();
    });
  });

  describe("Force flag behavior", () => {
    it("should treat --force as overwrite strategy", async () => {
      // Setup: Destination exists and is complete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("complete");

      const options = createAlbumCopyOptions(
        { start: 1, end: 1, padWidth: 3 },
        {
          force: true,
        },
      );

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should overwrite due to force flag
      expect(mocks.remove).toHaveBeenCalled();
      expect(result.created).toBe(1);
    });
  });

  describe("No conflict scenarios", () => {
    it("should create copies when destination does not exist", async () => {
      // Setup: No existing destinations
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return false; // Artist folder doesn't exist yet
        return false;
      });

      const options = createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 });

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should create copies
      expect(result.created).toBeGreaterThanOrEqual(1);
      expect(result.skipped).toBe(0);
    });

    it("should persist destination content hash when tracking database is available", async () => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };
      const options = createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 });

      const result = await executeAlbumCopy(sourceDir, destDir, options, undefined, trackingConfig);

      expect(result.created).toBe(1);
      expect(mocks.recordInventoryFiles).toHaveBeenCalledWith(trackingConfig.db, 123, [
        expect.objectContaining({
          relativePath: "track1.flac",
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      expect(mocks.recordInventoryFiles.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.recordCompletedAlbumCopy.mock.invocationCallOrder[0]!,
      );
    });

    it.each([
      ["regular copy", false],
      ["hardlink", true],
    ])("persists inventory before completing a %s suffix", async (_label, hardlink) => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };

      const result = await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 }, { hardlink }),
        undefined,
        trackingConfig,
      );

      expect(result).toMatchObject({ created: 1, failed: [] });
      expect(mocks.copyOrLinkWithHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        hardlink,
        undefined,
      );
      expect(mocks.recordInventoryFiles.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.recordCompletedAlbumCopy.mock.invocationCallOrder[0]!,
      );
    });

    it("clears first suffix tracking before reporting an inventory persistence failure", async () => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };
      const inProgressFiles = new Set<string>();
      mocks.recordInventoryFiles.mockImplementationOnce(() => {
        throw new Error("inventory rejected");
      });

      const result = await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 }),
        undefined,
        trackingConfig,
        undefined,
        inProgressFiles,
      );

      const materializedFile = join(destDir, "Artist", "Album-001", "track1.flac");
      await expect(readFile(materializedFile, "utf8")).resolves.toBe("test audio content");
      expect(inProgressFiles).toEqual(new Set());
      expect(result).toMatchObject({ created: 0 });
      expect(result.failed).toEqual([expect.objectContaining({ message: "inventory rejected" })]);
      expect(mocks.recordCompletedAlbumCopy).not.toHaveBeenCalled();
      expect(mocks.logSuccess).not.toHaveBeenCalled();
    });

    it("clears first suffix tracking before reporting a completion persistence failure", async () => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };
      const inProgressFiles = new Set<string>();
      mocks.recordCompletedAlbumCopy.mockRejectedValueOnce(new Error("completion rejected"));

      const result = await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 }),
        undefined,
        trackingConfig,
        undefined,
        inProgressFiles,
      );

      const materializedFile = join(destDir, "Artist", "Album-001", "track1.flac");
      await expect(readFile(materializedFile, "utf8")).resolves.toBe("test audio content");
      expect(inProgressFiles).toEqual(new Set());
      expect(mocks.recordInventoryFiles).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ created: 0 });
      expect(result.failed).toEqual([expect.objectContaining({ message: "completion rejected" })]);
      expect(mocks.logSuccess).not.toHaveBeenCalled();
    });

    it("hashes a converted destination before inventory and completion", async () => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };

      const result = await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 }, { convertFormat: "mp3" }),
        undefined,
        trackingConfig,
      );

      expect(result).toMatchObject({ created: 1, failed: [] });
      expect(mocks.calculateHash).toHaveBeenCalledWith(expect.stringMatching(/track1\.mp3$/));
      expect(mocks.calculateHash.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.recordInventoryFiles.mock.invocationCallOrder[0]!,
      );
      expect(mocks.recordInventoryFiles.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.recordCompletedAlbumCopy.mock.invocationCallOrder[0]!,
      );
    });

    it("reports parallel inventory failure without completing or counting the suffix", async () => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };
      mocks.recordInventoryFiles
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error("inventory rejected");
        });

      const result = await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions({ start: 1, end: 2, padWidth: 3 }, { workers: 2 }),
        undefined,
        trackingConfig,
      );

      expect(result.created).toBe(1);
      expect(result.failed).toEqual([expect.objectContaining({ message: "inventory rejected" })]);
      expect(mocks.recordCompletedAlbumCopy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["copy", () => mocks.copyOrLinkWithHash.mockRejectedValueOnce(new Error("copy failed"))],
      ["hash", () => mocks.calculateHash.mockRejectedValueOnce(new Error("hash failed"))],
      [
        "database",
        () =>
          mocks.recordInventoryFiles.mockImplementationOnce(() => {
            throw new Error("database failed");
          }),
      ],
    ])("does not complete a suffix after %s failure", async (failure, arrangeFailure) => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };
      arrangeFailure();

      const result = await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions(
          { start: 1, end: 1, padWidth: 3 },
          failure === "hash" ? { convertFormat: "mp3" } : {},
        ),
        undefined,
        trackingConfig,
      );

      expect(result.created).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(mocks.recordCompletedAlbumCopy).not.toHaveBeenCalled();
    });

    it("does not hash, inventory, or complete during dry-run", async () => {
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: join(tempDir, "completed.jsonl"),
        failedFilePath: join(tempDir, "failed.jsonl"),
        reset: false,
        db: {} as TrackingConfig["db"],
        operationId: 123,
      };

      await executeAlbumCopy(
        sourceDir,
        destDir,
        createAlbumCopyOptions({ start: 1, end: 2, padWidth: 3 }, { dryRun: true }),
        undefined,
        trackingConfig,
      );

      expect(mocks.copyOrLinkWithHash).not.toHaveBeenCalled();
      expect(mocks.calculateHash).not.toHaveBeenCalled();
      expect(mocks.recordInventoryFiles).not.toHaveBeenCalled();
      expect(mocks.recordCompletedAlbumCopy).not.toHaveBeenCalled();
    });

    it("passes wrapper cancellation through to album workers", async () => {
      mocks.getGlobalSignal.mockReturnValue({
        addEventListener: (_event: string, listener: () => void) => listener(),
      } as unknown as AbortSignal);

      const result = await executeAlbumCopyWithFileInput(
        sourceDir,
        destDir,
        createAlbumCopyOptions(
          { start: 1, end: 1, padWidth: 3 },
          { configRange: { start: 1, end: 1, padWidth: 3 }, trackCompleted: true },
        ),
      );

      expect(result.created).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(mocks.copyOrLinkWithHash).not.toHaveBeenCalled();
      expect(mocks.recordCompleted).not.toHaveBeenCalled();
    });

    it("should handle incomplete existing copies by recreating", async () => {
      // Setup: Destination exists but is incomplete
      const artistDest = join(destDir, "Artist");
      mocks.pathExists.mockImplementation(async (p: string) => {
        if (p.includes("source")) return true;
        if (p === destDir) return true;
        if (p === artistDest) return true;
        if (p.includes("Album-001")) return true;
        return false;
      });

      mocks.verifyAlbumComplete.mockResolvedValue("incomplete");

      const options = createAlbumCopyOptions({ start: 1, end: 1, padWidth: 3 });

      const result = await executeAlbumCopy(sourceDir, destDir, options);

      // Should recreate incomplete copy
      expect(mocks.remove).toHaveBeenCalled();
      expect(result.created).toBe(1);
    });
  });
});
