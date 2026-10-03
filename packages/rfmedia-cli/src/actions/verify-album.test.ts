/**
 * Integration tests for verify-album.ts conflict resolution in fix mode.
 *
 * These tests verify that the conflict resolution system integrates correctly
 * with the verify album fix functionality, including:
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
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

import type { VerifyOptions, CopyRange, ConflictResolution } from "../types/index.js";
import type { ConversionValidationOptions } from "../lib/convert.js";

// Step 1: Define mocks with vi.hoisted()
const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(true),
  copyOrLink: vi.fn().mockResolvedValue("copy" as const),
  remove: vi.fn().mockResolvedValue(undefined),
  moveToTrash: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  getFileSize: vi.fn().mockResolvedValue(10000),
  normalizePathResolved: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
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
  shouldReportConflictsAsJson: vi.fn().mockReturnValue(false),
  reportConflictsAsJsonAndExit: vi.fn(),
}));

const mockConvert = vi.hoisted(() => ({
  convertFileWithValidation: vi.fn(),
  shouldConvert: vi.fn().mockReturnValue(false),
}));

const mockVerify = vi.hoisted(() => ({
  getExpectedDestFilename: vi.fn().mockImplementation((filename: string) => filename),
  verifyFileSize: vi.fn().mockResolvedValue(true),
  findExtraFiles: vi.fn().mockResolvedValue([]),
}));

const mockAudio = vi.hoisted(() => ({
  isAudioFile: vi.fn().mockReturnValue(true),
}));

const mockParallel = vi.hoisted(() => ({
  processInParallel: vi
    .fn()
    .mockImplementation(
      async <T, R>(
        items: T[],
        processor: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
        options?: { signal?: AbortSignal },
      ) => {
        const results = [];
        for (let i = 0; i < items.length; i++) {
          try {
            const value = await processor(items[i]!, i, options?.signal);
            results.push({ success: true, value, index: i });
          } catch (error) {
            results.push({ success: false, error, index: i });
          }
        }
        return results;
      },
    ),
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

const mockDb = vi.hoisted(() => ({
  openDatabaseReadOnly: vi.fn(),
  getInventoryFingerprintCandidates: vi.fn().mockReturnValue([]),
  closeDatabase: vi.fn(),
}));

const mockTiered = vi.hoisted(() => ({
  verifyFileByTier: vi.fn(),
  resolveFingerprintCandidate: vi.fn().mockReturnValue({ status: "missing" }),
}));

// Step 2: Apply mocks to modules
vi.mock("../lib/filesystem.js", () => ({
  pathExists: mockFilesystem.pathExists,
  copyOrLink: mockFilesystem.copyOrLink,
  remove: mockFilesystem.remove,
  moveToTrash: mockFilesystem.moveToTrash,
  ensureDir: mockFilesystem.ensureDir,
  getFileSize: mockFilesystem.getFileSize,
  normalizePathResolved: mockFilesystem.normalizePathResolved,
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
  shouldReportConflictsAsJson: mockConflictResolver.shouldReportConflictsAsJson,
  reportConflictsAsJsonAndExit: mockConflictResolver.reportConflictsAsJsonAndExit,
}));

vi.mock("../lib/convert.js", () => ({
  convertFileWithValidation: mockConvert.convertFileWithValidation,
  shouldConvert: mockConvert.shouldConvert,
}));

vi.mock("../lib/verify.js", () => ({
  getExpectedDestFilename: mockVerify.getExpectedDestFilename,
  verifyFileSize: mockVerify.verifyFileSize,
  findExtraFiles: mockVerify.findExtraFiles,
}));

vi.mock("../lib/audio.js", () => ({
  isAudioFile: mockAudio.isAudioFile,
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
  getLoadedConfig: mockConfig.getLoadedConfig,
}));

vi.mock("../lib/db.js", () => mockDb);

vi.mock("../lib/integrity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/integrity.js")>();
  return {
    ...actual,
    calculateHash: vi.fn().mockResolvedValue("a".repeat(64)),
  };
});

vi.mock("../lib/tiered-verification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tiered-verification.js")>();
  return {
    ...actual,
    verifyFileByTier: mockTiered.verifyFileByTier,
    resolveFingerprintCandidate: mockTiered.resolveFingerprintCandidate,
  };
});

// We need to also mock node:fs/promises readdir and stat
const mockFsPromises = vi.hoisted(() => ({
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ size: 10000 }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: mockFsPromises.readdir,
    stat: mockFsPromises.stat,
  };
});

// Import the module under test after mocks are set up
// Note: We use dynamic import to ensure mocks are applied
const importVerifyAlbum = async () => {
  return import("./verify-album.js");
};

describe("verify-album conflict resolution integration", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;
  const defaultRange: CopyRange = { start: 1, end: 3, padWidth: 3 };

  const createVerifyOptions = (overrides: Partial<VerifyOptions> = {}): VerifyOptions => ({
    mode: { type: "album", range: defaultRange },
    tier: "quick",
    albumOnly: true,
    dryRun: false,
    workers: 1,
    fix: true,
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create temp directories for test isolation
    tempDir = await mkdtemp(join(tmpdir(), "verify-album-test-"));
    sourceDir = join(tempDir, "source", "Artist", "Album");
    destDir = join(tempDir, "dest");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destDir, { recursive: true });

    // Reset default mock implementations
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockFilesystem.copyOrLink.mockResolvedValue("copy" as const);
    mockFilesystem.remove.mockResolvedValue(undefined);
    mockFilesystem.normalizePathResolved.mockImplementation((p: string) => Promise.resolve(p));
    mockFilesystem.getFileSize.mockResolvedValue(10000);
    mockFilesystem.replaceFileWithValidatedStage.mockImplementation(async (_dest, callbacks) => {
      const signal = callbacks.signal ?? new AbortController().signal;
      await callbacks.materialize(`${_dest}.stage`, signal, stagedHandle);
      await callbacks.validate(`${_dest}.stage`, signal, stagedHandle);
    });
    mockConvert.convertFileWithValidation.mockImplementation(
      async (
        _source: string,
        destination: string,
        _format: string,
        options: ConversionValidationOptions,
      ) => {
        const signal = options.signal ?? new AbortController().signal;
        await options.additionalValidator?.(
          `${destination}.conversion-stage`,
          signal,
          stagedHandle,
        );
      },
    );
    mockPrompt.isInteractive.mockReturnValue(true);
    mockPrompt.confirm.mockResolvedValue(true);
    mockLogger.isJsonMode.mockReturnValue(false);
    mockVerify.verifyFileSize.mockResolvedValue(true);
    mockVerify.findExtraFiles.mockResolvedValue([]);
    mockTiered.verifyFileByTier.mockImplementation(async () => {
      if (!(await mockVerify.verifyFileSize())) {
        const [sourceStats, destinationStats] = await Promise.all([
          mockFsPromises.stat(),
          mockFsPromises.stat(),
        ]);
        return {
          status: "size-mismatch" as const,
          evidence: ["metadata"] as const,
          expectedSize: sourceStats.size,
          actualSize: destinationStats.size,
        };
      }
      return { status: "present" as const, evidence: ["metadata"] as const };
    });
    mockConflictResolver.shouldReportConflictsAsJson.mockReturnValue(false);
    mockSignalHandler._resetAbortController();

    // Default readdir returns audio files
    mockFsPromises.readdir.mockResolvedValue([
      { name: "track1.flac", isDirectory: () => false },
      { name: "track2.flac", isDirectory: () => false },
    ]);
    mockFsPromises.stat.mockResolvedValue({ size: 10000 });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("--conflict-strategy skip", () => {
    it("should skip size-mismatch files with skip strategy", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      // Setup size mismatch scenario - verifySize enabled and files have mismatched sizes
      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 }) // source size
        .mockResolvedValueOnce({ size: 5000 }); // dest size (mismatch)

      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "Artist", "Album-001", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "skip" as ConflictResolution,
        },
      ]);

      const options = createVerifyOptions({
        conflictStrategy: "skip",
        verifySize: true, // Enable size verification to trigger mismatch detection
      });

      await executeAlbumVerify(sourceDir, destDir, options);

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
      const { executeAlbumVerify } = await importVerifyAlbum();

      // Setup size mismatch scenario
      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.resolveConflictsByStrategy.mockResolvedValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "Artist", "Album-001", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
          success: true,
        },
      ]);

      const options = createVerifyOptions({
        conflictStrategy: "overwrite",
        verifySize: true, // Enable size verification to trigger mismatch detection
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // Should use decision-only function instead of resolveConflictsByStrategy
      expect(mockConflictResolver.chooseResolutionsByStrategy).toHaveBeenCalledWith(
        expect.any(Array),
        "overwrite",
      );
      // Should NOT call the old function that performs actions
      expect(mockConflictResolver.resolveConflictsByStrategy).not.toHaveBeenCalled();
    });
  });

  describe("--conflict-strategy rename", () => {
    it("refuses to create a renamed extra when the expected artifact remains mismatched", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const expectedPath = join(destDir, "Artist", "Album-001", "track1.flac");
      const renamedPath = join(destDir, "Artist", "Album-001", "track1-002.flac");
      mockTiered.verifyFileByTier.mockImplementation(async ({ destinationPath }) =>
        destinationPath === expectedPath
          ? {
              status: "size-mismatch" as const,
              evidence: ["metadata"] as const,
              expectedSize: 10,
              actualSize: 5,
            }
          : { status: "present" as const, evidence: ["metadata"] as const },
      );
      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: expectedPath,
            conflictType: {
              type: "size-mismatch",
              destPath: expectedPath,
              expected: 10,
              actual: 5,
            },
          },
          resolution: "rename",
          newPath: renamedPath,
        },
      ]);

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ conflictStrategy: "rename" }),
      );

      expect(mockFilesystem.replaceFileWithValidatedStage).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockConvert.convertFileWithValidation).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sizeMismatch: 1, extra: 0 });
      expect(result.fixResults).toMatchObject({
        copiedFiles: 0,
        repairedFiles: 0,
        refusedFiles: 1,
        remainingIssues: 1,
      });
    });
  });

  describe("extra files conflict resolution", () => {
    it("should remove extra files when strategy maps to remove", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      // Setup extra files scenario
      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        conflictStrategy: "overwrite", // Maps to 'remove' for extra files
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // Extra files should trigger conflict resolution for 'extra' type
      // Strategy 'overwrite' maps to 'remove' for extra files
      expect(mockFilesystem.remove).toHaveBeenCalled();
    });

    it("should keep extra files when strategy is skip", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      // Setup extra files scenario
      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        conflictStrategy: "skip", // Maps to 'keep' for extra files
      });

      const result = await executeAlbumVerify(sourceDir, destDir, options);

      // Extra files should be kept with skip strategy
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(result.expectedTotal).toBe(6);
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "extra" })]),
      );
    });
  });

  describe("interactive mode", () => {
    it("should use interactive resolution when no strategy and isInteractive", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockPrompt.isInteractive.mockReturnValue(true);
      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.resolveConflictInteractive.mockResolvedValue({
        resolution: "skip" as ConflictResolution,
        applyToAll: false,
      });

      const options = createVerifyOptions({
        conflictStrategy: "ask",
        verifySize: true, // Enable size verification to trigger mismatch detection
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // With 'ask' strategy and interactive mode, should use interactive resolution
      expect(mockConflictResolver.resolveConflictInteractive).toHaveBeenCalled();
    });

    it("should respect applyToAll selection from interactive mode", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockPrompt.isInteractive.mockReturnValue(true);
      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat.mockResolvedValue({ size: 5000 }); // All files have mismatched size

      // Simulate multiple size mismatches
      mockFsPromises.readdir.mockResolvedValue([
        { name: "track1.flac", isDirectory: () => false },
        { name: "track2.flac", isDirectory: () => false },
      ]);

      mockConflictResolver.resolveConflictInteractive.mockResolvedValueOnce({
        resolution: "overwrite" as ConflictResolution,
        applyToAll: true,
      });

      const options = createVerifyOptions({
        conflictStrategy: "ask",
        verifySize: true, // Enable size verification to trigger mismatch detection
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // First call should get the "apply to all" response
      expect(mockConflictResolver.resolveConflictInteractive).toHaveBeenCalled();
    });

    it("refuses an interactive rename without materializing another artifact", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const expectedPath = join(destDir, "Artist", "Album-001", "track1.flac");
      const renamedPath = join(destDir, "Artist", "Album-001", "track1-002.flac");
      mockTiered.verifyFileByTier.mockImplementation(async ({ destinationPath }) =>
        destinationPath === expectedPath
          ? {
              status: "size-mismatch" as const,
              evidence: ["metadata"] as const,
              expectedSize: 10,
              actualSize: 5,
            }
          : { status: "present" as const, evidence: ["metadata"] as const },
      );
      mockConflictResolver.generateUniquePath.mockReturnValue(renamedPath);
      mockConflictResolver.resolveConflictInteractive.mockResolvedValue({
        resolution: "rename",
        applyToAll: false,
      });

      const result = await executeAlbumVerify(sourceDir, destDir, createVerifyOptions());

      expect(mockFilesystem.replaceFileWithValidatedStage).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockConvert.convertFileWithValidation).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sizeMismatch: 1, extra: 0 });
      expect(result.fixResults).toMatchObject({
        copiedFiles: 0,
        repairedFiles: 0,
        refusedFiles: 1,
        remainingIssues: 1,
      });
    });
  });

  describe("non-interactive mode", () => {
    it("should warn when non-interactive without strategy", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockPrompt.isInteractive.mockReturnValue(false);
      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      const options = createVerifyOptions({
        verifySize: true, // Enable size verification to trigger mismatch detection
        // No conflictStrategy, no force
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // Should warn about needing --force or --conflict-strategy
      expect(mockLogger.logWarn).toHaveBeenCalledWith(expect.stringContaining("require"));
    });
  });

  describe("dry-run mode", () => {
    it("should report conflicts without resolving in dry-run mode", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      const options = createVerifyOptions({
        dryRun: true,
        conflictStrategy: "overwrite",
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // In dry-run mode, fix operations should not be executed
      // The actual fix logic is skipped when dryRun is true
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
    });
  });

  describe("--force backwards compatibility", () => {
    it("should treat --force as conflictStrategy overwrite", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      mockConflictResolver.resolveConflictsByStrategy.mockResolvedValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "Artist", "Album-001", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10000, actual: 5000 },
          },
          resolution: "overwrite" as ConflictResolution,
          success: true,
        },
      ]);

      const options = createVerifyOptions({
        force: true,
        verifySize: true, // Enable size verification to trigger mismatch detection
        // No explicit conflictStrategy - force should imply overwrite
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // --force should trigger strategy-based resolution with 'overwrite'
      expect(mockConflictResolver.chooseResolutionsByStrategy).toHaveBeenCalledWith(
        expect.any(Array),
        "overwrite",
      );
      // Should NOT call the old function that performs actions
      expect(mockConflictResolver.resolveConflictsByStrategy).not.toHaveBeenCalled();
    });

    it("should remove extra files with --force", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        force: true,
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // Extra files should be removed with --force
      expect(mockFilesystem.remove).toHaveBeenCalled();
    });

    it("should use trash when --force and --trash are combined", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockVerify.findExtraFiles.mockResolvedValue(["extra.txt"]);

      const options = createVerifyOptions({
        force: true,
        trash: true,
      });

      await executeAlbumVerify(sourceDir, destDir, options);

      // Extra files should be moved to trash with --trash
      expect(mockFilesystem.moveToTrash).toHaveBeenCalled();
    });
  });

  describe("conflict resolution tracking", () => {
    it("should track conflict resolutions in result", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      mockVerify.verifyFileSize.mockResolvedValue(false);
      mockFsPromises.stat
        .mockResolvedValueOnce({ size: 10000 })
        .mockResolvedValueOnce({ size: 5000 });

      const mockResolution = {
        context: {
          sourcePath: join(sourceDir, "track1.flac"),
          destPath: join(destDir, "Artist", "Album-001", "track1.flac"),
          conflictType: {
            type: "size-mismatch" as const,
            destPath: "",
            expected: 10000,
            actual: 5000,
          },
        },
        resolution: "skip" as ConflictResolution,
        success: true,
      };

      mockConflictResolver.resolveConflictsByStrategy.mockResolvedValue([mockResolution]);

      const options = createVerifyOptions({
        conflictStrategy: "skip",
        verifySize: true, // Enable size verification to trigger mismatch detection
      });

      const result = await executeAlbumVerify(sourceDir, destDir, options);

      // The fix results should contain conflict resolutions
      expect(result.fixResults?.conflictResolutions).toBeDefined();
    });
  });

  describe("missing artifact verification", () => {
    it("reports present, missing, mismatched, and extra artifacts without mutation", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const albumDest = join(destDir, "Artist", "Album-001");
      const missingDestination = join(albumDest, "track2.flac");

      mockFsPromises.readdir.mockResolvedValue([
        { name: "track1.flac", isDirectory: () => false },
        { name: "track2.flac", isDirectory: () => false },
        { name: "track3.flac", isDirectory: () => false },
      ]);
      mockFilesystem.pathExists.mockImplementation(async (candidate: string) => {
        return candidate !== missingDestination;
      });
      mockTiered.verifyFileByTier.mockImplementation(async ({ destinationPath }) => {
        if (destinationPath === join(albumDest, "track3.flac")) {
          return {
            status: "size-mismatch" as const,
            evidence: ["metadata"] as const,
            expectedSize: 10,
            actualSize: 5,
          };
        }
        return { status: "present" as const, evidence: ["metadata"] as const };
      });
      mockVerify.findExtraFiles.mockResolvedValue(["bonus.txt"]);

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(result).toMatchObject({
        verified: 1,
        missing: 1,
        sizeMismatch: 1,
        extra: 1,
        expectedTotal: 3,
      });
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: join("Album-001", "track2.flac"),
            sourcePath: join(sourceDir, "track2.flac"),
            status: "missing",
          }),
          expect.objectContaining({
            path: join("Album-001", "track3.flac"),
            sourcePath: join(sourceDir, "track3.flac"),
            status: "size-mismatch",
          }),
          expect.objectContaining({ path: join("Album-001", "bonus.txt"), status: "extra" }),
        ]),
      );
      expect(mockFilesystem.replaceFileWithValidatedStage).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(mockFilesystem.moveToTrash).not.toHaveBeenCalled();
    });

    it("counts a missing artifact as repaired only after staged and final re-observation", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const albumDest = join(destDir, "Artist", "Album-001");
      const sourceFile = join(sourceDir, "track1.flac");
      const destinationFile = join(albumDest, "track1.flac");
      let destinationObservations = 0;

      mockFsPromises.readdir.mockResolvedValue([{ name: "track1.flac", isDirectory: () => false }]);
      mockFilesystem.pathExists.mockImplementation(async (candidate: string) => {
        if (candidate === destinationFile) {
          destinationObservations++;
          return destinationObservations > 1;
        }
        return true;
      });
      mockTiered.verifyFileByTier.mockResolvedValue({
        status: "present",
        evidence: ["metadata"],
      });

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(mockFilesystem.replaceFileWithValidatedStage).toHaveBeenCalledWith(
        destinationFile,
        expect.objectContaining({
          materialize: expect.any(Function),
          validate: expect.any(Function),
        }),
      );
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
        sourceFile,
        stagedHandle,
        false,
        expect.any(AbortSignal),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePath: sourceFile,
          destinationPath: "/proc/self/fd/41",
        }),
        { authoritative: true },
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: sourceFile, destinationPath: destinationFile }),
      );
      expect(result).toMatchObject({
        verified: 1,
        missing: 0,
        expectedTotal: 1,
      });
      expect(result.fixResults).toMatchObject({
        copiedFiles: 1,
        repairedFiles: 1,
        reverifiedFiles: 1,
        remainingIssues: 0,
        failedFixes: [],
      });
    });

    it("keeps a repaired artifact unresolved when final verification fails", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const albumDest = join(destDir, "Artist", "Album-001");
      const destinationFile = join(albumDest, "track1.flac");
      let destinationObservations = 0;

      mockFsPromises.readdir.mockResolvedValue([{ name: "track1.flac", isDirectory: () => false }]);
      mockFilesystem.pathExists.mockImplementation(async (candidate: string) => {
        if (candidate === destinationFile) {
          destinationObservations++;
          return destinationObservations > 1;
        }
        return true;
      });
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({ status: "present", evidence: ["metadata"] })
        .mockResolvedValueOnce({ status: "missing", evidence: [] })
        .mockResolvedValueOnce({ status: "missing", evidence: [] });

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(mockFilesystem.replaceFileWithValidatedStage).toHaveBeenCalledTimes(1);
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ verified: 0, missing: 1, expectedTotal: 1 });
      expect(result.issues).toEqual([
        expect.objectContaining({ path: join("Album-001", "track1.flac"), status: "missing" }),
      ]);
      expect(result.fixResults).toMatchObject({
        copiedFiles: 0,
        repairedFiles: 0,
        reverifiedFiles: 0,
        remainingIssues: 1,
      });
      expect(result.fixResults?.failedFixes).toEqual([
        expect.objectContaining({
          path: join("Album-001", "track1.flac"),
          message: "Failed to copy: Repair failed final quick verification.",
        }),
      ]);
    });
  });

  describe("file-input lifecycle", () => {
    it("accepts a direct source when no file or CLI source entries are provided", async () => {
      const { executeAlbumVerifyWithFileInput } = await importVerifyAlbum();

      const result = await executeAlbumVerifyWithFileInput(
        sourceDir,
        destDir,
        createVerifyOptions({
          cliSourceEntries: undefined,
          configRange: { start: 1, end: 1, padWidth: 3 },
          fix: false,
        }),
      );

      expect(mockInputFile.readSourcePaths).not.toHaveBeenCalled();
      expect(result).toMatchObject({ source: sourceDir, verified: 2, expectedTotal: 2 });
      expect(mockSignalHandler.unregisterGlobalCleanup).toHaveBeenCalledWith("verify-album-abort");
    });

    it("applies per-path and config ranges while containing a failed source", async () => {
      const { executeAlbumVerifyWithFileInput } = await importVerifyAlbum();
      const perPathSource = join(tempDir, "source", "Artist One", "Album One");
      const configSource = join(tempDir, "source", "Artist Two", "Album Two");
      const missingSource = join(tempDir, "source", "Artist Three", "Album Three");
      const db = { close: vi.fn() };

      mockDb.openDatabaseReadOnly.mockReturnValue(db);
      mockFilesystem.pathExists.mockImplementation(async (candidate: string) => {
        return candidate !== missingSource;
      });
      mockFsPromises.readdir.mockResolvedValue([{ name: "track1.flac", isDirectory: () => false }]);
      mockTiered.verifyFileByTier.mockResolvedValue({
        status: "present",
        evidence: ["metadata"],
      });

      const result = await executeAlbumVerifyWithFileInput(
        undefined,
        destDir,
        createVerifyOptions({
          tier: "default",
          trackingDatabase: join(tempDir, "tracking.db"),
          configRange: { start: 3, end: 3, padWidth: 3 },
          cliSourceEntries: [
            { path: perPathSource, range: { start: 2, end: 2, padWidth: 3 } },
            { path: configSource },
            { path: missingSource, range: { start: 4, end: 4, padWidth: 3 } },
          ],
          fix: false,
        }),
      );

      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: join(destDir, "Artist One", "Album One-002", "track1.flac"),
        }),
      );
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: join(destDir, "Artist Two", "Album Two-003", "track1.flac"),
        }),
      );
      expect(result).toMatchObject({ verified: 2, expectedTotal: 2 });
      expect(result.failed).toEqual([
        expect.objectContaining({
          path: missingSource,
          message: `Source directory does not exist: ${missingSource}`,
        }),
      ]);
      expect(mockDb.openDatabaseReadOnly).toHaveBeenCalledTimes(1);
      expect(mockDb.getInventoryFingerprintCandidates).toHaveBeenCalledWith(db, [
        perPathSource,
        configSource,
        missingSource,
      ]);
      expect(mockDb.closeDatabase).toHaveBeenCalledTimes(1);
      expect(mockSignalHandler.registerGlobalCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ name: "verify-album-abort" }),
      );
      expect(mockSignalHandler.unregisterGlobalCleanup).toHaveBeenCalledWith("verify-album-abort");
    });

    it("reads file-backed sources and contains an entry with no effective range", async () => {
      const { executeAlbumVerifyWithFileInput } = await importVerifyAlbum();
      const rangedSource = join(tempDir, "source", "Artist One", "Album One");
      const noRangeSource = join(tempDir, "source", "Artist Two", "Album Two");
      const inputFile = join(tempDir, "albums.txt");
      mockInputFile.readSourcePaths.mockResolvedValueOnce([
        { path: rangedSource, range: { start: 7, end: 7, padWidth: 3 } },
        { path: noRangeSource },
      ]);
      mockFsPromises.readdir.mockResolvedValue([{ name: "track1.flac", isDirectory: () => false }]);

      const result = await executeAlbumVerifyWithFileInput(
        undefined,
        destDir,
        createVerifyOptions({
          file: inputFile,
          cliSourceEntries: undefined,
          cliRange: undefined,
          configRange: undefined,
          fix: false,
        }),
      );

      expect(mockInputFile.readSourcePaths).toHaveBeenCalledWith(inputFile);
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: join(destDir, "Artist One", "Album One-007", "track1.flac"),
        }),
      );
      expect(result).toMatchObject({ verified: 1, expectedTotal: 1 });
      expect(result.failed).toEqual([{ path: noRangeSource, message: "No range specified" }]);
      expect(mockSignalHandler.unregisterGlobalCleanup).toHaveBeenCalledWith("verify-album-abort");
    });

    it("rejects an empty file-backed source list before allocating evidence or cleanup", async () => {
      const { executeAlbumVerifyWithFileInput } = await importVerifyAlbum();
      const inputFile = join(tempDir, "empty.txt");
      mockInputFile.readSourcePaths.mockResolvedValueOnce([]);

      await expect(
        executeAlbumVerifyWithFileInput(
          undefined,
          destDir,
          createVerifyOptions({ file: inputFile, cliSourceEntries: undefined }),
        ),
      ).rejects.toThrow(`No source paths found in file: ${inputFile}`);

      expect(mockDb.openDatabaseReadOnly).not.toHaveBeenCalled();
      expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
    });
  });

  describe("artist-mode aggregation", () => {
    it("discovers sorted album directories and aggregates each album result", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const artistSource = join(tempDir, "source", "Artist");
      const albumA = join(artistSource, "Album A");
      const albumB = join(artistSource, "Album B");
      mockFsPromises.readdir.mockImplementation(async (candidate: string) => {
        if (candidate === artistSource) {
          return [
            { name: "Album B", isDirectory: () => true },
            { name: "cover.jpg", isDirectory: () => false },
            { name: "Album A", isDirectory: () => true },
          ];
        }
        return [{ name: "track.flac", isDirectory: () => false }];
      });

      const result = await executeAlbumVerify(
        artistSource,
        destDir,
        createVerifyOptions({
          albumOnly: false,
          fix: false,
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(mockProgress.withSpinner).toHaveBeenCalledWith(
        "Scanning albums in Artist",
        expect.any(Function),
      );
      expect(
        mockTiered.verifyFileByTier.mock.calls.map(([input]) => input.destinationPath),
      ).toEqual([
        join(destDir, "Artist", "Album A-001", "track.flac"),
        join(destDir, "Artist", "Album B-001", "track.flac"),
      ]);
      expect(result).toMatchObject({ verified: 2, expectedTotal: 2, failed: [] });
      expect(mockFilesystem.normalizePathResolved).toHaveBeenCalledWith(albumA);
      expect(mockFilesystem.normalizePathResolved).toHaveBeenCalledWith(albumB);
    });

    it("returns an empty aggregate when artist discovery finds no album directories", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const artistSource = join(tempDir, "source", "Empty Artist");
      mockFsPromises.readdir.mockResolvedValueOnce([
        { name: "cover.jpg", isDirectory: () => false },
      ]);

      const result = await executeAlbumVerify(
        artistSource,
        destDir,
        createVerifyOptions({
          albumOnly: false,
          fix: false,
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(result).toEqual({
        source: artistSource,
        tier: "quick",
        verified: 0,
        missing: 0,
        failed: [],
        issues: [],
        sizeMismatch: 0,
        hashMismatch: 0,
        contentMismatch: 0,
        metadataMismatch: 0,
        unstable: 0,
        unverifiable: 0,
        extra: 0,
        notApplicable: 0,
        expectedTotal: 0,
      });
      expect(mockTiered.verifyFileByTier).not.toHaveBeenCalled();
    });
  });

  describe("tiered verification integration", () => {
    it("contains an unreadable album directory as a structured verification failure", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
      mockFsPromises.readdir.mockRejectedValueOnce(readError);

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          fix: false,
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(result).toMatchObject({ verified: 0, expectedTotal: 0 });
      expect(result.failed).toEqual([
        {
          path: sourceDir,
          message: "Cannot read source directory: permission denied",
          code: "EACCES",
        },
      ]);
      expect(mockTiered.verifyFileByTier).not.toHaveBeenCalled();
    });

    it("keeps quick verification independent of the tracking database", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();

      const signal = new AbortController().signal;
      await executeAlbumVerify(sourceDir, destDir, createVerifyOptions({ fix: false }), signal);

      expect(mockDb.openDatabaseReadOnly).not.toHaveBeenCalled();
      expect(mockDb.getInventoryFingerprintCandidates).not.toHaveBeenCalled();
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "quick", signal }),
      );
    });

    it("opens and preloads the read-only database once for a content-tier batch", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const db = { close: vi.fn() };
      const candidates = [{ id: 1 }];
      mockDb.openDatabaseReadOnly.mockReturnValue(db);
      mockDb.getInventoryFingerprintCandidates.mockReturnValue(candidates);

      await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          tier: "default",
          trackingDatabase: join(tempDir, "tracking.db"),
          fix: false,
        }),
      );

      expect(mockDb.openDatabaseReadOnly).toHaveBeenCalledTimes(1);
      expect(mockDb.getInventoryFingerprintCandidates).toHaveBeenCalledWith(db, [sourceDir]);
      expect(mockDb.closeDatabase).toHaveBeenCalledTimes(1);
      expect(mockTiered.resolveFingerprintCandidate).toHaveBeenCalledWith(
        candidates,
        expect.objectContaining({
          sourcePath: sourceDir,
          relativePath: "track1.flac",
          convertKey: null,
        }),
      );
    });

    it("closes read-only evidence when fingerprint preload fails", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const db = { close: vi.fn() };
      mockDb.openDatabaseReadOnly.mockReturnValue(db);
      mockDb.getInventoryFingerprintCandidates.mockImplementationOnce(() => {
        throw new Error("evidence load failed");
      });

      await expect(
        executeAlbumVerify(
          sourceDir,
          destDir,
          createVerifyOptions({
            tier: "default",
            trackingDatabase: join(tempDir, "tracking.db"),
            fix: false,
          }),
        ),
      ).rejects.toThrow("evidence load failed");

      expect(mockDb.closeDatabase).toHaveBeenCalledOnce();
      expect(mockDb.closeDatabase).toHaveBeenCalledWith(db);
      expect(mockParallel.processInParallel).not.toHaveBeenCalled();
    });

    it("aggregates converted deep verification as successful hash coverage with byte checks not applicable", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const db = { close: vi.fn() };
      mockDb.openDatabaseReadOnly.mockReturnValue(db);
      mockConvert.shouldConvert.mockReturnValue(true);
      mockTiered.verifyFileByTier.mockResolvedValue({
        status: "present",
        evidence: ["hash"],
        notApplicableReason: "conversion-byte-compare",
      });

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          tier: "deep",
          trackingDatabase: join(tempDir, "tracking.db"),
          convertFormat: "alac",
          fix: false,
        }),
      );

      expect(result.verified).toBe(6);
      expect(result.notApplicable).toBe(6);
      expect(result.expectedTotal).toBe(6);
    });

    it("contains per-file operational failures without aborting the album batch", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      mockTiered.verifyFileByTier
        .mockRejectedValueOnce(Object.assign(new Error("read failed"), { code: "EIO" }))
        .mockResolvedValue({ status: "present", evidence: ["metadata"] });

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ fix: false }),
      );

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ message: "read failed", code: "EIO" });
      expect(result.expectedTotal).toBe(6);
    });

    it("contains a parallel worker failure and closes loaded evidence", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const db = { close: vi.fn() };
      const workerError = Object.assign(new Error("worker failed"), { code: "EIO" });
      mockDb.openDatabaseReadOnly.mockReturnValue(db);
      mockParallel.processInParallel.mockResolvedValueOnce([
        { success: false, error: workerError, index: 0 },
      ]);

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          tier: "default",
          trackingDatabase: join(tempDir, "tracking.db"),
          fix: false,
          mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        }),
      );

      expect(result.failed).toEqual([
        {
          path: join(destDir, "Artist", "Album-001"),
          message: "worker failed",
          code: "EIO",
        },
      ]);
      expect(mockDb.closeDatabase).toHaveBeenCalledOnce();
      expect(mockDb.closeDatabase).toHaveBeenCalledWith(db);
    });

    it("stages an authorized repair and derives final counts from tier re-verification", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      mockTiered.verifyFileByTier
        .mockResolvedValueOnce({
          status: "size-mismatch",
          evidence: ["metadata"],
          expectedSize: 10,
          actualSize: 5,
        })
        .mockResolvedValue({ status: "present", evidence: ["metadata"] });
      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath: join(sourceDir, "track1.flac"),
            destPath: join(destDir, "Artist", "Album-001", "track1.flac"),
            conflictType: { type: "size-mismatch", destPath: "", expected: 10, actual: 5 },
          },
          resolution: "overwrite",
        },
      ]);

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({ force: true }),
      );

      expect(mockFilesystem.replaceFileWithValidatedStage).toHaveBeenCalledTimes(1);
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
        join(sourceDir, "track1.flac"),
        stagedHandle,
        false,
        expect.any(AbortSignal),
      );
      expect(mockFilesystem.createOpenFileVerificationTarget).toHaveBeenCalledWith(stagedHandle);
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({ destinationPath: "/proc/self/fd/41" }),
        { authoritative: true },
      );
      expect(result.sizeMismatch).toBe(0);
      expect(result.fixResults).toMatchObject({
        repairedFiles: 1,
        reverifiedFiles: 1,
        remainingIssues: 0,
      });
    });

    it("keeps successful deep conversion coverage complete after repair re-verification", async () => {
      const { executeAlbumVerify } = await importVerifyAlbum();
      const db = { close: vi.fn() };
      const sourcePath = join(sourceDir, "track1.flac");
      const destinationPath = join(destDir, "Artist", "Album-001", "track1.flac");
      mockDb.openDatabaseReadOnly.mockReturnValue(db);
      mockConvert.shouldConvert.mockReturnValue(true);
      mockTiered.resolveFingerprintCandidate.mockReturnValue({
        status: "found",
        fingerprint: { content_hash: "a".repeat(64) },
      });

      let verificationCall = 0;
      mockTiered.verifyFileByTier.mockImplementation(async () => {
        verificationCall++;
        if (verificationCall === 1) {
          return { status: "hash-mismatch" as const, evidence: ["hash"] as const };
        }
        return {
          status: "present" as const,
          evidence: ["hash"] as const,
          notApplicableReason: "conversion-byte-compare" as const,
        };
      });
      mockConflictResolver.chooseResolutionsByStrategy.mockReturnValue([
        {
          context: {
            sourcePath,
            destPath: destinationPath,
            conflictType: { type: "size-mismatch", destPath: "", expected: 10, actual: 5 },
          },
          resolution: "overwrite",
        },
      ]);

      const result = await executeAlbumVerify(
        sourceDir,
        destDir,
        createVerifyOptions({
          tier: "deep",
          trackingDatabase: join(tempDir, "tracking.db"),
          convertFormat: "alac",
          force: true,
        }),
      );

      expect(result).toMatchObject({
        verified: 6,
        notApplicable: 6,
        hashMismatch: 0,
      });
      expect(result.fixResults).toMatchObject({
        repairedFiles: 1,
        refusedFiles: 0,
        remainingIssues: 0,
      });
      expect(mockConvert.convertFileWithValidation).toHaveBeenCalledTimes(1);
      expect(mockConvert.convertFileWithValidation).toHaveBeenCalledWith(
        sourcePath,
        destinationPath,
        "alac",
        expect.objectContaining({ additionalValidator: expect.any(Function) }),
      );
      expect(mockFilesystem.replaceFileWithValidatedStage).not.toHaveBeenCalled();
      expect(mockTiered.verifyFileByTier).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: "/proc/self/fd/41",
          converted: true,
          tier: "deep",
        }),
        expect.objectContaining({ authoritative: true }),
      );
      expect(mockFilesystem.createOpenFileVerificationTarget).toHaveBeenCalledWith(stagedHandle);
      expect(mockLogger.logSuccess).toHaveBeenCalledWith("Status: COMPLETE");
    });
  });
});
