/**
 * Tests for conflict-resolver.ts - conflict detection and resolution utilities.
 *
 * These tests verify:
 * - detectConflict() - file exists, size mismatch, no conflict cases
 * - generateUniquePath() - suffix generation, collision handling
 * - resolveConflictInteractive() - mock selectOption(), test all choices
 * - applyResolution() - skip (no-op), overwrite (copy), rename (copy to new path)
 * - resolveConflictsByStrategy() - batch processing with each strategy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConflictContext, ConflictResolution, ConflictStrategy } from "../types/conflict.js";

// Step 1: Define mocks with vi.hoisted()
const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(false),
  copyOrLink: vi.fn().mockResolvedValue("copy" as const),
  remove: vi.fn().mockResolvedValue(undefined),
  getFileSize: vi.fn().mockResolvedValue(1000),
}));

const mockPrompt = vi.hoisted(() => ({
  selectOption: vi.fn().mockResolvedValue("skip" as ConflictResolution),
  isInteractive: vi.fn().mockReturnValue(true),
}));

const mockLogger = vi.hoisted(() => ({
  isJsonMode: vi.fn().mockReturnValue(false),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

const mockSignalHandler = vi.hoisted(() => {
  const abortController = new AbortController();
  return {
    getGlobalSignal: vi.fn().mockReturnValue(abortController.signal),
    _abortController: abortController,
    _resetAbortController: () => {
      const newController = new AbortController();
      mockSignalHandler._abortController = newController;
      mockSignalHandler.getGlobalSignal.mockReturnValue(newController.signal);
      return newController;
    },
  };
});

// Step 2: Apply mocks to modules
vi.mock("./filesystem.js", () => ({
  pathExists: mockFilesystem.pathExists,
  copyOrLink: mockFilesystem.copyOrLink,
  remove: mockFilesystem.remove,
  getFileSize: mockFilesystem.getFileSize,
}));

vi.mock("./prompt.js", () => ({
  selectOption: mockPrompt.selectOption,
  isInteractive: mockPrompt.isInteractive,
}));

vi.mock("./logger.js", () => ({
  isJsonMode: mockLogger.isJsonMode,
  logDebug: mockLogger.logDebug,
  logWarn: mockLogger.logWarn,
}));

vi.mock("./signal-handler.js", () => ({
  getGlobalSignal: mockSignalHandler.getGlobalSignal,
}));

// Import the module under test after mocks are set up
import {
  detectConflict,
  generateUniquePath,
  generateUniquePathForConflict,
  resolveConflictInteractive,
  applyResolution,
  resolveConflictsByStrategy,
} from "./conflict-resolver.js";

describe("detectConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock implementations
    mockFilesystem.pathExists.mockResolvedValue(false);
    mockFilesystem.getFileSize.mockResolvedValue(1000);
  });

  it("should return null when destination does not exist", async () => {
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await detectConflict("/source/file.flac", "/dest/file.flac");

    expect(result).toBeNull();
    expect(mockFilesystem.pathExists).toHaveBeenCalledWith("/dest/file.flac");
  });

  it("should return exists conflict when destination exists", async () => {
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockFilesystem.getFileSize.mockResolvedValue(5000);

    const result = await detectConflict("/source/file.flac", "/dest/file.flac");

    expect(result).not.toBeNull();
    expect(result?.conflictType.type).toBe("exists");
    if (result?.conflictType.type === "exists") {
      expect(result.conflictType.destPath).toBe("/dest/file.flac");
      expect(result.conflictType.destSize).toBe(5000);
    }
    expect(result?.sourcePath).toBe("/source/file.flac");
    expect(result?.destPath).toBe("/dest/file.flac");
  });

  it("should return size-mismatch conflict when sizes differ and checkSize is true", async () => {
    mockFilesystem.pathExists.mockResolvedValue(true);
    // First call for destSize, second call for sourceSize
    mockFilesystem.getFileSize
      .mockResolvedValueOnce(5000) // dest size
      .mockResolvedValueOnce(10000); // source size

    const result = await detectConflict("/source/file.flac", "/dest/file.flac", {
      checkSize: true,
    });

    expect(result).not.toBeNull();
    expect(result?.conflictType.type).toBe("size-mismatch");
    if (result?.conflictType.type === "size-mismatch") {
      expect(result.conflictType.expected).toBe(10000);
      expect(result.conflictType.actual).toBe(5000);
    }
    expect(result?.sourceSize).toBe(10000);
    expect(result?.destSize).toBe(5000);
  });

  it("should return exists conflict when sizes match and checkSize is true", async () => {
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockFilesystem.getFileSize.mockResolvedValue(5000); // Same size for both

    const result = await detectConflict("/source/file.flac", "/dest/file.flac", {
      checkSize: true,
    });

    expect(result).not.toBeNull();
    expect(result?.conflictType.type).toBe("exists");
    expect(result?.sourceSize).toBe(5000);
    expect(result?.destSize).toBe(5000);
  });

  it("should handle error when getting destination size", async () => {
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockFilesystem.getFileSize.mockRejectedValue(new Error("EACCES"));

    const result = await detectConflict("/source/file.flac", "/dest/file.flac");

    expect(result).not.toBeNull();
    expect(result?.conflictType.type).toBe("exists");
    if (result?.conflictType.type === "exists") {
      expect(result.conflictType.destSize).toBeUndefined();
    }
    expect(result?.destSize).toBeUndefined();
  });

  it("should fall back to exists conflict when source size cannot be read", async () => {
    mockFilesystem.pathExists.mockResolvedValue(true);
    mockFilesystem.getFileSize
      .mockResolvedValueOnce(5000) // dest size
      .mockRejectedValueOnce(new Error("EACCES")); // source size fails

    const result = await detectConflict("/source/file.flac", "/dest/file.flac", {
      checkSize: true,
    });

    expect(result).not.toBeNull();
    // Falls back to exists since we can't determine size mismatch
    expect(result?.conflictType.type).toBe("exists");
    expect(result?.sourceSize).toBeUndefined();
  });
});

describe("generateUniquePath", () => {
  it("should return original path for first occurrence", () => {
    const usedNames = new Map<string, number>();

    const result = generateUniquePath("/dest/album/track.flac", usedNames);

    expect(result).toBe("/dest/album/track.flac");
    expect(usedNames.get("track.flac")).toBe(2);
  });

  it("should add -002 suffix for second occurrence", () => {
    const usedNames = new Map<string, number>();
    usedNames.set("track.flac", 2);

    const result = generateUniquePath("/dest/album/track.flac", usedNames);

    expect(result).toBe("/dest/album/track-002.flac");
    expect(usedNames.get("track.flac")).toBe(3);
  });

  it("should increment suffix for subsequent occurrences", () => {
    const usedNames = new Map<string, number>();

    const path1 = generateUniquePath("/dest/track.flac", usedNames);
    const path2 = generateUniquePath("/dest/track.flac", usedNames);
    const path3 = generateUniquePath("/dest/track.flac", usedNames);

    expect(path1).toBe("/dest/track.flac");
    expect(path2).toBe("/dest/track-002.flac");
    expect(path3).toBe("/dest/track-003.flac");
  });

  it("should use case-insensitive matching", () => {
    const usedNames = new Map<string, number>();

    const path1 = generateUniquePath("/dest/Track.flac", usedNames);
    const path2 = generateUniquePath("/dest/track.flac", usedNames);
    const path3 = generateUniquePath("/dest/TRACK.flac", usedNames);

    expect(path1).toBe("/dest/Track.flac");
    expect(path2).toBe("/dest/track-002.flac");
    expect(path3).toBe("/dest/TRACK-003.flac");
  });

  it("should handle files with multiple dots in name", () => {
    const usedNames = new Map<string, number>();

    const path1 = generateUniquePath("/dest/my.track.name.flac", usedNames);
    const path2 = generateUniquePath("/dest/my.track.name.flac", usedNames);

    expect(path1).toBe("/dest/my.track.name.flac");
    expect(path2).toBe("/dest/my.track.name-002.flac");
  });

  it("should handle files without extension", () => {
    const usedNames = new Map<string, number>();

    const path1 = generateUniquePath("/dest/README", usedNames);
    const path2 = generateUniquePath("/dest/README", usedNames);

    expect(path1).toBe("/dest/README");
    expect(path2).toBe("/dest/README-002");
  });

  it("should handle deep directory paths", () => {
    const usedNames = new Map<string, number>();

    const result = generateUniquePath("/a/b/c/d/track.mp3", usedNames);

    expect(result).toBe("/a/b/c/d/track.mp3");
  });

  it("should track different filenames separately", () => {
    const usedNames = new Map<string, number>();

    const path1 = generateUniquePath("/dest/track1.flac", usedNames);
    const path2 = generateUniquePath("/dest/track2.flac", usedNames);
    const path3 = generateUniquePath("/dest/track1.flac", usedNames);
    const path4 = generateUniquePath("/dest/track2.flac", usedNames);

    expect(path1).toBe("/dest/track1.flac");
    expect(path2).toBe("/dest/track2.flac");
    expect(path3).toBe("/dest/track1-002.flac");
    expect(path4).toBe("/dest/track2-002.flac");
  });
});

describe("generateUniquePathForConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFilesystem.pathExists.mockResolvedValue(false);
  });

  it("should always add suffix (never return original path)", async () => {
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await generateUniquePathForConflict("/dest/track.flac");

    expect(result).toBe("/dest/track-002.flac");
    expect(mockFilesystem.pathExists).toHaveBeenCalledWith("/dest/track-002.flac");
  });

  it("should skip existing suffixes until finding free path", async () => {
    // Simulate -002 and -003 already exist
    mockFilesystem.pathExists
      .mockResolvedValueOnce(true) // track-002.flac exists
      .mockResolvedValueOnce(true) // track-003.flac exists
      .mockResolvedValueOnce(false); // track-004.flac is free

    const result = await generateUniquePathForConflict("/dest/track.flac");

    expect(result).toBe("/dest/track-004.flac");
    expect(mockFilesystem.pathExists).toHaveBeenCalledTimes(3);
  });

  it("should handle case-insensitive filesystems", async () => {
    mockFilesystem.pathExists.mockResolvedValue(false);

    const result = await generateUniquePathForConflict("/dest/Track.flac");

    // Should preserve original case in output
    expect(result).toBe("/dest/Track-002.flac");
  });

  it("should throw error after 999 attempts", async () => {
    // Simulate all paths taken
    mockFilesystem.pathExists.mockResolvedValue(true);

    await expect(generateUniquePathForConflict("/dest/track.flac")).rejects.toThrow(
      /Could not generate unique path.*after 999 attempts/,
    );
  });
});

describe("resolveConflictInteractive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrompt.isInteractive.mockReturnValue(true);
    mockLogger.isJsonMode.mockReturnValue(false);
    mockSignalHandler._resetAbortController();
  });

  const createConflictContext = (
    type: "exists" | "size-mismatch" | "extra" = "exists",
  ): ConflictContext => {
    if (type === "exists") {
      return {
        sourcePath: "/source/file.flac",
        destPath: "/dest/file.flac",
        conflictType: { type: "exists", destPath: "/dest/file.flac", destSize: 5000 },
        sourceSize: 5000,
        destSize: 5000,
      };
    } else if (type === "size-mismatch") {
      return {
        sourcePath: "/source/file.flac",
        destPath: "/dest/file.flac",
        conflictType: {
          type: "size-mismatch",
          destPath: "/dest/file.flac",
          expected: 10000,
          actual: 5000,
        },
        sourceSize: 10000,
        destSize: 5000,
      };
    } else {
      return {
        sourcePath: "",
        destPath: "/dest/extra.flac",
        conflictType: { type: "extra", destPath: "/dest/extra.flac", size: 3000 },
        destSize: 3000,
      };
    }
  };

  it("should throw error when not interactive", async () => {
    mockPrompt.isInteractive.mockReturnValue(false);

    const context = createConflictContext();

    await expect(resolveConflictInteractive(context)).rejects.toThrow(
      "Interactive conflict resolution requires a TTY terminal",
    );
  });

  it("should throw error in JSON mode", async () => {
    mockLogger.isJsonMode.mockReturnValue(true);

    const context = createConflictContext();

    await expect(resolveConflictInteractive(context)).rejects.toThrow(
      "Interactive conflict resolution cannot be used with --json output",
    );
  });

  it("should throw error when operation is aborted", async () => {
    const controller = mockSignalHandler._resetAbortController();
    controller.abort();

    const context = createConflictContext();

    await expect(resolveConflictInteractive(context)).rejects.toThrow("Operation aborted");
  });

  it("should return previously chosen resolution from applyToAll", async () => {
    const context = createConflictContext();
    const applyToAll = new Map<string, ConflictResolution>();
    applyToAll.set("exists", "overwrite");

    const result = await resolveConflictInteractive(context, { applyToAll });

    expect(result.resolution).toBe("overwrite");
    expect(result.applyToAll).toBe(false);
    expect(mockPrompt.selectOption).not.toHaveBeenCalled();
  });

  it("should prompt user and return skip resolution", async () => {
    mockPrompt.selectOption.mockResolvedValue("skip");

    const context = createConflictContext();
    const result = await resolveConflictInteractive(context);

    expect(result.resolution).toBe("skip");
    expect(result.applyToAll).toBe(false);
    expect(mockPrompt.selectOption).toHaveBeenCalled();
  });

  it("should prompt user and return overwrite resolution", async () => {
    mockPrompt.selectOption.mockResolvedValue("overwrite");

    const context = createConflictContext();
    const result = await resolveConflictInteractive(context);

    expect(result.resolution).toBe("overwrite");
    expect(result.applyToAll).toBe(false);
  });

  it("should prompt user and return rename resolution", async () => {
    mockPrompt.selectOption.mockResolvedValue("rename");

    const context = createConflictContext();
    const result = await resolveConflictInteractive(context);

    expect(result.resolution).toBe("rename");
    expect(result.applyToAll).toBe(false);
  });

  it("should handle apply-all selection with secondary prompt", async () => {
    // First call returns 'apply-all', second returns the actual resolution
    mockPrompt.selectOption.mockResolvedValueOnce("apply-all").mockResolvedValueOnce("overwrite");

    const context = createConflictContext();
    const result = await resolveConflictInteractive(context);

    expect(result.resolution).toBe("overwrite");
    expect(result.applyToAll).toBe(true);
    expect(mockPrompt.selectOption).toHaveBeenCalledTimes(2);
  });

  it("should handle extra file conflicts with keep/remove options", async () => {
    mockPrompt.selectOption.mockResolvedValue("remove");

    const context = createConflictContext("extra");
    const result = await resolveConflictInteractive(context);

    expect(result.resolution).toBe("remove");
    expect(result.applyToAll).toBe(false);
  });

  it("should handle keep resolution for extra files", async () => {
    mockPrompt.selectOption.mockResolvedValue("keep");

    const context = createConflictContext("extra");
    const result = await resolveConflictInteractive(context);

    expect(result.resolution).toBe("keep");
  });
});

describe("applyResolution", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "conflict-test-"));
    mockFilesystem.copyOrLink.mockResolvedValue("copy" as const);
    mockFilesystem.remove.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const createContext = (
    type: "exists" | "size-mismatch" | "extra" = "exists",
  ): ConflictContext => {
    const sourcePath = join(tempDir, "source", "file.flac");
    const destPath = join(tempDir, "dest", "file.flac");

    if (type === "exists") {
      return {
        sourcePath,
        destPath,
        conflictType: { type: "exists", destPath, destSize: 5000 },
        sourceSize: 5000,
        destSize: 5000,
      };
    } else if (type === "size-mismatch") {
      return {
        sourcePath,
        destPath,
        conflictType: {
          type: "size-mismatch",
          destPath,
          expected: 10000,
          actual: 5000,
        },
        sourceSize: 10000,
        destSize: 5000,
      };
    } else {
      return {
        sourcePath: "",
        destPath: join(tempDir, "dest", "extra.flac"),
        conflictType: {
          type: "extra",
          destPath: join(tempDir, "dest", "extra.flac"),
          size: 3000,
        },
        destSize: 3000,
      };
    }
  };

  describe("skip resolution", () => {
    it("should return success without any action", async () => {
      const context = createContext();

      const result = await applyResolution(context, "skip");

      expect(result.success).toBe(true);
      expect(result.resolution).toBe("skip");
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
    });
  });

  describe("keep resolution", () => {
    it("should return success without any action", async () => {
      const context = createContext("extra");

      const result = await applyResolution(context, "keep");

      expect(result.success).toBe(true);
      expect(result.resolution).toBe("keep");
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
    });
  });

  describe("overwrite resolution", () => {
    it("should remove existing and copy source", async () => {
      const context = createContext();

      const result = await applyResolution(context, "overwrite");

      expect(result.success).toBe(true);
      expect(result.resolution).toBe("overwrite");
      expect(mockFilesystem.remove).toHaveBeenCalledWith(context.destPath);
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
        context.sourcePath,
        context.destPath,
        false,
      );
    });

    it("should use hardlink when specified", async () => {
      const context = createContext();

      const result = await applyResolution(context, "overwrite", { hardlink: true });

      expect(result.success).toBe(true);
      expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
        context.sourcePath,
        context.destPath,
        true,
      );
    });

    it("should not actually copy in dry-run mode", async () => {
      const context = createContext();

      const result = await applyResolution(context, "overwrite", { dryRun: true });

      expect(result.success).toBe(true);
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
      expect(mockLogger.logDebug).toHaveBeenCalled();
    });

    it("should handle copy errors", async () => {
      mockFilesystem.copyOrLink.mockRejectedValue(new Error("Permission denied"));
      const context = createContext();

      const result = await applyResolution(context, "overwrite");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permission denied");
    });
  });

  describe("rename resolution", () => {
    it("should always add suffix to avoid overwriting conflicting file", async () => {
      const context = createContext();
      mockFilesystem.pathExists.mockResolvedValue(false);

      const result = await applyResolution(context, "rename");

      expect(result.success).toBe(true);
      expect(result.resolution).toBe("rename");
      // Should generate -002 suffix (not return original path that already exists)
      expect(result.newPath).toContain("-002.flac");
      expect(mockFilesystem.pathExists).toHaveBeenCalled();
      expect(mockFilesystem.copyOrLink).toHaveBeenCalled();
    });

    it("should skip existing suffixes until finding free path", async () => {
      const context = createContext();
      // Simulate -002 already exists, -003 is free
      mockFilesystem.pathExists
        .mockResolvedValueOnce(true) // -002 exists
        .mockResolvedValueOnce(false); // -003 is free

      const result = await applyResolution(context, "rename");

      expect(result.success).toBe(true);
      expect(result.newPath).toContain("-003.flac");
    });

    it("should not actually copy in dry-run mode", async () => {
      const context = createContext();
      mockFilesystem.pathExists.mockResolvedValue(false);

      const result = await applyResolution(context, "rename", { dryRun: true });

      expect(result.success).toBe(true);
      expect(result.newPath).toBeDefined();
      expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    });
  });

  describe("remove resolution", () => {
    it("should remove extra files", async () => {
      const context = createContext("extra");

      const result = await applyResolution(context, "remove");

      expect(result.success).toBe(true);
      expect(result.resolution).toBe("remove");
      expect(mockFilesystem.remove).toHaveBeenCalledWith(context.destPath);
    });

    it("should fail for non-extra conflicts", async () => {
      const context = createContext("exists");

      const result = await applyResolution(context, "remove");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Remove resolution is only valid for extra file conflicts");
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
    });

    it("should not actually remove in dry-run mode", async () => {
      const context = createContext("extra");

      const result = await applyResolution(context, "remove", { dryRun: true });

      expect(result.success).toBe(true);
      expect(mockFilesystem.remove).not.toHaveBeenCalled();
    });

    it("should handle remove errors", async () => {
      mockFilesystem.remove.mockRejectedValue(new Error("File in use"));
      const context = createContext("extra");

      const result = await applyResolution(context, "remove");

      expect(result.success).toBe(false);
      expect(result.error).toBe("File in use");
    });
  });
});

describe("resolveConflictsByStrategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFilesystem.copyOrLink.mockResolvedValue("copy" as const);
    mockFilesystem.remove.mockResolvedValue(undefined);
    mockSignalHandler._resetAbortController();
  });

  const createConflicts = (count: number): ConflictContext[] => {
    return Array.from({ length: count }, (_, i) => ({
      sourcePath: `/source/file${i}.flac`,
      destPath: `/dest/file${i}.flac`,
      conflictType: {
        type: "exists" as const,
        destPath: `/dest/file${i}.flac`,
        destSize: 5000,
      },
      sourceSize: 5000,
      destSize: 5000,
    }));
  };

  it("should throw error for ask strategy", async () => {
    const conflicts = createConflicts(1);

    await expect(resolveConflictsByStrategy(conflicts, "ask")).rejects.toThrow(
      'Strategy "ask" requires interactive mode',
    );
  });

  it("should apply skip strategy to all conflicts", async () => {
    const conflicts = createConflicts(3);

    const results = await resolveConflictsByStrategy(conflicts, "skip");

    expect(results.length).toBe(3);
    results.forEach((result) => {
      expect(result.success).toBe(true);
      expect(result.resolution).toBe("skip");
    });
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });

  it("should apply overwrite strategy to all conflicts", async () => {
    const conflicts = createConflicts(3);

    const results = await resolveConflictsByStrategy(conflicts, "overwrite");

    expect(results.length).toBe(3);
    results.forEach((result) => {
      expect(result.success).toBe(true);
      expect(result.resolution).toBe("overwrite");
    });
    expect(mockFilesystem.remove).toHaveBeenCalledTimes(3);
    expect(mockFilesystem.copyOrLink).toHaveBeenCalledTimes(3);
  });

  it("should apply rename strategy with unique paths", async () => {
    const conflicts = createConflicts(3);
    mockFilesystem.pathExists.mockResolvedValue(false);

    const results = await resolveConflictsByStrategy(conflicts, "rename");

    expect(results.length).toBe(3);
    results.forEach((result) => {
      expect(result.success).toBe(true);
      expect(result.resolution).toBe("rename");
      expect(result.newPath).toBeDefined();
      // All files get -002 suffix since they have different base names (file0, file1, file2)
      expect(result.newPath).toContain("-002.flac");
    });
  });

  it("should handle dry-run mode", async () => {
    const conflicts = createConflicts(3);

    const results = await resolveConflictsByStrategy(conflicts, "overwrite", {
      dryRun: true,
    });

    expect(results.length).toBe(3);
    results.forEach((result) => {
      expect(result.success).toBe(true);
    });
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
    expect(mockFilesystem.remove).not.toHaveBeenCalled();
  });

  it("should handle hardlink option", async () => {
    const conflicts = createConflicts(2);

    await resolveConflictsByStrategy(conflicts, "overwrite", { hardlink: true });

    expect(mockFilesystem.copyOrLink).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      true,
    );
  });

  it("should stop processing when aborted", async () => {
    const conflicts = createConflicts(5);
    const controller = mockSignalHandler._resetAbortController();

    // Abort after first call to copyOrLink
    mockFilesystem.copyOrLink.mockImplementation(async () => {
      controller.abort();
      return "copy" as const;
    });

    const results = await resolveConflictsByStrategy(conflicts, "overwrite");

    expect(results.length).toBe(5);
    // First one succeeds, rest are aborted
    expect(results[0]?.success).toBe(true);
    for (let i = 1; i < 5; i++) {
      expect(results[i]?.success).toBe(false);
      expect(results[i]?.error).toBe("Operation aborted");
    }
  });

  it("should use keep for extra files with inapplicable strategies", async () => {
    const extraConflicts: ConflictContext[] = [
      {
        sourcePath: "",
        destPath: "/dest/extra1.flac",
        conflictType: { type: "extra", destPath: "/dest/extra1.flac", size: 3000 },
        destSize: 3000,
      },
      {
        sourcePath: "",
        destPath: "/dest/extra2.flac",
        conflictType: { type: "extra", destPath: "/dest/extra2.flac", size: 4000 },
        destSize: 4000,
      },
    ];

    // overwrite and rename don't make sense for extra files
    const results = await resolveConflictsByStrategy(extraConflicts, "overwrite");

    expect(results.length).toBe(2);
    results.forEach((result) => {
      expect(result.success).toBe(true);
      // Should fall back to 'keep' since overwrite doesn't apply to extra files
      expect(result.resolution).toBe("keep");
    });
    expect(mockFilesystem.copyOrLink).not.toHaveBeenCalled();
  });

  it("should handle rename strategy for extra files with keep fallback", async () => {
    const extraConflicts: ConflictContext[] = [
      {
        sourcePath: "",
        destPath: "/dest/extra.flac",
        conflictType: { type: "extra", destPath: "/dest/extra.flac", size: 3000 },
        destSize: 3000,
      },
    ];

    const results = await resolveConflictsByStrategy(extraConflicts, "rename");

    expect(results.length).toBe(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.resolution).toBe("keep");
  });

  it("should handle skip strategy for extra files", async () => {
    const extraConflicts: ConflictContext[] = [
      {
        sourcePath: "",
        destPath: "/dest/extra.flac",
        conflictType: { type: "extra", destPath: "/dest/extra.flac", size: 3000 },
        destSize: 3000,
      },
    ];

    const results = await resolveConflictsByStrategy(extraConflicts, "skip");

    expect(results.length).toBe(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.resolution).toBe("skip");
  });

  it("should process mixed conflict types correctly", async () => {
    const mixedConflicts: ConflictContext[] = [
      {
        sourcePath: "/source/file1.flac",
        destPath: "/dest/file1.flac",
        conflictType: { type: "exists", destPath: "/dest/file1.flac", destSize: 5000 },
        sourceSize: 5000,
        destSize: 5000,
      },
      {
        sourcePath: "/source/file2.flac",
        destPath: "/dest/file2.flac",
        conflictType: {
          type: "size-mismatch",
          destPath: "/dest/file2.flac",
          expected: 10000,
          actual: 5000,
        },
        sourceSize: 10000,
        destSize: 5000,
      },
      {
        sourcePath: "",
        destPath: "/dest/extra.flac",
        conflictType: { type: "extra", destPath: "/dest/extra.flac", size: 3000 },
        destSize: 3000,
      },
    ];

    const results = await resolveConflictsByStrategy(mixedConflicts, "overwrite");

    expect(results.length).toBe(3);
    // exists and size-mismatch get overwritten
    expect(results[0]?.resolution).toBe("overwrite");
    expect(results[1]?.resolution).toBe("overwrite");
    // extra gets keep fallback
    expect(results[2]?.resolution).toBe("keep");
  });

  it("should handle empty conflict list", async () => {
    const results = await resolveConflictsByStrategy([], "skip");

    expect(results).toEqual([]);
  });
});

// NOTE: Integration tests with real filesystem are not included here because
// vi.mock() hoisting makes it difficult to switch between mocked and real modules
// within the same test file. The unit tests above provide comprehensive coverage
// of all conflict-resolver functions. Integration tests that verify end-to-end
// behavior with real filesystem operations should be in separate test files
// (e.g., in src/actions/*.test.ts) where the mock setup can be different.
