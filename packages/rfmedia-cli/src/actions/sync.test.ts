import path from "node:path";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SyncDiff, SyncOptions } from "../types/inventory.js";

const mocks = vi.hoisted(() => ({
  appendFileRecord: vi.fn(),
  appendSourceRecord: vi.fn(),
  calculateHash: vi.fn(),
  cleanupPartialFile: vi.fn(),
  closeDatabase: vi.fn(),
  computeAlbumSyncDiff: vi.fn(),
  computeFilterSyncDiff: vi.fn(),
  convertFile: vi.fn(),
  copyOrLink: vi.fn(),
  createOperation: vi.fn(),
  createFileInventoryEntry: vi.fn(),
  ensureDir: vi.fn(),
  getFileSize: vi.fn(),
  getStats: vi.fn(),
  initializeDatabase: vi.fn(),
  initializeInventory: vi.fn(),
  loadInventory: vi.fn(),
  normalizePathResolved: vi.fn(),
  pathExists: vi.fn(),
  readRating: vi.fn(),
  readSourcePaths: vi.fn(),
  rename: vi.fn(),
  registerGlobalCleanup: vi.fn(),
  remove: vi.fn(),
  resetInventory: vi.fn(),
  resolveOptionalScanAdapter: vi.fn(),
  unregisterGlobalCleanup: vi.fn(),
  updateOperationCounts: vi.fn(),
  updateOperationStatus: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111") };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: mocks.rename };
});

vi.mock("../lib/inventory.js", () => ({
  appendFileRecord: mocks.appendFileRecord,
  appendSourceRecord: mocks.appendSourceRecord,
  buildInventoryOptionsHash: vi.fn(() => ({ mode: "album" })),
  computeAlbumSyncDiff: mocks.computeAlbumSyncDiff,
  computeFilterSyncDiff: mocks.computeFilterSyncDiff,
  createFileInventoryEntry: mocks.createFileInventoryEntry,
  formatInventoryOptionsHash: vi.fn(() => "album-001-002"),
  getFileMetadata: vi.fn(),
  initializeInventory: mocks.initializeInventory,
  loadInventory: mocks.loadInventory,
  resetInventory: mocks.resetInventory,
  resolveInventoryPath: vi.fn(() => "/tracking/sync.inventory.jsonl"),
}));

vi.mock("../lib/db.js", () => ({
  closeDatabase: mocks.closeDatabase,
  createOperation: mocks.createOperation,
  initializeDatabase: mocks.initializeDatabase,
  updateOperationCounts: mocks.updateOperationCounts,
  updateOperationStatus: mocks.updateOperationStatus,
}));

vi.mock("../lib/filesystem.js", () => ({
  cleanupPartialFile: mocks.cleanupPartialFile,
  copyOrLink: mocks.copyOrLink,
  ensureDir: mocks.ensureDir,
  getFileSize: mocks.getFileSize,
  getStats: mocks.getStats,
  normalizePathResolved: mocks.normalizePathResolved,
  pathExists: mocks.pathExists,
  remove: mocks.remove,
}));

vi.mock("../lib/integrity.js", () => ({
  calculateHash: mocks.calculateHash,
}));

vi.mock("../lib/convert.js", () => ({
  convertFile: mocks.convertFile,
  getConvertedFilename: vi.fn((filename: string, format: string) => {
    const extension = path.extname(filename);
    return `${path.basename(filename, extension)}.${format}`;
  }),
}));

vi.mock("../lib/audio.js", () => ({
  findAudioFiles: vi.fn(),
  isAudioFile: vi.fn(() => true),
}));

vi.mock("../lib/ratings.js", () => ({
  meetsThreshold: vi.fn(() => true),
  readRating: mocks.readRating,
}));

vi.mock("../lib/input-file.js", () => ({ readSourcePaths: mocks.readSourcePaths }));
vi.mock("../lib/loaded-config.js", () => ({ getLoadedConfig: vi.fn(() => undefined) }));
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mocks.resolveOptionalScanAdapter,
}));
vi.mock("../lib/parallel.js", () => ({ processInParallel: vi.fn() }));
vi.mock("../lib/progress-bar.js", () => ({
  CopyProgressBar: vi.fn(),
  isProgressEnabled: vi.fn(() => false),
}));
vi.mock("../lib/logger.js", () => ({
  formatDryRun: vi.fn((message: string) => `[DRY-RUN] ${message}`),
  isJsonMode: vi.fn(() => true),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../lib/table-format.js", () => ({ formatSyncSummaryTable: vi.fn(() => "summary") }));
vi.mock("../lib/signal-handler.js", () => ({
  getGlobalSignal: vi.fn(() => undefined),
  registerGlobalCleanup: mocks.registerGlobalCleanup,
  unregisterGlobalCleanup: mocks.unregisterGlobalCleanup,
}));

import { executeSyncWithFileInput } from "./sync.js";

const source = "/music/Artist";
const sourceFile = "/music/Artist/Album/track.flac";
const destination = "/destination";
const fingerprint = "a".repeat(64);
const transactionId = "11111111-1111-4111-8111-111111111111";

function transactionPath(destinationPath: string, kind: "stage" | "backup", index = 0): string {
  const extension = path.extname(destinationPath);
  const basename = path.basename(destinationPath, extension);
  return path.join(
    path.dirname(destinationPath),
    `.${basename}.rfmedia-sync-${kind}-${transactionId}-${index}${extension}`,
  );
}

function emptyDiff(overrides: Partial<SyncDiff> = {}): SyncDiff {
  return {
    newFiles: [],
    updatedFiles: [],
    unchangedFiles: [],
    removedFiles: [],
    downgradedFiles: [],
    ...overrides,
  };
}

function createOptions(overrides: Partial<SyncOptions> = {}): SyncOptions {
  return {
    copyOptions: {
      mode: { type: "album", range: { start: 1, end: 2, padWidth: 3 } },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 1,
      cliSourceEntries: [{ path: source }],
      useLegacyTracking: true,
    },
    dryRun: false,
    force: false,
    resetInventory: false,
    deleteDowngraded: true,
    ...overrides,
  };
}

function createSingleRangeOptions(overrides: Partial<SyncOptions> = {}): SyncOptions {
  const options = createOptions(overrides);
  options.copyOptions.mode = { type: "album", range: { start: 1, end: 1, padWidth: 3 } };
  return options;
}

function createFilterOptions(overrides: Partial<SyncOptions> = {}): SyncOptions {
  const options = createOptions(overrides);
  options.copyOptions.mode = {
    type: "filter",
    rating: {
      minRating: 50,
      outputFolder: "liked-songs",
      preserveStructure: false,
    },
  };
  return options;
}

describe("executeSyncWithFileInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    mocks.pathExists.mockImplementation(async (candidate: string) => candidate === source);
    mocks.readRating.mockResolvedValue(null);
    mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ newFiles: [sourceFile] }));
    mocks.computeFilterSyncDiff.mockResolvedValue(emptyDiff());
    mocks.appendFileRecord.mockResolvedValue(undefined);
    mocks.appendSourceRecord.mockResolvedValue(undefined);
    mocks.copyOrLink.mockResolvedValue("copy");
    mocks.calculateHash.mockResolvedValue(fingerprint);
    mocks.getFileSize.mockResolvedValue(128);
    mocks.getStats.mockResolvedValue({ isFile: () => true });
    mocks.initializeDatabase.mockResolvedValue({ database: "test" });
    mocks.createOperation.mockReturnValue(42);
    mocks.loadInventory.mockResolvedValue(new Map());
    mocks.normalizePathResolved.mockImplementation(async (candidate: string) =>
      path.resolve(candidate),
    );
    mocks.readSourcePaths.mockResolvedValue([]);
    mocks.rename.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.resolveOptionalScanAdapter.mockReturnValue({ adapter: undefined });
    mocks.createFileInventoryEntry.mockImplementation(
      async (
        sourcePath: string,
        filePath: string,
        destPath: string,
        rating: number | null,
        contentHash?: string | null,
      ) => ({
        relativePath: path.relative(sourcePath, filePath),
        mtime: 1,
        size: 128,
        rating,
        destPath,
        contentHash: contentHash ?? null,
        copiedAt: 2,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "ordinary copy", hardlink: false, convertFormat: undefined },
    { name: "hardlink", hardlink: true, convertFormat: undefined },
    { name: "conversion", hardlink: false, convertFormat: "mp3" as const },
  ])("persists the fingerprint for the represented destination after $name", async (testCase) => {
    const events: string[] = [];
    mocks.copyOrLink.mockImplementation(async () => {
      events.push("materialize");
      return testCase.hardlink ? "hardlink" : "copy";
    });
    mocks.convertFile.mockImplementation(async () => {
      events.push("materialize");
    });
    mocks.calculateHash.mockImplementation(async () => {
      events.push("hash");
      return fingerprint;
    });
    mocks.appendFileRecord.mockImplementation(async () => {
      events.push("inventory");
    });
    mocks.rename.mockImplementation(async () => {
      events.push("publish");
    });

    const options = createOptions();
    options.copyOptions.hardlink = testCase.hardlink;
    options.copyOptions.convertFormat = testCase.convertFormat;

    const result = await executeSyncWithFileInput(destination, options);
    const extension = testCase.convertFormat ?? "flac";
    const representedDestination = path.join(
      destination,
      "Artist",
      "Album-001",
      `track.${extension}`,
    );
    const secondDestination = path.join(destination, "Artist", "Album-002", `track.${extension}`);

    expect(result.failedFiles).toBe(0);
    expect(result.newFilesCopied).toBe(2);
    const representedStage = transactionPath(representedDestination, "stage");
    expect(mocks.calculateHash.mock.calls).toEqual([
      [representedStage],
      [transactionPath(secondDestination, "stage", 1)],
    ]);
    expect(mocks.createFileInventoryEntry).toHaveBeenCalledWith(
      source,
      sourceFile,
      representedDestination,
      null,
      fingerprint,
    );
    expect(mocks.appendFileRecord).toHaveBeenCalledOnce();
    expect(mocks.appendFileRecord).toHaveBeenCalledWith(
      expect.any(Object),
      source,
      expect.objectContaining({
        destPath: representedDestination,
        contentHash: fingerprint,
      }),
    );
    expect(events.lastIndexOf("materialize")).toBeLessThan(events.indexOf("hash"));
    expect(events.lastIndexOf("hash")).toBeLessThan(events.indexOf("inventory"));
    expect(events.lastIndexOf("hash")).toBeLessThan(events.indexOf("publish"));
    expect(events.lastIndexOf("publish")).toBeLessThan(events.indexOf("inventory"));

    if (testCase.convertFormat) {
      expect(mocks.convertFile).toHaveBeenCalledOnce();
      expect(mocks.convertFile).toHaveBeenCalledWith(
        sourceFile,
        representedStage,
        testCase.convertFormat,
      );
    } else {
      expect(mocks.copyOrLink).toHaveBeenNthCalledWith(
        1,
        sourceFile,
        representedStage,
        testCase.hardlink,
        expect.any(AbortSignal),
      );
    }
  });

  it("keeps dry-run work out of the successful persistence path", async () => {
    const result = await executeSyncWithFileInput(destination, createOptions({ dryRun: true }));

    expect(result.newFilesCopied).toBe(2);
    expect(mocks.copyOrLink).not.toHaveBeenCalled();
    expect(mocks.convertFile).not.toHaveBeenCalled();
    expect(mocks.calculateHash).not.toHaveBeenCalled();
    expect(mocks.createFileInventoryEntry).not.toHaveBeenCalled();
    expect(mocks.appendFileRecord).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("reports hash failure without recording the file as copied", async () => {
    mocks.calculateHash
      .mockResolvedValueOnce(fingerprint)
      .mockRejectedValueOnce(new Error("hash failed"));

    const result = await executeSyncWithFileInput(destination, createOptions());
    const firstDestination = path.join(destination, "Artist", "Album-001", "track.flac");
    const secondDestination = path.join(destination, "Artist", "Album-002", "track.flac");

    expect(result.newFilesCopied).toBe(0);
    expect(result.failedFiles).toBe(1);
    expect(result.failed[0]?.message).toBe("hash failed");
    expect(mocks.createFileInventoryEntry).not.toHaveBeenCalled();
    expect(mocks.appendFileRecord).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(transactionPath(firstDestination, "stage", 0));
    expect(mocks.remove).toHaveBeenCalledWith(transactionPath(secondDestination, "stage", 1));
  });

  it("reports inventory failure without recording the file as copied", async () => {
    mocks.appendFileRecord.mockRejectedValue(new Error("inventory failed"));

    const result = await executeSyncWithFileInput(destination, createOptions());
    const firstDestination = path.join(destination, "Artist", "Album-001", "track.flac");
    const secondDestination = path.join(destination, "Artist", "Album-002", "track.flac");

    expect(result.newFilesCopied).toBe(0);
    expect(result.failedFiles).toBe(1);
    expect(result.failed[0]?.message).toBe("inventory failed");
    expect(mocks.calculateHash).toHaveBeenCalledTimes(2);
    expect(mocks.appendFileRecord).toHaveBeenCalledOnce();
    expect(mocks.rename).toHaveBeenCalledWith(
      transactionPath(firstDestination, "stage", 0),
      firstDestination,
    );
    expect(mocks.rename).toHaveBeenCalledWith(
      transactionPath(secondDestination, "stage", 1),
      secondDestination,
    );
    expect(mocks.remove).toHaveBeenCalledWith(firstDestination);
    expect(mocks.remove).toHaveBeenCalledWith(secondDestination);
  });

  it("reports rollback failure when published new output cannot be removed", async () => {
    const firstDestination = path.join(destination, "Artist", "Album-001", "track.flac");
    const removalError = Object.assign(new Error("destination busy"), { code: "EBUSY" });
    mocks.appendFileRecord.mockRejectedValue(new Error("inventory failed"));
    mocks.remove.mockImplementation(async (candidate: string) => {
      if (candidate === firstDestination) throw removalError;
    });

    const result = await executeSyncWithFileInput(destination, createOptions());

    expect(result).toMatchObject({ newFilesCopied: 0, failedFiles: 1 });
    expect(result.failed[0]?.message).toContain("inventory failed; rollback incomplete");
    expect(result.failed[0]?.message).toContain(
      `Failed to remove published sync destination ${firstDestination}: destination busy`,
    );
  });

  it("publishes nothing and cleans every stage when a later suffix fails", async () => {
    const firstDestination = path.join(destination, "Artist", "Album-001", "track.flac");
    const secondDestination = path.join(destination, "Artist", "Album-002", "track.flac");
    mocks.copyOrLink.mockResolvedValueOnce("copy").mockRejectedValueOnce(new Error("link failed"));

    const result = await executeSyncWithFileInput(destination, createOptions());

    expect(result).toMatchObject({ newFilesCopied: 0, failedFiles: 1 });
    expect(result.failed[0]?.message).toBe("link failed");
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.calculateHash).not.toHaveBeenCalled();
    expect(mocks.appendFileRecord).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(transactionPath(firstDestination, "stage", 0));
    expect(mocks.remove).toHaveBeenCalledWith(transactionPath(secondDestination, "stage", 1));
  });

  it("preserves an existing updated destination when staging fails", async () => {
    const updatedFile = "/music/Artist/Album/updated.flac";
    const updatedDestination = path.join(destination, "Artist", "Album-001", "updated.flac");
    const options = createSingleRangeOptions();
    options.copyOptions.hardlink = true;
    mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ updatedFiles: [updatedFile] }));
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === updatedDestination,
    );
    mocks.copyOrLink.mockRejectedValue(new Error("hardlink failed"));

    const result = await executeSyncWithFileInput(destination, options);

    expect(result).toMatchObject({ updatedFilesCopied: 0, failedFiles: 1 });
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalledWith(updatedDestination);
    expect(mocks.remove).toHaveBeenCalledWith(transactionPath(updatedDestination, "stage"));
    expect(mocks.appendFileRecord).not.toHaveBeenCalled();
  });

  it("restores an updated destination when inventory persistence fails", async () => {
    const updatedFile = "/music/Artist/Album/updated.flac";
    const updatedDestination = path.join(destination, "Artist", "Album-001", "updated.flac");
    const stagedDestination = transactionPath(updatedDestination, "stage");
    const backupDestination = transactionPath(updatedDestination, "backup");
    mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ updatedFiles: [updatedFile] }));
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === updatedDestination,
    );
    mocks.appendFileRecord.mockRejectedValue(new Error("inventory failed"));

    const result = await executeSyncWithFileInput(destination, createSingleRangeOptions());

    expect(result).toMatchObject({ updatedFilesCopied: 0, failedFiles: 1 });
    expect(mocks.rename.mock.calls).toEqual([
      [updatedDestination, backupDestination],
      [stagedDestination, updatedDestination],
      [backupDestination, updatedDestination],
    ]);
    expect(mocks.remove).toHaveBeenCalledWith(updatedDestination);
    expect(mocks.appendFileRecord).toHaveBeenCalledOnce();
  });

  it("preserves and reports the backup when updated-output rollback cannot remove replacement", async () => {
    const updatedFile = "/music/Artist/Album/updated.flac";
    const updatedDestination = path.join(destination, "Artist", "Album-001", "updated.flac");
    const backupDestination = transactionPath(updatedDestination, "backup");
    mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ updatedFiles: [updatedFile] }));
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === updatedDestination,
    );
    mocks.appendFileRecord.mockRejectedValue(new Error("inventory failed"));
    mocks.remove.mockImplementation(async (candidate: string) => {
      if (candidate === updatedDestination) throw new Error("replacement busy");
    });

    const result = await executeSyncWithFileInput(destination, createSingleRangeOptions());

    expect(result).toMatchObject({ updatedFilesCopied: 0, failedFiles: 1 });
    expect(result.failed[0]?.message).toContain("inventory failed; rollback incomplete");
    expect(result.failed[0]?.message).toContain(
      `Original sync destination retained at recovery path ${backupDestination}`,
    );
    expect(mocks.rename).not.toHaveBeenCalledWith(backupDestination, updatedDestination);
    expect(mocks.remove).not.toHaveBeenCalledWith(backupDestination);
  });

  it("does not create later suffixes when the first required new destination collides", async () => {
    const firstDestination = path.join(destination, "Artist", "Album-001", "track.flac");
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === firstDestination,
    );

    const result = await executeSyncWithFileInput(destination, createOptions());

    expect(result).toMatchObject({ newFilesCopied: 0, failedFiles: 0 });
    expect(mocks.copyOrLink).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.calculateHash).not.toHaveBeenCalled();
    expect(mocks.appendFileRecord).not.toHaveBeenCalled();
  });

  it("preserves new, updated, and unchanged classification while replacing an existing update", async () => {
    const newFile = "/music/Artist/Album/new.flac";
    const updatedFile = "/music/Artist/Album/updated.flac";
    const unchangedFile = "/music/Artist/Album/unchanged.flac";
    const updatedDestination = path.join(destination, "Artist", "Album-001", "updated.flac");
    const events: string[] = [];

    mocks.computeAlbumSyncDiff.mockResolvedValue(
      emptyDiff({
        newFiles: [newFile],
        updatedFiles: [updatedFile],
        unchangedFiles: [unchangedFile],
      }),
    );
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === updatedDestination,
    );
    mocks.appendSourceRecord.mockImplementation(async () => {
      events.push("source");
    });
    mocks.copyOrLink.mockImplementation(async (_sourcePath: string, destPath: string) => {
      events.push(`write:${destPath}`);
      return "copy";
    });

    const result = await executeSyncWithFileInput(destination, createSingleRangeOptions());

    expect(result).toMatchObject({
      newFilesCopied: 1,
      updatedFilesCopied: 1,
      unchangedFilesSkipped: 1,
      failedFiles: 0,
    });
    expect(mocks.copyOrLink).toHaveBeenCalledTimes(2);
    expect(mocks.copyOrLink).toHaveBeenCalledWith(
      updatedFile,
      transactionPath(updatedDestination, "stage"),
      false,
      expect.any(AbortSignal),
    );
    expect(events[0]).toBe("source");
    expect(mocks.appendFileRecord).toHaveBeenCalledTimes(2);
  });

  it("publishes a staged hardlink without deleting the authorized existing destination", async () => {
    const updatedFile = "/music/Artist/Album/updated.flac";
    const updatedDestination = path.join(destination, "Artist", "Album-001", "updated.flac");
    const events: string[] = [];
    const options = createSingleRangeOptions();
    options.copyOptions.hardlink = true;
    mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ updatedFiles: [updatedFile] }));
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === updatedDestination,
    );
    mocks.copyOrLink.mockImplementation(async () => {
      events.push("stage");
      return "hardlink";
    });
    mocks.rename.mockImplementation(async (from: string, to: string) => {
      events.push(from === updatedDestination ? "backup" : `publish:${to}`);
    });
    mocks.remove.mockImplementation(async (candidate: string) => {
      events.push(`cleanup:${candidate}`);
    });

    const result = await executeSyncWithFileInput(destination, options);

    expect(result.updatedFilesCopied).toBe(1);
    expect(result.failedFiles).toBe(0);
    const stagedDestination = transactionPath(updatedDestination, "stage");
    const backupDestination = transactionPath(updatedDestination, "backup");
    expect(mocks.remove).not.toHaveBeenCalledWith(updatedDestination);
    expect(mocks.copyOrLink).toHaveBeenCalledWith(
      updatedFile,
      stagedDestination,
      true,
      expect.any(AbortSignal),
    );
    expect(mocks.rename).toHaveBeenNthCalledWith(1, updatedDestination, backupDestination);
    expect(mocks.rename).toHaveBeenNthCalledWith(2, stagedDestination, updatedDestination);
    expect(mocks.remove).toHaveBeenCalledWith(backupDestination);
    expect(events).toEqual([
      "stage",
      "backup",
      `publish:${updatedDestination}`,
      `cleanup:${backupDestination}`,
    ]);
  });

  it("preserves filter classification and exact ranged destination mapping", async () => {
    const newFile = "/music/Artist/Album/new.flac";
    const updatedFile = "/music/Artist/Album/updated.flac";
    const unchangedFile = "/music/Artist/Album/unchanged.flac";
    const options = createFilterOptions();
    if (options.copyOptions.mode.type !== "filter") throw new Error("expected filter mode");
    options.copyOptions.mode.rating.preserveStructure = true;
    options.copyOptions.mode.rating.range = { start: 1, end: 2, padWidth: 2 };
    mocks.readRating.mockResolvedValue({ value: 0.8, source: "vorbis" });
    mocks.computeFilterSyncDiff.mockResolvedValue(
      emptyDiff({
        newFiles: [newFile],
        updatedFiles: [updatedFile],
        unchangedFiles: [unchangedFile],
      }),
    );

    const result = await executeSyncWithFileInput(destination, options);

    const newDestination = path.join(destination, "Artist", "liked-songs", "Album", "new-01.flac");
    const updatedDestination = path.join(
      destination,
      "Artist",
      "liked-songs",
      "Album",
      "updated-01.flac",
    );
    expect(result).toMatchObject({
      newFilesCopied: 2,
      updatedFilesCopied: 2,
      unchangedFilesSkipped: 1,
      failedFiles: 0,
    });
    expect(mocks.readRating).toHaveBeenCalledTimes(2);
    expect(mocks.createFileInventoryEntry).toHaveBeenCalledWith(
      source,
      newFile,
      newDestination,
      0.8,
      fingerprint,
    );
    expect(mocks.createFileInventoryEntry).toHaveBeenCalledWith(
      source,
      updatedFile,
      updatedDestination,
      0.8,
      fingerprint,
    );
    expect(mocks.appendFileRecord).toHaveBeenCalledTimes(2);
    expect(mocks.copyOrLink).toHaveBeenCalledTimes(4);
  });

  it.each([
    { force: false, expectedCopied: 0, expectedWrites: 0 },
    { force: true, expectedCopied: 1, expectedWrites: 1 },
  ])(
    "keeps a genuinely new destination collision under force policy (force=$force)",
    async ({ force, expectedCopied, expectedWrites }) => {
      const representedDestination = path.join(destination, "Artist", "Album-001", "track.flac");
      mocks.pathExists.mockImplementation(
        async (candidate: string) => candidate === source || candidate === representedDestination,
      );

      const result = await executeSyncWithFileInput(
        destination,
        createSingleRangeOptions({ force }),
      );

      expect(result.newFilesCopied).toBe(expectedCopied);
      expect(result.updatedFilesCopied).toBe(0);
      expect(mocks.copyOrLink).toHaveBeenCalledTimes(expectedWrites);
      expect(mocks.appendFileRecord).toHaveBeenCalledTimes(expectedWrites);
    },
  );

  it("continues after a missing source and retains exact failure and success counts", async () => {
    const missingSource = "/music/Missing";
    const options = createSingleRangeOptions();
    options.copyOptions.cliSourceEntries = [{ path: missingSource }, { path: source }];

    const result = await executeSyncWithFileInput(destination, options);

    expect(result).toMatchObject({
      sourcesScanned: 2,
      newFilesCopied: 1,
      failedFiles: 1,
      failed: [
        {
          sourcePath: missingSource,
          message: "Source directory does not exist",
          code: "ENOENT",
        },
      ],
    });
    expect(mocks.computeAlbumSyncDiff).toHaveBeenCalledOnce();
    expect(mocks.copyOrLink).toHaveBeenCalledOnce();
  });

  it("continues with later files after one materialization fails", async () => {
    const failedFile = "/music/Artist/Album/failed.flac";
    const successfulFile = "/music/Artist/Album/success.flac";
    mocks.computeAlbumSyncDiff.mockResolvedValue(
      emptyDiff({ newFiles: [failedFile, successfulFile] }),
    );
    mocks.copyOrLink.mockRejectedValueOnce(new Error("copy failed"));

    const result = await executeSyncWithFileInput(destination, createSingleRangeOptions());

    expect(result.newFilesCopied).toBe(1);
    expect(result.failedFiles).toBe(1);
    expect(result.failed[0]).toMatchObject({ sourcePath: failedFile, message: "copy failed" });
    expect(mocks.copyOrLink).toHaveBeenCalledTimes(2);
    expect(mocks.createFileInventoryEntry).toHaveBeenCalledOnce();
    expect(mocks.createFileInventoryEntry).toHaveBeenCalledWith(
      source,
      successfulFile,
      path.join(destination, "Artist", "Album-001", "success.flac"),
      null,
      fingerprint,
    );
  });

  it("does not delete downgraded destinations when deletion is disabled", async () => {
    const downgradedPath = path.join(destination, "Artist", "liked-songs", "track.flac");
    mocks.computeFilterSyncDiff.mockResolvedValue(
      emptyDiff({
        downgradedFiles: [
          {
            relativePath: "Album/track.flac",
            destPath: downgradedPath,
            previousRating: 0.8,
            currentRating: 0.2,
          },
        ],
      }),
    );

    const result = await executeSyncWithFileInput(
      destination,
      createFilterOptions({ deleteDowngraded: false }),
    );

    expect(result.deletedFiles).toBe(0);
    expect(mocks.pathExists).not.toHaveBeenCalledWith(downgradedPath);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("counts an absent contained downgrade as already deleted", async () => {
    const downgradedPath = path.join(destination, "Artist", "liked-songs", "track.flac");
    mocks.computeFilterSyncDiff.mockResolvedValue(
      emptyDiff({
        downgradedFiles: [
          {
            relativePath: "Album/track.flac",
            destPath: downgradedPath,
            previousRating: 0.8,
            currentRating: null,
          },
        ],
      }),
    );

    const result = await executeSyncWithFileInput(destination, createFilterOptions());

    expect(result.deletedFiles).toBe(1);
    expect(result.failedFiles).toBe(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("contains downgrade deletion to regular non-symlink leaves even under force", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "rfmedia-sync-"));
    const selectedDestination = path.join(tempRoot, "dest");
    const prefixLookalike = path.join(tempRoot, "dest-outside");
    const validPath = path.join(selectedDestination, "valid.flac");
    const symlinkPath = path.join(selectedDestination, "linked.flac");
    const directoryPath = path.join(selectedDestination, "directory.flac");
    const outsideSentinel = path.join(prefixLookalike, "sentinel.flac");

    try {
      await mkdir(selectedDestination, { recursive: true });
      await mkdir(prefixLookalike, { recursive: true });
      await mkdir(directoryPath);
      await writeFile(validPath, "valid");
      await writeFile(outsideSentinel, "sentinel");
      await symlink(outsideSentinel, symlinkPath);

      mocks.pathExists.mockImplementation(async (candidate: string) => {
        if (candidate === source) return true;
        try {
          await access(candidate);
          return true;
        } catch {
          return false;
        }
      });
      mocks.normalizePathResolved.mockImplementation(async (candidate: string) => {
        try {
          return await realpath(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(candidate);
          throw error;
        }
      });
      mocks.getStats.mockImplementation(stat);
      mocks.remove.mockImplementation(unlink);
      mocks.computeFilterSyncDiff.mockResolvedValue(
        emptyDiff({
          downgradedFiles: [
            {
              relativePath: "valid.flac",
              destPath: validPath,
              previousRating: 0.8,
              currentRating: 0.2,
            },
            {
              relativePath: "outside.flac",
              destPath: outsideSentinel,
              previousRating: 0.8,
              currentRating: 0.2,
            },
            {
              relativePath: "linked.flac",
              destPath: symlinkPath,
              previousRating: 0.8,
              currentRating: 0.2,
            },
            {
              relativePath: "directory.flac",
              destPath: directoryPath,
              previousRating: 0.8,
              currentRating: 0.2,
            },
          ],
        }),
      );

      const result = await executeSyncWithFileInput(
        selectedDestination,
        createFilterOptions({ force: true }),
      );

      expect(result.deletedFiles).toBe(1);
      expect(result.failedFiles).toBe(3);
      expect(result.failed.map((failure) => failure.sourcePath)).toEqual([
        "outside.flac",
        "linked.flac",
        "directory.flac",
      ]);
      expect(mocks.remove).toHaveBeenCalledOnce();
      expect(mocks.remove).toHaveBeenCalledWith(validPath);
      await expect(access(validPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(outsideSentinel, "utf8")).resolves.toBe("sentinel");
      await expect(access(symlinkPath)).resolves.toBeUndefined();
      expect((await stat(directoryPath)).isDirectory()).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records downgrade removal failures without hiding their path or code", async () => {
    const downgradedPath = path.join(destination, "Artist", "liked-songs", "track.flac");
    const removalError = Object.assign(new Error("busy"), { code: "EBUSY" });
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === source || candidate === downgradedPath,
    );
    mocks.remove.mockRejectedValue(removalError);
    mocks.computeFilterSyncDiff.mockResolvedValue(
      emptyDiff({
        downgradedFiles: [
          {
            relativePath: "Album/track.flac",
            destPath: downgradedPath,
            previousRating: 0.8,
            currentRating: 0.2,
          },
        ],
      }),
    );

    const result = await executeSyncWithFileInput(destination, createFilterOptions());

    expect(result.deletedFiles).toBe(0);
    expect(result.failedFiles).toBe(1);
    expect(result.failed).toEqual([
      {
        sourcePath: "Album/track.flac",
        destPath: downgradedPath,
        message: "Failed to delete: busy",
        code: "EBUSY",
      },
    ]);
  });

  it.each([
    { name: "completed", paths: [source], expectedStatus: "completed", expectedTotal: 1 },
    {
      name: "partial",
      paths: ["/music/Missing", source],
      expectedStatus: "partial",
      expectedTotal: 2,
    },
  ])("owns the database lifecycle for a $name sync", async (testCase) => {
    const db = { database: "sync-test" };
    const options = createSingleRangeOptions();
    options.copyOptions.useLegacyTracking = false;
    options.copyOptions.cliSourceEntries = testCase.paths.map((sourcePath) => ({
      path: sourcePath,
    }));
    mocks.initializeDatabase.mockResolvedValue(db);

    const result = await executeSyncWithFileInput(destination, options);

    const failedCount = testCase.expectedStatus === "partial" ? 1 : 0;
    expect(result.sourcesScanned).toBe(testCase.expectedTotal);
    expect(mocks.initializeDatabase).toHaveBeenCalledOnce();
    expect(mocks.createOperation).toHaveBeenCalledOnce();
    expect(mocks.loadInventory).toHaveBeenCalledWith(
      expect.objectContaining({ db, operationId: 42 }),
    );
    expect(mocks.updateOperationCounts).toHaveBeenCalledWith(db, 42, {
      totalSources: testCase.expectedTotal,
      completedCount: testCase.expectedTotal - failedCount,
      failedCount,
    });
    expect(mocks.updateOperationStatus).toHaveBeenCalledWith(db, 42, testCase.expectedStatus);
    expect(mocks.closeDatabase).toHaveBeenCalledOnce();
    expect(mocks.closeDatabase).toHaveBeenCalledWith(db);
    expect(mocks.unregisterGlobalCleanup.mock.calls.map(([name]) => name)).toEqual([
      "sync-abort",
      "sync-partial-files",
      "sync-database",
    ]);
  });

  it.each([
    {
      name: "operation creation",
      fail: () =>
        mocks.createOperation.mockImplementation(() => {
          throw new Error("create failed");
        }),
      message: "create failed",
      expectedUnregisters: [] as string[],
    },
    {
      name: "inventory load",
      fail: () => mocks.loadInventory.mockRejectedValue(new Error("load failed")),
      message: "load failed",
      expectedUnregisters: [] as string[],
    },
    {
      name: "cleanup registration",
      fail: () =>
        mocks.registerGlobalCleanup
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error("register failed");
          }),
      message: "register failed",
      expectedUnregisters: ["sync-abort"],
    },
  ])("closes the database exactly once after $name failure", async (testCase) => {
    const db = { database: "sync-test" };
    const options = createSingleRangeOptions();
    options.copyOptions.useLegacyTracking = false;
    mocks.initializeDatabase.mockResolvedValue(db);
    testCase.fail();

    await expect(executeSyncWithFileInput(destination, options)).rejects.toThrow(testCase.message);

    expect(mocks.closeDatabase).toHaveBeenCalledOnce();
    expect(mocks.closeDatabase).toHaveBeenCalledWith(db);
    expect(mocks.unregisterGlobalCleanup.mock.calls.map(([name]) => name)).toEqual(
      testCase.expectedUnregisters,
    );
  });

  it("does not close the database twice when registered cleanup runs before finalization", async () => {
    const db = { database: "sync-test" };
    const options = createSingleRangeOptions();
    options.copyOptions.useLegacyTracking = false;
    mocks.initializeDatabase.mockResolvedValue(db);
    mocks.copyOrLink.mockImplementation(async () => {
      const databaseCleanup = mocks.registerGlobalCleanup.mock.calls.find(
        ([registration]) => registration.name === "sync-database",
      )?.[0].cleanup as (() => void) | undefined;
      databaseCleanup?.();
      return "copy";
    });

    await executeSyncWithFileInput(destination, options);

    expect(mocks.closeDatabase).toHaveBeenCalledOnce();
    expect(mocks.closeDatabase).toHaveBeenCalledWith(db);
  });

  it("counts multiple file failures as one failed source operation", async () => {
    const db = { database: "sync-test" };
    const firstFile = "/music/Artist/Album/first.flac";
    const secondFile = "/music/Artist/Album/second.flac";
    const options = createSingleRangeOptions();
    options.copyOptions.useLegacyTracking = false;
    mocks.initializeDatabase.mockResolvedValue(db);
    mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ newFiles: [firstFile, secondFile] }));
    mocks.copyOrLink.mockRejectedValue(new Error("copy failed"));

    const result = await executeSyncWithFileInput(destination, options);

    expect(result).toMatchObject({ sourcesScanned: 1, failedFiles: 2 });
    expect(mocks.updateOperationCounts).toHaveBeenCalledWith(db, 42, {
      totalSources: 1,
      completedCount: 0,
      failedCount: 1,
    });
    expect(mocks.updateOperationStatus).toHaveBeenCalledWith(db, 42, "failed");
    expect(mocks.closeDatabase).toHaveBeenCalledOnce();
  });

  it("rejects missing and empty input selections before registering resources", async () => {
    const missingInput = createSingleRangeOptions();
    missingInput.copyOptions.cliSourceEntries = undefined;

    await expect(executeSyncWithFileInput(destination, missingInput)).rejects.toThrow(
      "Sync command requires either --file or --paths option",
    );

    const emptyFile = createSingleRangeOptions();
    emptyFile.copyOptions.cliSourceEntries = undefined;
    emptyFile.copyOptions.file = "/input/empty.txt";
    mocks.readSourcePaths.mockResolvedValue([]);

    await expect(executeSyncWithFileInput(destination, emptyFile)).rejects.toThrow(
      "No source paths found in file: /input/empty.txt",
    );
    expect(mocks.registerGlobalCleanup).not.toHaveBeenCalled();
  });

  it.each([
    { dryRun: false, expectedResets: 1 },
    { dryRun: true, expectedResets: 0 },
  ])("resets persistent inventory only outside dry-run (dryRun=$dryRun)", async (testCase) => {
    const result = await executeSyncWithFileInput(
      destination,
      createSingleRangeOptions({
        dryRun: testCase.dryRun,
        resetInventory: true,
      }),
    );

    expect(result.failedFiles).toBe(0);
    expect(mocks.resetInventory).toHaveBeenCalledTimes(testCase.expectedResets);
    if (testCase.dryRun) expect(mocks.initializeInventory).not.toHaveBeenCalled();
  });

  it("runs registered abort and partial-file cleanup against an interrupted destination", async () => {
    let rejectCopy: ((reason: Error) => void) | undefined;
    mocks.copyOrLink.mockImplementation(
      async () =>
        await new Promise<"copy">((_resolve, reject) => {
          rejectCopy = reject;
        }),
    );

    const pendingResult = executeSyncWithFileInput(destination, createSingleRangeOptions());
    await vi.waitFor(() => expect(mocks.copyOrLink).toHaveBeenCalledOnce());

    const registered = new Map(
      mocks.registerGlobalCleanup.mock.calls.map(([registration]) => [
        registration.name as string,
        registration.cleanup as () => Promise<void> | void,
      ]),
    );
    registered.get("sync-abort")?.();
    await registered.get("sync-partial-files")?.();
    rejectCopy?.(new Error("Operation cancelled"));

    const result = await pendingResult;
    const representedDestination = path.join(destination, "Artist", "Album-001", "track.flac");
    expect(result.failedFiles).toBe(1);
    expect(result.failed[0]?.message).toBe("Operation cancelled");
    expect(mocks.cleanupPartialFile).toHaveBeenCalledWith(
      transactionPath(representedDestination, "stage"),
    );
  });

  it.each([
    { name: "successful write", dryRun: false, unchanged: false, writeFails: false, scans: true },
    { name: "no changes", dryRun: false, unchanged: true, writeFails: false, scans: false },
    { name: "write failure", dryRun: false, unchanged: false, writeFails: true, scans: false },
    { name: "dry-run", dryRun: true, unchanged: false, writeFails: false, scans: false },
  ])("gates media scanning after $name", async (testCase) => {
    const triggerSource = vi.fn(async () => ({ success: true, libraryName: "Music" }));
    mocks.resolveOptionalScanAdapter.mockReturnValue({
      adapter: { capabilities: { scan: true }, scan: { triggerSource } },
    });
    if (testCase.unchanged) {
      mocks.computeAlbumSyncDiff.mockResolvedValue(emptyDiff({ unchangedFiles: [sourceFile] }));
    }
    if (testCase.writeFails) {
      mocks.copyOrLink.mockRejectedValue(new Error("copy failed"));
    }

    const options = createSingleRangeOptions({ dryRun: testCase.dryRun });
    if (testCase.dryRun) options.copyOptions.useLegacyTracking = false;
    const result = await executeSyncWithFileInput(destination, options);

    expect(triggerSource).toHaveBeenCalledTimes(testCase.scans ? 1 : 0);
    if (testCase.scans) expect(triggerSource).toHaveBeenCalledWith(destination);
    if (testCase.dryRun) expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    if (testCase.writeFails) expect(result.failedFiles).toBe(1);
  });
});
