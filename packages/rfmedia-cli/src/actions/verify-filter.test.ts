/**
 * Integration tests for verify-filter.ts conflict resolution in fix mode.
 *
 * These tests verify that the conflict resolution system integrates correctly
 * with the verify filter fix functionality, including:
 * - --conflict-strategy skip skips size-mismatch files
 * - --conflict-strategy overwrite re-copies size-mismatch files
 * - Conflict resolution for extra files (remove/keep)
 * - Interactive mode with mocked selectOption()
 * - Non-interactive mode without strategy throws appropriate error
 * - Dry-run mode reports conflicts without resolving
 * - --force continues to work as before (backwards compatibility)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { FileHandle } from "node:fs/promises";

import type { VerifyOptions, RatingFilter, ConflictResolution } from "../types/index.js";
import type { ConversionValidationOptions } from "../lib/convert.js";

// Step 1: Define mocks with vi.hoisted()
const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(true),
  copyOrLink: vi.fn().mockResolvedValue("copy" as const),
  remove: vi.fn().mockResolvedValue(undefined),
  moveToTrash: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  getFileSize: vi.fn().mockResolvedValue(10000),
  getFilesStats: vi.fn().mockResolvedValue(new Map()),
  replaceFileWithValidatedStage: vi.fn(),
  createOpenFileVerificationTarget: vi.fn(() => ({
    path: "/proc/self/fd/41",
    dependencies: { authoritative: true },
  })),
}));
const stagedHandle = { fd: 41 } as FileHandle;

const mockPrompt = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
  selectOption: vi.fn().mockResolvedValue("skip" as ConflictResolution),
  isInteractive: vi.fn().mockReturnValue(true),
}));

const mockLogger = vi.hoisted(() => ({
  isJsonMode: vi.fn().mockReturnValue(false),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const mockSignalHandler = vi.hoisted(() => {
  const abortController = new AbortController();
  return {
    getGlobalSignal: vi.fn().mockReturnValue(abortController.signal),
    registerGlobalCleanup: vi.fn(),
    unregisterGlobalCleanup: vi.fn(),
    _abortController: abortController,
    _resetAbortController: () => {
      const newController = new AbortController();
      mockSignalHandler._abortController = newController;
      mockSignalHandler.getGlobalSignal.mockReturnValue(newController.signal);
      return newController;
    },
  };
});

const mockConflictResolver = vi.hoisted(() => ({
  resolveConflictInteractive: vi.fn().mockResolvedValue({
    resolution: "skip" as ConflictResolution,
    applyToAll: false,
  }),
  resolveConflictsByStrategy: vi.fn().mockResolvedValue([]),
  chooseResolutionsByStrategy: vi.fn().mockReturnValue([]),
  generateUniquePath: vi.fn().mockImplementation((destPath: string) => destPath),
  applyResolution: vi.fn().mockResolvedValue({
    context: {} as never,
    resolution: "skip" as ConflictResolution,
    success: true,
  }),
}));

const mockConvert = vi.hoisted(() => ({
  convertFileWithValidation: vi.fn(),
  shouldConvert: vi.fn().mockReturnValue(false),
}));

const mockVerify = vi.hoisted(() => ({
  getExpectedDestFilename: vi
    .fn()
    .mockImplementation((filename: string) => filename.split(/[\\/]/u).at(-1)!),
  verifyFileSize: vi.fn().mockResolvedValue(true),
  findExtraFiles: vi.fn().mockResolvedValue([]),
}));

const mockTiered = vi.hoisted(() => ({
  verifyFileByTier: vi.fn().mockImplementation(async (input: { verifySize?: boolean }) =>
    input.verifySize
      ? {
          status: "size-mismatch" as const,
          evidence: ["metadata" as const],
          expectedSize: 10000,
          actualSize: 5000,
        }
      : { status: "present" as const, evidence: ["metadata" as const] },
  ),
}));

const mockDb = vi.hoisted(() => ({
  connection: { id: "readonly" },
  openDatabaseReadOnly: vi.fn(),
  getInventoryFingerprintCandidates: vi.fn().mockReturnValue([]),
  closeDatabase: vi.fn(),
}));

const mockAudio = vi.hoisted(() => ({
  findAudioFiles: vi.fn().mockResolvedValue([]),
}));

const mockRatings = vi.hoisted(() => ({
  readRating: vi.fn().mockResolvedValue({ value: 0.8, source: "POPM" }),
  meetsThreshold: vi.fn().mockReturnValue(true),
  meetsPlayCountThreshold: vi.fn().mockReturnValue(true),
  readRatingAndFormat: vi.fn().mockResolvedValue({
    rating: { value: 0.8, source: "POPM" },
    format: { duration: 180, bitrate: 320000, codec: "FLAC" },
  }),
  meetsMetadataFilters: vi.fn().mockReturnValue({ passes: true }),
  hasMetadataFilters: vi.fn().mockReturnValue(false),
}));

const mockParallel = vi.hoisted(() => ({
  processInParallel: vi
    .fn()
    .mockImplementation(async <T, R>(items: T[], processor: (item: T) => Promise<R>) => {
      const results = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const value = await processor(items[i]!);
          results.push({ success: true, value, index: i });
        } catch (error) {
          results.push({ success: false, error, index: i });
        }
      }
      return results;
    }),
}));

const mockProgress = vi.hoisted(() => ({
  withSpinner: vi
    .fn()
    .mockImplementation(async <T>(_message: string, fn: () => Promise<T>) => fn()),
}));

const mockInputFile = vi.hoisted(() => ({
  readSourcePaths: vi.fn().mockResolvedValue([]),
}));

const mockRange = vi.hoisted(() => ({
  formatSuffix: vi
    .fn()
    .mockImplementation((num: number, width: number) => String(num).padStart(width, "0")),
}));

const mockConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue(null),
}));

// Step 2: Apply mocks to modules
vi.mock("../lib/filesystem.js", () => ({
  pathExists: mockFilesystem.pathExists,
  copyOrLink: mockFilesystem.copyOrLink,
  remove: mockFilesystem.remove,
  moveToTrash: mockFilesystem.moveToTrash,
  ensureDir: mockFilesystem.ensureDir,
  getFileSize: mockFilesystem.getFileSize,
  getFilesStats: mockFilesystem.getFilesStats,
  replaceFileWithValidatedStage: mockFilesystem.replaceFileWithValidatedStage,
  createOpenFileVerificationTarget: mockFilesystem.createOpenFileVerificationTarget,
}));

vi.mock("../lib/prompt.js", () => ({
  confirm: mockPrompt.confirm,
  selectOption: mockPrompt.selectOption,
  isInteractive: mockPrompt.isInteractive,
}));

vi.mock("../lib/logger.js", () => ({
  isJsonMode: mockLogger.isJsonMode,
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
  logSuccess: mockLogger.logSuccess,
  logWarn: mockLogger.logWarn,
  logError: mockLogger.logError,
}));

vi.mock("../lib/signal-handler.js", () => ({
  getGlobalSignal: mockSignalHandler.getGlobalSignal,
  registerGlobalCleanup: mockSignalHandler.registerGlobalCleanup,
  unregisterGlobalCleanup: mockSignalHandler.unregisterGlobalCleanup,
}));

vi.mock("../lib/conflict-resolver.js", () => ({
  resolveConflictInteractive: mockConflictResolver.resolveConflictInteractive,
  resolveConflictsByStrategy: mockConflictResolver.resolveConflictsByStrategy,
  chooseResolutionsByStrategy: mockConflictResolver.chooseResolutionsByStrategy,
  generateUniquePath: mockConflictResolver.generateUniquePath,
  applyResolution: mockConflictResolver.applyResolution,
}));

vi.mock("../lib/convert.js", () => ({
  convertFileWithValidation: mockConvert.convertFileWithValidation,
  shouldConvert: mockConvert.shouldConvert,
}));

vi.mock("../lib/verify.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/verify.js")>();
  return {
    ...original,
    getExpectedDestFilename: mockVerify.getExpectedDestFilename,
    verifyFileSize: mockVerify.verifyFileSize,
    findExtraFiles: mockVerify.findExtraFiles,
  };
});

vi.mock("../lib/tiered-verification.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/tiered-verification.js")>();
  return {
    ...original,
    verifyFileByTier: mockTiered.verifyFileByTier,
  };
});

vi.mock("../lib/db.js", () => ({
  openDatabaseReadOnly: mockDb.openDatabaseReadOnly,
  getInventoryFingerprintCandidates: mockDb.getInventoryFingerprintCandidates,
  closeDatabase: mockDb.closeDatabase,
}));

vi.mock("../lib/audio.js", () => ({
  findAudioFiles: mockAudio.findAudioFiles,
}));

vi.mock("../lib/ratings.js", () => ({
  readRating: mockRatings.readRating,
  meetsThreshold: mockRatings.meetsThreshold,
  meetsPlayCountThreshold: mockRatings.meetsPlayCountThreshold,
  readRatingAndFormat: mockRatings.readRatingAndFormat,
  meetsMetadataFilters: mockRatings.meetsMetadataFilters,
  hasMetadataFilters: mockRatings.hasMetadataFilters,
}));

vi.mock("../lib/parallel.js", () => ({
  processInParallel: mockParallel.processInParallel,
}));

vi.mock("../lib/progress.js", () => ({
  withSpinner: mockProgress.withSpinner,
}));

vi.mock("../lib/input-file.js", () => ({
  readSourcePaths: mockInputFile.readSourcePaths,
}));

vi.mock("../lib/range.js", () => ({
  formatSuffix: mockRange.formatSuffix,
}));

vi.mock("../lib/config.js", () => ({
  resolveUndoDatabasePath: vi.fn().mockReturnValue("/tmp/tracking.db"),
}));

vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: mockConfig.getLoadedConfig,
}));

// Mock node:fs/promises stat
const mockFsPromises = vi.hoisted(() => ({
  stat: vi.fn().mockResolvedValue({ size: 10000 }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: mockFsPromises.stat,
  };
});

// Import the module under test after mocks are set up
const importVerifyFilter = async () => {
  return import("./verify-filter.js");
};

describe("verify-filter conflict resolution integration", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  const defaultRatingFilter: RatingFilter = {
    minStars: 4,
    outputFolder: "liked-songs",
    preserveStructure: false,
  };

  const createVerifyOptions = (overrides: Partial<VerifyOptions> = {}): VerifyOptions => ({
    mode: { type: "filter", rating: defaultRatingFilter },
    tier: "quick",
    albumOnly: false,
    dryRun: false,
    workers: 1,
    fix: true,
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create temp directories for test isolation
    tempDir = await mkdtemp(join(tmpdir(), "verify-filter-test-"));
    sourceDir = join(tempDir, "source", "Artist");
    destDir = join(tempDir, "dest");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(destDir, "liked-songs"), { recursive: true });

    // Reset default mock implementations
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockFilesystem.copyOrLink.mockResolvedValue("copy" as const);
    mockFilesystem.remove.mockResolvedValue(undefined);
    mockFilesystem.getFileSize.mockResolvedValue(10000);
    mockPrompt.isInteractive.mockReturnValue(true);
    mockPrompt.confirm.mockResolvedValue(true);
    mockLogger.isJsonMode.mockReturnValue(false);
    mockVerify.findExtraFiles.mockResolvedValue([]);
    mockTiered.verifyFileByTier.mockImplementation(async (input: { verifySize?: boolean }) =>
      input.verifySize
        ? {
            status: "size-mismatch" as const,
            evidence: ["metadata" as const],
            expectedSize: 10000,
            actualSize: 5000,
          }
        : { status: "present" as const, evidence: ["metadata" as const] },
    );
    mockDb.openDatabaseReadOnly.mockReturnValue(mockDb.connection);
    mockDb.getInventoryFingerprintCandidates.mockReturnValue([]);
    mockRatings.readRating.mockResolvedValue({ value: 0.8, source: "POPM" });
    mockRatings.meetsThreshold.mockReturnValue(true);
    mockSignalHandler._resetAbortController();

    // Default audio files mock
    mockAudio.findAudioFiles.mockResolvedValue([
      join(sourceDir, "track1.flac"),
      join(sourceDir, "track2.flac"),
    ]);

    mockFsPromises.stat.mockResolvedValue({ size: 10000 });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("--conflict-strategy skip", () => {
    it("should skip size-mismatch files with skip strategy", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      // Setup size mismatch scenario
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 }) // source
        .mockResolvedValueOnce({ size: 5000 }); // dest (mismatch)

      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "liked-songs", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "skip" as ConflictResolution,
        },
      ]);

      const options = createVerifyOptions({
        conflictStrategy: "skip",
        verifySize: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Should use decision-only function
      expect(mockConflictResolver.chooseResolutionsByStrategy).toHaveBeenCalledWith(
        expect.any(Array),
        "skip",
      );
      // Should NOT call the old function that performs actions
      expect(mockConflictResolver.resolveConflictsByStrategy).not.toHaveBeenCalled();

      // Should not have copied any files since we skipped
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    });
  });

  describe("--conflict-strategy overwrite", () => {
    it("should re-copy size-mismatch files with overwrite strategy", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      // Setup size mismatch scenario
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "liked-songs", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
        },
      ]);

      const options = createVerifyOptions({
        conflictStrategy: "overwrite",
        verifySize: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Should use decision-only function
      expect(mockConflictResolver.chooseResolutionsByStrategy).toHaveBeenCalledWith(
        expect.any(Array),
        "overwrite",
      );
      // Should NOT call the old function that performs actions
      expect(mockConflictResolver.resolveConflictsByStrategy).not.toHaveBeenCalled();
    });
  });

  describe("extra files conflict resolution", () => {
    it("should remove extra files when strategy maps to remove", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      // Setup extra files scenario
      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        conflictStrategy: "overwrite", // Maps to 'remove' for extra files
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Extra files should be removed with overwrite strategy
      expect(mockFilesystem.remove).toHaveBeenCalled();
    });

    it("should contain an extra-file removal failure", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const removeError = Object.assign(new Error("removal denied"), { code: "EACCES" });
      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);
      mockFilesystem.remove.mockRejectedValueOnce(removeError);

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ conflictStrategy: "overwrite" }),
      );

      expect(mockFilesystem.remove).toHaveBeenCalledWith(join(destDir, "liked-songs", "extra.txt"));
      expect(result.extra).toBe(1);
      expect(result.fixResults).toEqual(
        expect.objectContaining({
          removedFiles: 0,
          remainingIssues: 1,
          failedFixes: [
            {
              path: join(destDir, "liked-songs", "extra.txt"),
              message: "removal denied",
            },
          ],
        }),
      );
    });

    it("should keep extra files when strategy is skip", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      // Setup extra files scenario
      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        conflictStrategy: "skip", // Maps to 'keep' for extra files
      });

      const result = await executeFilterVerify(sourceDir, destDir, options);

      // Extra files should be kept with skip strategy
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(result.expectedTotal).toBe(2);
      expect(result.issues).toContainEqual(expect.objectContaining({ status: "extra" }));
    });
  });

  describe("interactive mode", () => {
    it("should use interactive resolution when strategy is ask", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockPrompt.isInteractive.mockReturnValue(true);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.resolveConflictInteractive.mockResolvedValue({
        resolution: "overwrite" as ConflictResolution,
        applyToAll: false,
      });

      const options = createVerifyOptions({
        conflictStrategy: "ask",
        verifySize: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // With 'ask' strategy and interactive mode, should use interactive resolution
      expect(mockConflictResolver.resolveConflictInteractive).toHaveBeenCalled();
    });

    it("should respect applyToAll selection from interactive mode", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockPrompt.isInteractive.mockReturnValue(true);

      // Setup multiple files with size mismatches
      mockAudio.findAudioFiles.mockResolvedValue([
        join(sourceDir, "track1.flac"),
        join(sourceDir, "track2.flac"),
        join(sourceDir, "track3.flac"),
      ]);

      // All files return mismatched sizes
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 })
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 })
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.resolveConflictInteractive.mockResolvedValueOnce({
        resolution: "skip" as ConflictResolution,
        applyToAll: true,
      });

      const options = createVerifyOptions({
        conflictStrategy: "ask",
        verifySize: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Should have called interactive resolution (which sets applyToAll)
      expect(mockConflictResolver.resolveConflictInteractive).toHaveBeenCalled();
    });
  });

  describe("non-interactive mode", () => {
    it("should warn when non-interactive without strategy", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockPrompt.isInteractive.mockReturnValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      const options = createVerifyOptions({
        verifySize: true,
        // No conflictStrategy, no force
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Should warn about needing --force or --conflict-strategy
      expect(mockLogger.logWarn).toHaveBeenCalledWith(expect.stringContaining("require"));
    });
  });

  describe("dry-run mode", () => {
    it("should report conflicts without resolving in dry-run mode", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      const options = createVerifyOptions({
        dryRun: true,
        conflictStrategy: "overwrite",
        verifySize: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // In dry-run mode, fix operations should not be executed
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
    });
  });

  describe("--force backwards compatibility", () => {
    it("should treat --force as conflictStrategy overwrite", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "liked-songs", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
        },
      ]);

      const options = createVerifyOptions({
        force: true,
        verifySize: true,
        // No explicit conflictStrategy - force should imply overwrite
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // --force should trigger strategy-based resolution with 'overwrite'
      expect(mockConflictResolver.chooseResolutionsByStrategy).toHaveBeenCalledWith(
        expect.any(Array),
        "overwrite",
      );
      // Should NOT call the old function that performs actions
      expect(mockConflictResolver.resolveConflictsByStrategy).not.toHaveBeenCalled();
    });

    it("should remove extra files with --force", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        force: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Extra files should be removed with --force
      expect(mockFilesystem.remove).toHaveBeenCalled();
    });

    it("should use trash when --force and --trash are combined", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        force: true,
        trash: true,
      });

      await executeFilterVerify(sourceDir, destDir, options);

      // Extra files should be moved to trash with --trash
      expect(mockFilesystem.moveToTrash).toHaveBeenCalled();
    });
  });

  describe("conflict resolution tracking", () => {
    it("should track conflict resolutions in result", async () => {
      const { executeFilterVerify } = await importVerifyFilter();

      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      const mockDecision = {
        context: {
          sourcePath: join(sourceDir, "track1.flac"),
          destPath: join(destDir, "liked-songs", "track1.flac"),
          conflictType: {
            type: "size-mismatch" as const,
            destPath: "",
            expected: 10000,
            actual: 5000,
          },
        },
        resolution: "skip" as ConflictResolution,
      };

      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([mockDecision]);

      const options = createVerifyOptions({
        conflictStrategy: "skip",
        verifySize: true,
      });

      const result = await executeFilterVerify(sourceDir, destDir, options);

      // The fix results should contain conflict resolutions
      expect(result.fixResults?.conflictResolutions).toBeDefined();
    });
  });

  describe("album mode verification", () => {
    it("should handle album mode with conflict resolution", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();

      const albumModeRatingFilter: RatingFilter = {
        ...defaultRatingFilter,
        albumMode: true,
        range: { start: 1, end: 3, padWidth: 3 },
      };

      mockAudio.findAudioFiles.mockResolvedValue([
        join(sourceDir, "Album1", "track1.flac"),
        join(sourceDir, "Album1", "track2.flac"),
      ]);

      const options = createVerifyOptions({
        mode: { type: "filter", rating: albumModeRatingFilter },
        conflictStrategy: "skip",
      });

      await executeFilterVerifyWithFileInput(sourceDir, destDir, options);

      // Should process without errors
      expect(mockLogger.logError).not.toHaveBeenCalledWith(expect.stringContaining("Failed"));
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: join(destDir, "Artist", "Album1-001", "track1.flac"),
        }),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledTimes(6);
    });
  });

  describe("missing filtered tracks", () => {
    it("reports only eligible missing tracks at the exact flat destination", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const eligibleTrack = join(sourceDir, "eligible.flac");
      const filteredTrack = join(sourceDir, "filtered.flac");
      const eligibleDestination = join(destDir, "liked-songs", "eligible.flac");
      const filteredDestination = join(destDir, "liked-songs", "filtered.flac");
      mockAudio.findAudioFiles.mockResolvedValue([eligibleTrack, filteredTrack]);
      mockRatings.meetsThreshold.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockFilesystem.pathExists.mockImplementation(
        async (candidate: string) => candidate !== eligibleDestination,
      );

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ fix: false }),
      );

      expect(result).toEqual(
        expect.objectContaining({ expectedTotal: 1, missing: 1, verified: 0 }),
      );
      expect(result.issues).toContainEqual({
        path: "eligible.flac",
        sourcePath: eligibleTrack,
        status: "missing",
      });
      expect(mockFilesystem.pathExists).toHaveBeenCalledWith(eligibleDestination);
      expect(mockFilesystem.pathExists).not.toHaveBeenCalledWith(filteredDestination);
      expect(mockVerify.findExtraFiles).toHaveBeenCalledWith(
        new Set(["eligible.flac"]),
        join(destDir, "liked-songs"),
      );
      expect(mockTiered.verifyFileByTier).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    });

    it("repairs a structured ranged destination and accepts the final re-observation", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      const sourceTrack = join(sourceDir, "Album A", "song.flac");
      const destinationTrack = join(destDir, "Artist", "Album A-04", "song.flac");
      let destinationChecks = 0;
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockFilesystem.pathExists.mockImplementation(async (candidate: string) => {
        if (candidate !== destinationTrack) return true;
        destinationChecks++;
        return destinationChecks > 1;
      });
      mockFilesystem.replaceFileWithValidatedStage.mockImplementation(
        async (
          destination: string,
          callbacks: {
            materialize: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
            validate: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
          },
        ) => {
          expect(destination).toBe(destinationTrack);
          const signal = new AbortController().signal;
          await callbacks.materialize(join(destDir, ".stage"), signal, stagedHandle);
          await callbacks.validate(join(destDir, ".stage"), signal, stagedHandle);
        },
      );

      const result = await executeFilterVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({
          mode: {
            type: "filter",
            rating: {
              ...defaultRatingFilter,
              albumMode: true,
              range: { start: 4, end: 4, padWidth: 2 },
            },
          },
        }),
      );

      expect(mockFilesystem.replaceFileWithValidatedStage).toHaveBeenCalledWith(
        destinationTrack,
        expect.any(Object),
      );
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
        sourceTrack,
        stagedHandle,
        false,
        expect.any(AbortSignal),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ destinationPath: "/proc/self/fd/41" }),
        { authoritative: true },
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ destinationPath: destinationTrack }),
      );
      expect(result).toEqual(
        expect.objectContaining({ expectedTotal: 1, verified: 1, missing: 0 }),
      );
      expect(result.fixResults).toEqual(
        expect.objectContaining({
          copiedFiles: 1,
          repairedFiles: 1,
          reverifiedFiles: 1,
          remainingIssues: 0,
        }),
      );
    });

    it("keeps a repaired missing track unresolved when final verification fails", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const sourceTrack = join(sourceDir, "track1.flac");
      const destinationTrack = join(destDir, "liked-songs", "track1.flac");
      let destinationChecks = 0;
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockFilesystem.pathExists.mockImplementation(async (candidate: string) => {
        if (candidate !== destinationTrack) return true;
        destinationChecks++;
        return destinationChecks > 1;
      });
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({ status: "present", evidence: ["metadata"] })
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10000,
          actualSize: 5000,
        });
      mockFilesystem.replaceFileWithValidatedStage.mockImplementation(
        async (
          _destination: string,
          callbacks: {
            materialize: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
            validate: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
          },
        ) => {
          const signal = new AbortController().signal;
          await callbacks.materialize(join(destDir, ".stage"), signal, stagedHandle);
          await callbacks.validate(join(destDir, ".stage"), signal, stagedHandle);
        },
      );

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ verifySize: true }),
      );

      expect(result).toEqual(
        expect.objectContaining({ expectedTotal: 1, verified: 0, missing: 0, sizeMismatch: 1 }),
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "track1.flac",
          sourcePath: sourceTrack,
          status: "size-mismatch",
        }),
      );
      expect(result.fixResults).toEqual(
        expect.objectContaining({ copiedFiles: 1, repairedFiles: 1, remainingIssues: 1 }),
      );
    });

    it("refuses a missing repair that lacks an authoritative staged handle", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const sourceTrack = join(sourceDir, "track1.flac");
      const destinationTrack = join(destDir, "liked-songs", "track1.flac");
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockFilesystem.pathExists.mockImplementation(
        async (candidate: string) => candidate !== destinationTrack,
      );
      mockFilesystem.replaceFileWithValidatedStage.mockImplementation(
        async (
          _destination: string,
          callbacks: {
            materialize: (
              path: string,
              signal: AbortSignal,
              handle: FileHandle | undefined,
            ) => Promise<void>;
            validate: (
              path: string,
              signal: AbortSignal,
              handle: FileHandle | undefined,
            ) => Promise<void>;
          },
        ) => {
          const signal = new AbortController().signal;
          await callbacks.materialize(join(destDir, ".stage"), signal, stagedHandle);
          await callbacks.validate(join(destDir, ".stage"), signal, undefined);
        },
      );

      const result = await executeFilterVerify(sourceDir, destDir, createVerifyOptions());

      expect(result.missing).toBe(1);
      expect(result.failed).toContainEqual(
        expect.objectContaining({
          path: "track1.flac",
          message: expect.stringContaining("authoritative file handle"),
        }),
      );
      expect(result.fixResults).toEqual(
        expect.objectContaining({ copiedFiles: 0, repairedFiles: 0, refusedFiles: 1 }),
      );
    });

    it("applies every metadata eligibility gate before creating a missing task", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const tracks = [
        "unreadable.flac",
        "unrated.flac",
        "low-rated.flac",
        "low-play-count.flac",
        "wrong-format.flac",
        "eligible.flac",
      ].map((filename) => join(sourceDir, filename));
      const eligibleDestination = join(destDir, "liked-songs", "eligible.flac");
      const format = { duration: 180, bitrate: 320000, codec: "FLAC" };
      mockAudio.findAudioFiles.mockResolvedValue(tracks);
      mockRatings.hasMetadataFilters.mockReturnValueOnce(true);
      mockRatings.readRatingAndFormat
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ rating: null, format })
        .mockResolvedValueOnce({ rating: { value: 0.2, source: "POPM" }, format })
        .mockResolvedValueOnce({ rating: { value: 0.8, source: "POPM", counter: 1 }, format })
        .mockResolvedValueOnce({ rating: { value: 0.8, source: "POPM", counter: 5 }, format })
        .mockResolvedValueOnce({ rating: { value: 0.8, source: "POPM", counter: 5 }, format });
      mockRatings.meetsThreshold
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      mockRatings.meetsPlayCountThreshold
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      mockRatings.meetsMetadataFilters
        .mockReturnValueOnce({ passes: false, reason: "codec mismatch" })
        .mockReturnValueOnce({ passes: true });
      mockFilesystem.pathExists.mockImplementation(
        async (candidate: string) => candidate !== eligibleDestination,
      );

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          mode: {
            type: "filter",
            rating: { ...defaultRatingFilter, minPlays: 2, codec: "FLAC" },
          },
        }),
      );

      expect(result).toEqual(expect.objectContaining({ expectedTotal: 1, missing: 1 }));
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "eligible.flac", sourcePath: tracks[5] }),
      );
      expect(mockFilesystem.pathExists).toHaveBeenCalledWith(eligibleDestination);
      for (const filteredTrack of tracks.slice(0, -1)) {
        expect(mockFilesystem.pathExists).not.toHaveBeenCalledWith(
          join(destDir, "liked-songs", filteredTrack.split("/").at(-1)!),
        );
      }
    });

    it("contains a verification worker failure and an extra-file scan failure", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const firstTrack = join(sourceDir, "track1.flac");
      const secondTrack = join(sourceDir, "track2.flac");
      const accessError = Object.assign(new Error("cannot inspect destination"), {
        code: "EACCES",
      });
      mockAudio.findAudioFiles.mockResolvedValue([firstTrack, secondTrack]);
      mockParallel.processInParallel.mockResolvedValueOnce([
        {
          success: true,
          value: { path: "track1.flac", sourcePath: firstTrack, status: "missing" as const },
          index: 0,
        },
        { success: false, error: accessError, index: 1 },
      ]);
      mockVerify.findExtraFiles.mockRejectedValueOnce(new Error("directory unreadable"));

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ fix: false }),
      );

      expect(result.missing).toBe(1);
      expect(result.failed).toContainEqual({
        path: "track2.flac",
        message: "cannot inspect destination",
        code: "EACCES",
      });
      expect(mockLogger.logDebug).toHaveBeenCalledWith(
        expect.stringContaining("Cannot check for extra files"),
      );
    });

    it("continues file-input verification after one source is unavailable", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      const unavailableSource = join(tempDir, "source", "Unavailable Artist");
      mockInputFile.readSourcePaths.mockResolvedValueOnce([
        { path: unavailableSource },
        { path: sourceDir },
      ]);
      mockFilesystem.pathExists.mockImplementation(
        async (candidate: string) => candidate !== unavailableSource,
      );
      mockAudio.findAudioFiles.mockResolvedValueOnce([join(sourceDir, "unrated.flac")]);
      mockRatings.readRating.mockResolvedValueOnce(null);

      const result = await executeFilterVerifyWithFileInput(
        undefined,
        destDir,
        createVerifyOptions({ fix: false, file: "sources.txt" }),
      );

      expect(mockInputFile.readSourcePaths).toHaveBeenCalledWith("sources.txt");
      expect(mockAudio.findAudioFiles).toHaveBeenCalledWith(sourceDir);
      expect(result.expectedTotal).toBe(0);
      expect(result.failed).toContainEqual({
        path: unavailableSource,
        message: `Source directory does not exist: ${unavailableSource}`,
        code: undefined,
      });
      expect(mockLogger.logWarn).toHaveBeenCalledWith("No files meet the rating threshold");
      expect(mockSignalHandler.unregisterGlobalCleanup).toHaveBeenCalledWith("verify-filter-abort");
    });

    it("applies album metadata gates without expecting filtered tracks", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      const rootTrack = join(sourceDir, "root.flac");
      const albumTracks = [
        "unreadable.flac",
        "unrated.flac",
        "low-rated.flac",
        "low-play-count.flac",
        "wrong-format.flac",
        "eligible.flac",
      ].map((filename) => join(sourceDir, "Album A", filename));
      const format = { duration: 180, bitrate: 320000, codec: "FLAC" };
      mockAudio.findAudioFiles.mockResolvedValue([rootTrack, ...albumTracks]);
      mockRatings.hasMetadataFilters.mockReturnValueOnce(true);
      mockRatings.readRatingAndFormat
        .mockRejectedValueOnce(new Error("unreadable tags"))
        .mockResolvedValueOnce({ rating: null, format })
        .mockResolvedValueOnce({ rating: { value: 0.2, source: "POPM" }, format })
        .mockResolvedValueOnce({ rating: { value: 0.8, source: "POPM", counter: 1 }, format })
        .mockResolvedValueOnce({ rating: { value: 0.8, source: "POPM", counter: 5 }, format })
        .mockResolvedValueOnce({ rating: { value: 0.8, source: "POPM", counter: 5 }, format });
      mockRatings.meetsThreshold
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      mockRatings.meetsPlayCountThreshold
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      mockRatings.meetsMetadataFilters
        .mockReturnValueOnce({ passes: false, reason: "codec mismatch" })
        .mockReturnValueOnce({ passes: true });

      const result = await executeFilterVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          mode: {
            type: "filter",
            rating: {
              ...defaultRatingFilter,
              albumMode: true,
              minPlays: 2,
              codec: "FLAC",
            },
          },
        }),
      );

      expect(result).toEqual(expect.objectContaining({ expectedTotal: 1, verified: 1 }));
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledTimes(1);
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePath: albumTracks[5],
          destinationPath: join(destDir, "Artist", "Album A", "eligible.flac"),
        }),
      );
    });

    it("contains an album verification worker failure", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      const sourceTrack = join(sourceDir, "Album A", "track1.flac");
      const taskError = Object.assign(new Error("cannot inspect album destination"), {
        code: "EIO",
      });
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockParallel.processInParallel
        .mockResolvedValueOnce([
          {
            success: true,
            value: { filePath: sourceTrack, meetsThreshold: true, albumName: "Album A" },
            index: 0,
          },
        ])
        .mockResolvedValueOnce([{ success: false, error: taskError, index: 0 }]);

      const result = await executeFilterVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          mode: {
            type: "filter",
            rating: { ...defaultRatingFilter, albumMode: true },
          },
        }),
      );

      expect(result.failed).toContainEqual({
        path: join("Album A", "track1.flac"),
        message: "cannot inspect album destination",
        code: "EIO",
      });
    });
  });

  describe("exported input boundaries", () => {
    it("rejects empty file input, absent input, and the wrong verify mode", async () => {
      const { executeFilterVerify, executeFilterVerifyWithFileInput } = await importVerifyFilter();
      mockInputFile.readSourcePaths.mockResolvedValueOnce([]);

      await expect(
        executeFilterVerifyWithFileInput(
          undefined,
          destDir,
          createVerifyOptions({ fix: false, file: "empty.txt" }),
        ),
      ).rejects.toThrow("No source paths found in file: empty.txt");
      await expect(
        executeFilterVerifyWithFileInput(undefined, destDir, createVerifyOptions({ fix: false })),
      ).rejects.toThrow(
        "Either source argument, --file option, or multiple source paths are required",
      );
      await expect(
        executeFilterVerify(
          sourceDir,
          destDir,
          createVerifyOptions({
            fix: false,
            mode: { type: "album", range: { start: 1, end: 1, padWidth: 2 } },
          }),
        ),
      ).rejects.toThrow("executeFilterVerify requires filter mode options");
    });

    it("returns an empty result when album-mode scanning finds no audio", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      mockAudio.findAudioFiles.mockResolvedValueOnce([]);

      const result = await executeFilterVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          mode: {
            type: "filter",
            rating: { ...defaultRatingFilter, albumMode: true },
          },
        }),
      );

      expect(result).toEqual(expect.objectContaining({ expectedTotal: 0, verified: 0 }));
      expect(mockLogger.logWarn).toHaveBeenCalledWith("No audio files found in source");
    });

    it("links global abort and registered cleanup to the file-input lifecycle", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      mockAudio.findAudioFiles.mockResolvedValueOnce([]);

      await executeFilterVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({ fix: false }),
      );

      const registration = mockSignalHandler.registerGlobalCleanup.mock.calls.at(-1)?.[0] as
        | { priority: number; name: string; cleanup: () => void }
        | undefined;
      expect(registration).toEqual(
        expect.objectContaining({ priority: 10, name: "verify-filter-abort" }),
      );
      expect(() => registration?.cleanup()).not.toThrow();
      expect(() => mockSignalHandler._abortController.abort()).not.toThrow();
      expect(mockSignalHandler.unregisterGlobalCleanup).toHaveBeenCalledWith("verify-filter-abort");
    });
  });

  describe("tiered verification layouts", () => {
    it("keeps quick verification database-free and allocates duplicate flat names deterministically", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      mockAudio.findAudioFiles.mockResolvedValue([
        join(sourceDir, "Album A", "song.flac"),
        join(sourceDir, "Album B", "song.flac"),
      ]);

      await executeFilterVerify(sourceDir, destDir, createVerifyOptions({ fix: false }));

      expect(mockDb.openDatabaseReadOnly).not.toHaveBeenCalled();
      expect(mockTiered.verifyFileByTier).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          tier: "quick",
          destinationPath: join(destDir, "liked-songs", "song.flac"),
        }),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          destinationPath: join(destDir, "liked-songs", "song-002.flac"),
        }),
      );
    });

    it("preloads exact default-tier evidence once for a multi-source batch", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      const secondSource = join(tempDir, "source", "Second Artist");
      const relativeSource = relative(process.cwd(), sourceDir);
      const relativeSecondSource = relative(process.cwd(), secondSource);
      await mkdir(secondSource, { recursive: true });
      const sourceTrack = join(sourceDir, "track1.flac");
      const destinationTrack = join(destDir, "liked-songs", "track1.flac");
      const fingerprint = {
        id: 1,
        operation_id: 1,
        source_path: sourceDir,
        relative_path: "track1.flac",
        mtime: 1,
        size: 10000,
        rating: null,
        genre: null,
        year: null,
        bpm: null,
        artist: null,
        dest_path: destinationTrack,
        content_hash: "sha256:abc",
        copied_at: 1,
        convert_key: null,
      };
      mockAudio.findAudioFiles
        .mockResolvedValueOnce([sourceTrack])
        .mockResolvedValueOnce([join(secondSource, "track2.flac")]);
      mockDb.getInventoryFingerprintCandidates.mockReturnValue([fingerprint]);

      await executeFilterVerifyWithFileInput(
        undefined,
        destDir,
        createVerifyOptions({
          tier: "default",
          fix: false,
          cliSourceEntries: [{ path: relativeSource }, { path: relativeSecondSource }],
        }),
      );

      expect(mockDb.openDatabaseReadOnly).toHaveBeenCalledTimes(1);
      expect(mockDb.getInventoryFingerprintCandidates).toHaveBeenCalledWith(mockDb.connection, [
        sourceDir,
        secondSource,
      ]);
      expect(mockDb.closeDatabase).toHaveBeenCalledTimes(1);
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "default", fingerprint }),
      );
      expect(mockAudio.findAudioFiles).toHaveBeenNthCalledWith(1, sourceDir);
      expect(mockAudio.findAudioFiles).toHaveBeenNthCalledWith(2, secondSource);
    });

    it("canonicalizes a single relative source before resolving exact evidence", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const relativeSource = relative(process.cwd(), sourceDir);
      const sourceTrack = join(sourceDir, "track1.flac");
      const destinationTrack = join(destDir, "liked-songs", "track1.flac");
      const fingerprint = {
        id: 1,
        operation_id: 1,
        source_path: sourceDir,
        relative_path: "track1.flac",
        mtime: 1,
        size: 10000,
        rating: null,
        genre: null,
        year: null,
        bpm: null,
        artist: null,
        dest_path: destinationTrack,
        content_hash: "sha256:abc",
        copied_at: 1,
        convert_key: null,
      };
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockDb.getInventoryFingerprintCandidates.mockReturnValue([fingerprint]);
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10000,
          actualSize: 5000,
        })
        .mockResolvedValueOnce({ status: "present", evidence: ["hash"] })
        .mockResolvedValueOnce({ status: "present", evidence: ["hash"] });
      mockFilesystem.replaceFileWithValidatedStage.mockImplementation(
        async (
          _destination: string,
          callbacks: {
            materialize: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
            validate: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
          },
        ) => {
          const signal = new AbortController().signal;
          await callbacks.materialize(join(destDir, ".stage"), signal, stagedHandle);
          await callbacks.validate(join(destDir, ".stage"), signal, stagedHandle);
        },
      );
      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: sourceTrack,
            destPath: destinationTrack,
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
        },
      ]);

      await executeFilterVerify(
        relativeSource,
        destDir,
        createVerifyOptions({ tier: "default", conflictStrategy: "overwrite" }),
      );

      expect(mockDb.getInventoryFingerprintCandidates).toHaveBeenCalledWith(mockDb.connection, [
        sourceDir,
      ]);
      expect(mockAudio.findAudioFiles).toHaveBeenCalledWith(sourceDir);
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: sourceTrack, fingerprint }),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({ destinationPath: "/proc/self/fd/41", fingerprint }),
        { authoritative: true },
      );
    });

    it("preserves structured ranged conversion destinations", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      mockAudio.findAudioFiles.mockResolvedValue([join(sourceDir, "Album A", "song.flac")]);
      mockConvert.shouldConvert.mockReturnValue(true);
      mockVerify.getExpectedDestFilename.mockReturnValue("song.mp3");

      await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          convertFormat: "mp3",
          mode: {
            type: "filter",
            rating: {
              ...defaultRatingFilter,
              preserveStructure: true,
              range: { start: 2, end: 3, padWidth: 3 },
            },
          },
        }),
      );

      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          converted: true,
          destinationPath: join(destDir, "Artist", "liked-songs", "Album A", "song-002.mp3"),
        }),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: join(destDir, "Artist", "liked-songs", "Album A", "song-003.mp3"),
        }),
      );
    });

    it("aggregates unavailable checks and hardlink not-applicable coverage", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({
          status: "unverifiable",
          evidence: [],
          reason: "fingerprint-missing",
        })
        .mockResolvedValueOnce({
          status: "present",
          evidence: ["hash"],
          notApplicableReason: "same-inode-byte-compare",
        });

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ tier: "quick", fix: false }),
      );

      expect(result.unverifiable).toBe(1);
      expect(result.notApplicable).toBe(1);
      expect(result.verified).toBe(1);
    });

    it("keeps skipped extras unresolved in the human summary", async () => {
      const { executeFilterVerifyWithFileInput } = await importVerifyFilter();
      mockVerify.findExtraFiles.mockResolvedValue(["kept.flac"]);

      const result = await executeFilterVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({ conflictStrategy: "skip" }),
      );

      expect(result.extra).toBe(1);
      expect(mockLogger.logWarn).toHaveBeenCalledWith("Status: INCOMPLETE");
    });

    it("refuses an unproven staged overwrite without deleting the destination", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const controller = new AbortController();
      const sourceTrack = join(sourceDir, "track1.flac");
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10000,
          actualSize: 5000,
        })
        .mockResolvedValueOnce({ status: "hash-mismatch", evidence: ["hash"] })
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10000,
          actualSize: 5000,
        });
      mockFilesystem.replaceFileWithValidatedStage.mockImplementation(
        async (
          _destination: string,
          callbacks: {
            signal?: AbortSignal;
            materialize: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
            validate: (path: string, signal: AbortSignal, handle: FileHandle) => Promise<void>;
          },
        ) => {
          expect(callbacks.signal).toBe(controller.signal);
          await callbacks.materialize(join(destDir, ".stage"), controller.signal, stagedHandle);
          await callbacks.validate(join(destDir, ".stage"), controller.signal, stagedHandle);
        },
      );
      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: sourceTrack,
            destPath: join(destDir, "liked-songs", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
        },
      ]);

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ conflictStrategy: "overwrite", verifySize: true }),
        controller.signal,
      );

      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
        sourceTrack,
        stagedHandle,
        false,
        controller.signal,
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: "/proc/self/fd/41",
          signal: controller.signal,
        }),
        { authoritative: true },
      );
      expect(result.fixResults).toEqual(
        expect.objectContaining({ copiedFiles: 0, repairedFiles: 0, refusedFiles: 1 }),
      );
      expect(result.sizeMismatch).toBe(1);
    });

    it("preserves the original destination when converted tier validation fails", async () => {
      const { executeFilterVerify } = await importVerifyFilter();
      const controller = new AbortController();
      const sourceTrack = join(sourceDir, "track1.flac");
      const destinationTrack = join(destDir, "liked-songs", "track1.mp3");
      const stagedTrack = join(destDir, ".conversion-stage.mp3");
      let published = false;
      mockAudio.findAudioFiles.mockResolvedValue([sourceTrack]);
      mockConvert.shouldConvert.mockReturnValue(true);
      mockVerify.getExpectedDestFilename.mockReturnValue("track1.mp3");
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10000,
          actualSize: 5000,
        })
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10000,
          actualSize: 5000,
        });
      mockConvert.convertFileWithValidation.mockImplementation(
        async (
          _source: string,
          destination: string,
          _format: string,
          options: ConversionValidationOptions,
        ) => {
          expect(destination).toBe(destinationTrack);
          expect(options.signal).toBe(controller.signal);
          await options.additionalValidator?.(stagedTrack, controller.signal, stagedHandle);
          published = true;
        },
      );
      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: sourceTrack,
            destPath: destinationTrack,
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
        },
      ]);

      const result = await executeFilterVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          conflictStrategy: "overwrite",
          convertFormat: "mp3",
          verifySize: true,
        }),
        controller.signal,
      );

      expect(mockConvert.convertFileWithValidation).toHaveBeenCalledWith(
        sourceTrack,
        destinationTrack,
        "mp3",
        expect.objectContaining({
          signal: controller.signal,
          additionalValidator: expect.any(Function),
        }),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: "/proc/self/fd/41",
          converted: true,
          signal: controller.signal,
        }),
        expect.objectContaining({ authoritative: true }),
      );
      expect(mockFilesystem.createOpenFileVerificationTarget).toHaveBeenCalledWith(stagedHandle);
      expect(mockFilesystem.replaceFileWithValidatedStage).not.toHaveBeenCalled();
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(published).toBe(false);
      expect(result.fixResults).toEqual(
        expect.objectContaining({ copiedFiles: 0, repairedFiles: 0, refusedFiles: 1 }),
      );
    });
  });
});
