/**
 * Tests for tag-writer.ts - Audio file rating tag writing.
 *
 * Tests the writeRating function which provides a unified interface for writing
 * ratings to different audio formats (MP3 POPM, FLAC Vorbis comments).
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileHandle } from "node:fs/promises";
import type NodeID3 from "node-id3";

// Mock definitions with vi.hoisted() - must be defined before vi.mock() calls
const mockNodeID3 = vi.hoisted(() => ({
  update: vi.fn((_tags: NodeID3.Tags, source: Buffer): Buffer | boolean => Buffer.from(source)),
  write: vi.fn((_tags: NodeID3.Tags, source: Buffer): Buffer | boolean => Buffer.from(source)),
}));

const mockFlacMetadata = vi.hoisted(() => {
  // Create a mock class for FlacProcessor
  const MockProcessor = class {
    static MDB_TYPE_VORBIS_COMMENT = 4;
    on = vi.fn().mockReturnThis();
    pipe = vi.fn().mockReturnThis();
  };

  return {
    Processor: MockProcessor,
    data: vi.fn().mockReturnValue({ vendor: "test", comments: [] }),
  };
});

const mockFs = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
}));

const mockMp3Files = vi.hoisted(() => {
  let targetSize = 0;
  const effectiveUserId = typeof process.geteuid === "function" ? process.geteuid() : 1000;

  const targetStats = () => ({
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 2,
    nlink: 1,
    size: targetSize,
    mtimeMs: 1,
    ctimeMs: 1,
    mode: 0o640,
    uid: effectiveUserId,
    gid: 1000,
  });
  const parentStats = () => ({
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 1,
    mode: 0o755,
    uid: typeof process.geteuid === "function" ? process.geteuid() : 1000,
  });
  const stageStats = () => ({
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 3,
    nlink: 1,
    size: targetSize,
    mtimeMs: 2,
    ctimeMs: 2,
    uid: effectiveUserId,
    gid: 1000,
    mode: 0o640,
  });
  const sourceHandle = {
    fd: 11,
    stat: vi.fn(async () => targetStats()),
    readFile: vi.fn(async () => Buffer.alloc(targetSize)),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const stageHandle = {
    fd: 12,
    stat: vi.fn(async () => stageStats()),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const parentHandle = {
    fd: 13,
    stat: vi.fn(async () => parentStats()),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    targetStats,
    parentStats,
    stageStats,
    sourceHandle,
    stageHandle,
    parentHandle,
    setTargetSize(size: number): void {
      targetSize = size;
    },
    reset(): void {
      targetSize = 0;
      sourceHandle.stat.mockImplementation(async () => targetStats());
      sourceHandle.readFile.mockImplementation(async () => Buffer.alloc(targetSize));
      sourceHandle.close.mockResolvedValue(undefined);
      stageHandle.stat.mockImplementation(async () => stageStats());
      stageHandle.writeFile.mockResolvedValue(undefined);
      stageHandle.sync.mockResolvedValue(undefined);
      stageHandle.close.mockResolvedValue(undefined);
      parentHandle.stat.mockImplementation(async () => parentStats());
      parentHandle.close.mockResolvedValue(undefined);
    },
  };
});

const mockFsPromises = vi.hoisted(() => ({
  lstat: vi.fn(async (path: string) => {
    if (path.includes(".rfmedia-rating-")) return mockMp3Files.stageStats();
    return path.endsWith(".mp3") || path.endsWith(".MP3") || path.includes(".rfmedia-stage-")
      ? mockMp3Files.targetStats()
      : mockMp3Files.parentStats();
  }),
  open: vi.fn(async (path: string, flags: string | number) =>
    flags === "wx+"
      ? (mockMp3Files.stageHandle as unknown as FileHandle)
      : path.endsWith(".mp3") || path.endsWith(".MP3") || path.includes(".rfmedia-stage-")
        ? (mockMp3Files.sourceHandle as unknown as FileHandle)
        : (mockMp3Files.parentHandle as unknown as FileHandle),
  ),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const mockStreamPromises = vi.hoisted(() => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

const mockChildren = vi.hoisted(() => {
  type ChildEvent = "error" | "exit" | "message";
  type Listener = (...values: unknown[]) => void;
  const instances: MockChild[] = [];
  let response: unknown = { ok: true };
  let spawnDelegate: typeof import("node:child_process").spawn | undefined;
  let metadataCopyExitCode = 0;
  let metadataCopyAutoExit = true;
  let metadataCopyExitOnKillSignal: NodeJS.Signals | undefined = "SIGTERM";

  class MockChild {
    readonly listeners = new Map<ChildEvent, Listener>();
    readonly send = vi.fn((request: unknown, callback: (error: Error | null) => void) => {
      this.request = request;
      callback(null);
      queueMicrotask(() => this.listeners.get("message")?.(response));
    });
    readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      if (this.command !== "/bin/cp" || metadataCopyExitOnKillSignal === signal) {
        queueMicrotask(() => {
          this.signalCode = signal;
          this.listeners.get("exit")?.(null, signal);
        });
      }
      return true;
    });
    readonly disconnect = vi.fn(() => {
      this.connected = false;
    });
    request: unknown;
    connected = true;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    constructor(
      readonly command: string,
      readonly args: readonly string[],
      readonly options: unknown,
    ) {
      instances.push(this);
      if (command === "/bin/cp" && metadataCopyAutoExit) {
        queueMicrotask(() => {
          this.exitCode = metadataCopyExitCode;
          this.listeners.get("exit")?.(metadataCopyExitCode, null);
        });
      }
    }

    once(event: ChildEvent, listener: Listener): this {
      this.listeners.set(event, listener);
      return this;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }
  }

  return {
    spawn(command: string, args: readonly string[], options: unknown): unknown {
      if (spawnDelegate !== undefined) {
        return spawnDelegate(
          command,
          [...args],
          options as import("node:child_process").SpawnOptions,
        );
      }
      return new MockChild(command, args, options);
    },
    instances,
    setResponse(value: unknown): void {
      response = value;
    },
    setSpawnDelegate(value: typeof import("node:child_process").spawn): void {
      spawnDelegate = value;
    },
    setMetadataCopyExitCode(value: number): void {
      metadataCopyExitCode = value;
    },
    setMetadataCopyAutoExit(value: boolean): void {
      metadataCopyAutoExit = value;
    },
    setMetadataCopyExitOnKillSignal(value: NodeJS.Signals | undefined): void {
      metadataCopyExitOnKillSignal = value;
    },
    reset(): void {
      instances.length = 0;
      response = { ok: true };
      spawnDelegate = undefined;
      metadataCopyExitCode = 0;
      metadataCopyAutoExit = true;
      metadataCopyExitOnKillSignal = "SIGTERM";
    },
  };
});

// Apply mocks BEFORE importing the module under test
vi.mock("node-id3", () => ({
  default: mockNodeID3,
}));

vi.mock("flac-metadata", () => ({
  Processor: mockFlacMetadata.Processor,
  data: mockFlacMetadata.data,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    ...mockFs,
  };
});

vi.mock("node:fs/promises", () => mockFsPromises);

vi.mock("node:stream/promises", () => mockStreamPromises);

vi.mock("node:child_process", () => ({
  spawn: mockChildren.spawn as typeof import("node:child_process").spawn,
}));

vi.mock("./logger.js", () => mockLogger);

// Import after mocks
import {
  MAX_CONVERSION_MP3_RATING_FILE_BYTES,
  MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES,
  projectRatingWrite,
  writeConversionMp3Rating,
  writeRating,
} from "./tag-writer.js";

async function waitForMetadataCopyChild(): Promise<(typeof mockChildren.instances)[number]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const child = mockChildren.instances.find((candidate) => candidate.command === "/bin/cp");
    if (child !== undefined) return child;
    await Promise.resolve();
  }
  throw new Error("metadata-copy child was not spawned");
}

async function expectPopmUpdateToPreserveFile(): Promise<void> {
  const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>("node-id3");
  const actualChildProcess =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const fsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const { join } = await vi.importActual<typeof import("node:path")>("node:path");
  const tempDir = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-tag-writer-"));
  const filePath = join(tempDir, "staged.mp3");
  const artwork = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const image = {
    mime: "image/png",
    type: { id: 3 },
    description: "Cover",
    imageBuffer: artwork,
  };

  try {
    await fsPromises.writeFile(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
    expect(actualNodeID3.default.write({ title: "Preserved title", image }, filePath)).toBe(true);
    await fsPromises.chmod(filePath, 0o640);
    const statsBefore = await fsPromises.stat(filePath);
    mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
    mockFsPromises.open.mockImplementation(fsPromises.open);
    mockFsPromises.rename.mockImplementation(fsPromises.rename);
    mockFsPromises.unlink.mockImplementation(fsPromises.unlink);
    mockChildren.setSpawnDelegate(actualChildProcess.spawn);
    mockNodeID3.update.mockImplementationOnce((tags, source) =>
      actualNodeID3.default.update(tags, source),
    );

    const options = { popmEmail: "source@player", popmCounter: 42 };
    const result = await writeRating(filePath, 0.5, options);
    const statsAfter = await fsPromises.stat(filePath);
    const tags = actualNodeID3.default.read(filePath);

    expect(result.success).toBe(true);
    expect(statsAfter.ino).not.toBe(statsBefore.ino);
    expect(statsAfter.mode & 0o7777).toBe(statsBefore.mode & 0o7777);
    expect(statsAfter.uid).toBe(statsBefore.uid);
    expect(statsAfter.gid).toBe(statsBefore.gid);
    expect(tags.title).toBe("Preserved title");
    expect(tags.image).toMatchObject(image);
    expect(tags.popularimeter).toEqual({
      email: "source@player",
      rating: 128,
      counter: 42,
    });
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
}

async function expectBlankPopmEmailToUseFallback(): Promise<void> {
  const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>("node-id3");
  const actualChildProcess =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const fsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const { join } = await vi.importActual<typeof import("node:path")>("node:path");
  const tempDir = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-tag-writer-"));
  const filePath = join(tempDir, "blank-email.mp3");

  try {
    await fsPromises.writeFile(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
    mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
    mockFsPromises.open.mockImplementation(fsPromises.open);
    mockFsPromises.rename.mockImplementation(fsPromises.rename);
    mockFsPromises.unlink.mockImplementation(fsPromises.unlink);
    mockChildren.setSpawnDelegate(actualChildProcess.spawn);
    mockNodeID3.update.mockImplementationOnce((tags, source) =>
      actualNodeID3.default.update(tags, source),
    );

    const result = await writeRating(filePath, 0.8, {
      popmEmail: "",
      popmCounter: 7,
    });
    const tags = actualNodeID3.default.read(filePath);

    expect(result.success).toBe(true);
    expect(tags.popularimeter).toEqual({
      email: "no@email",
      rating: 204,
      counter: 7,
    });
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
}

describe("projectRatingWrite", () => {
  it("projects MP3 values through the POPM quantization used by the reader", () => {
    expect(projectRatingWrite("/music/song.mp3", 0.333)).toEqual({
      supported: true,
      normalized: 85 / 254,
    });
  });

  it.each([
    ["normalized", 0.336, 0.34],
    ["stars", 0.336, 1.7 / 5],
    ["percent", 0.336, 0.34],
  ] as const)(
    "projects FLAC %s values through their configured encoding",
    (scale, input, expected) => {
      expect(projectRatingWrite("/music/song.flac", input, { vorbisScale: scale })).toEqual({
        supported: true,
        normalized: expected,
      });
    },
  );

  it.each(["/music/song.mp3", "/music/song.flac"])(
    "distinguishes zero as an unrepresentable unrated value for %s",
    (path) => {
      expect(projectRatingWrite(path, 0)).toEqual({ supported: true, normalized: null });
    },
  );
});

describe("writeRating", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // NOT resetAllMocks!

    // Re-establish default mock implementations after clearAllMocks
    mockMp3Files.reset();
    mockNodeID3.update.mockImplementation((_tags, source) => Buffer.from(source));
    mockNodeID3.write.mockImplementation((_tags, source) => Buffer.from(source));
    mockFsPromises.lstat.mockImplementation(async (path) => {
      if (path.includes(".rfmedia-rating-")) return mockMp3Files.stageStats();
      return path.endsWith(".mp3") || path.endsWith(".MP3") || path.includes(".rfmedia-stage-")
        ? mockMp3Files.targetStats()
        : mockMp3Files.parentStats();
    });
    mockFsPromises.open.mockImplementation(async (path, flags) =>
      flags === "wx+"
        ? (mockMp3Files.stageHandle as unknown as FileHandle)
        : path.endsWith(".mp3") || path.endsWith(".MP3") || path.includes(".rfmedia-stage-")
          ? (mockMp3Files.sourceHandle as unknown as FileHandle)
          : (mockMp3Files.parentHandle as unknown as FileHandle),
    );
    mockFsPromises.rename.mockResolvedValue(undefined);
    mockFsPromises.unlink.mockResolvedValue(undefined);
    mockStreamPromises.pipeline.mockResolvedValue(undefined);
    mockFlacMetadata.data.mockReturnValue({ vendor: "test", comments: [] });
    mockChildren.reset();
  });

  describe("MP3 files", () => {
    it("keeps the conversion size-limit export as an alias of the general limit", () => {
      expect(MAX_CONVERSION_MP3_RATING_FILE_BYTES).toBe(MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES);
    });

    it.each([
      {
        label: "the exact synchronous size limit",
        size: MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES,
        success: true,
        writerCalls: 1,
      },
      {
        label: "one byte over the synchronous size limit",
        size: MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES + 1,
        success: false,
        writerCalls: 0,
      },
    ])("$label", async ({ size, success, writerCalls }) => {
      mockMp3Files.setTargetSize(size);

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result.success).toBe(success);
      expect(mockNodeID3.update).toHaveBeenCalledTimes(writerCalls);
    });

    it("updates a hardlinked MP3 in place through its pinned descriptor", async () => {
      const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>(
        "node-id3",
      );
      const fsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
      const { join } = await vi.importActual<typeof import("node:path")>("node:path");
      const tempDir = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-hardlink-rating-"));
      const outsideDirectory = join(tempDir, "outside");
      const reviewedDirectory = join(tempDir, "reviewed");
      const outsidePath = join(outsideDirectory, "song.mp3");
      const reviewedPath = join(reviewedDirectory, "song.mp3");

      try {
        await Promise.all([
          fsPromises.mkdir(outsideDirectory),
          fsPromises.mkdir(reviewedDirectory),
        ]);
        await fsPromises.writeFile(outsidePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Shared title" }, outsidePath)).toBe(true);
        await fsPromises.link(outsidePath, reviewedPath);
        mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
        mockFsPromises.open.mockImplementation(fsPromises.open);
        mockNodeID3.update.mockImplementationOnce((tags, source) =>
          typeof source === "string"
            ? actualNodeID3.default.update(tags, source)
            : actualNodeID3.default.update(tags, source),
        );

        const result = await writeRating(reviewedPath, 0.8);
        const [outsideStats, reviewedStats] = await Promise.all([
          fsPromises.stat(outsidePath),
          fsPromises.stat(reviewedPath),
        ]);
        const outsideTags = actualNodeID3.default.read(outsidePath);
        const reviewedTags = actualNodeID3.default.read(reviewedPath);

        expect(result).toEqual({ success: true, message: "Rating written", format: "mp3" });
        expect(outsideStats.ino).toBe(reviewedStats.ino);
        expect(outsideStats.nlink).toBe(2);
        expect(outsideTags.title).toBe("Shared title");
        expect(outsideTags.popularimeter?.rating).toBe(204);
        expect(reviewedTags).toEqual(outsideTags);
        expect(mockNodeID3.write).not.toHaveBeenCalled();
        expect(mockFsPromises.rename).not.toHaveBeenCalled();
      } finally {
        await fsPromises.rm(tempDir, { force: true, recursive: true });
      }
    });

    it("rejects a linked write when the requested entry is swapped during publication", async () => {
      const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>(
        "node-id3",
      );
      const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const fsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
      const { join } = await vi.importActual<typeof import("node:path")>("node:path");
      const tempDir = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-hardlink-swap-"));
      const outsidePath = join(tempDir, "outside.mp3");
      const reviewedPath = join(tempDir, "reviewed.mp3");
      const movedPath = join(tempDir, "moved.mp3");
      const replacementPath = join(tempDir, "replacement.mp3");

      try {
        await fsPromises.writeFile(outsidePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Shared title" }, outsidePath)).toBe(true);
        await fsPromises.link(outsidePath, reviewedPath);
        await fsPromises.writeFile(replacementPath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Replacement" }, replacementPath)).toBe(true);
        mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
        mockFsPromises.open.mockImplementation(fsPromises.open);
        mockNodeID3.update.mockImplementationOnce((tags, source) => {
          const result =
            typeof source === "string"
              ? actualNodeID3.default.update(tags, source)
              : actualNodeID3.default.update(tags, source);
          actualFs.renameSync(reviewedPath, movedPath);
          actualFs.renameSync(replacementPath, reviewedPath);
          return result;
        });

        const result = await writeRating(reviewedPath, 0.8);
        const [outsideStats, movedStats, reviewedStats] = await Promise.all([
          fsPromises.stat(outsidePath),
          fsPromises.stat(movedPath),
          fsPromises.stat(reviewedPath),
        ]);

        expect(result).toEqual({
          success: false,
          message: "MP3 rating-write target changed during linked publication",
          format: "mp3",
        });
        expect(outsideStats.ino).toBe(movedStats.ino);
        expect(outsideStats.ino).not.toBe(reviewedStats.ino);
        expect(actualNodeID3.default.read(reviewedPath).title).toBe("Replacement");
      } finally {
        await fsPromises.rm(tempDir, { force: true, recursive: true });
      }
    });

    it("rejects a group- or world-writable ancestor before creating a stage", async () => {
      mockFsPromises.lstat.mockImplementation(async (path) => {
        if (path === "/path") {
          return { ...mockMp3Files.parentStats(), mode: 0o777 };
        }
        if (path.includes(".rfmedia-rating-")) return mockMp3Files.stageStats();
        return path.endsWith(".mp3") ? mockMp3Files.targetStats() : mockMp3Files.parentStats();
      });

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating-write parent ancestry is not trusted",
        format: "mp3",
      });
      expect(mockFsPromises.open).not.toHaveBeenCalled();
    });

    it("replaces a post-validation symlink swap without mutating its referent", async () => {
      const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>(
        "node-id3",
      );
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const fsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
      const { join } = await vi.importActual<typeof import("node:path")>("node:path");
      const tempDir = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-rating-swap-"));
      const targetPath = join(tempDir, "song.mp3");
      const movedTargetPath = join(tempDir, "validated-song.mp3");
      const referentPath = join(tempDir, "outside.mp3");
      const referent = Buffer.from("must-not-change");

      try {
        await fsPromises.writeFile(targetPath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Validated title" }, targetPath)).toBe(true);
        await fsPromises.writeFile(referentPath, referent);
        mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
        mockFsPromises.open.mockImplementation(fsPromises.open);
        mockFsPromises.unlink.mockImplementation(fsPromises.unlink);
        mockChildren.setSpawnDelegate(actualChildProcess.spawn);
        mockNodeID3.update.mockImplementationOnce((tags, source) =>
          actualNodeID3.default.update(tags, source),
        );
        mockFsPromises.rename.mockImplementationOnce(async (stagePath, publishedPath) => {
          await fsPromises.rename(targetPath, movedTargetPath);
          await fsPromises.symlink(referentPath, targetPath);
          await fsPromises.rename(stagePath, publishedPath);
        });

        const result = await writeRating(targetPath, 0.8);
        const publishedStats = await fsPromises.lstat(targetPath);
        const publishedTags = actualNodeID3.default.read(targetPath);

        expect(result).toEqual({ success: true, message: "Rating written", format: "mp3" });
        expect(publishedStats.isSymbolicLink()).toBe(false);
        expect(publishedTags.title).toBe("Validated title");
        expect(publishedTags.popularimeter?.rating).toBe(204);
        await expect(fsPromises.readFile(referentPath)).resolves.toEqual(referent);
        await expect(fsPromises.readdir(tempDir)).resolves.not.toEqual(
          expect.arrayContaining([expect.stringContaining(".rfmedia-rating-")]),
        );
      } finally {
        await fsPromises.rm(tempDir, { force: true, recursive: true });
      }
    });

    it("publishes through the pinned parent when its pathname is replaced after final validation", async () => {
      const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>(
        "node-id3",
      );
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const fsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
      const { join } = await vi.importActual<typeof import("node:path")>("node:path");
      const tempRoot = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-rating-parent-aba-"));
      const reviewedDirectory = join(tempRoot, "reviewed");
      const pinnedDirectory = join(tempRoot, "pinned");
      const targetPath = join(reviewedDirectory, "song.mp3");
      const pinnedTargetPath = join(pinnedDirectory, "song.mp3");
      const decoy = Buffer.from("attacker-controlled-parent");

      try {
        await fsPromises.mkdir(reviewedDirectory);
        await fsPromises.writeFile(targetPath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Pinned parent" }, targetPath)).toBe(true);
        mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
        mockFsPromises.open.mockImplementation(fsPromises.open);
        mockFsPromises.unlink.mockImplementation(fsPromises.unlink);
        mockChildren.setSpawnDelegate(actualChildProcess.spawn);
        mockNodeID3.update.mockImplementationOnce((tags, source) =>
          actualNodeID3.default.update(tags, source),
        );
        mockFsPromises.rename.mockImplementationOnce(async (stagePath, publishedPath) => {
          await fsPromises.rename(reviewedDirectory, pinnedDirectory);
          await fsPromises.mkdir(reviewedDirectory);
          await fsPromises.writeFile(targetPath, decoy);
          await fsPromises.rename(stagePath, publishedPath);
        });

        const result = await writeRating(targetPath, 0.8);
        const publishedTags = actualNodeID3.default.read(pinnedTargetPath);

        expect(result).toEqual({ success: true, message: "Rating written", format: "mp3" });
        await expect(fsPromises.readFile(targetPath)).resolves.toEqual(decoy);
        expect(publishedTags.title).toBe("Pinned parent");
        expect(publishedTags.popularimeter?.rating).toBe(204);
      } finally {
        await fsPromises.rm(tempRoot, { force: true, recursive: true });
      }
    });

    it("cleans a failed stage through the pinned parent after a parent pathname ABA", async () => {
      const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>(
        "node-id3",
      );
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const fsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
      const { join } = await vi.importActual<typeof import("node:path")>("node:path");
      const tempRoot = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-rating-cleanup-aba-"));
      const reviewedDirectory = join(tempRoot, "reviewed");
      const pinnedDirectory = join(tempRoot, "pinned");
      const targetPath = join(reviewedDirectory, "song.mp3");
      const decoy = Buffer.from("attacker-controlled-parent");

      try {
        await fsPromises.mkdir(reviewedDirectory);
        await fsPromises.writeFile(targetPath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Original" }, targetPath)).toBe(true);
        mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
        mockFsPromises.open.mockImplementation(fsPromises.open);
        mockFsPromises.unlink.mockImplementation(fsPromises.unlink);
        mockChildren.setSpawnDelegate(actualChildProcess.spawn);
        mockNodeID3.update.mockImplementationOnce((tags, source) =>
          actualNodeID3.default.update(tags, source),
        );
        mockFsPromises.rename.mockImplementationOnce(async () => {
          await fsPromises.rename(reviewedDirectory, pinnedDirectory);
          await fsPromises.mkdir(reviewedDirectory);
          await fsPromises.writeFile(targetPath, decoy);
          throw new Error("publication refused");
        });

        const result = await writeRating(targetPath, 0.8);
        const pinnedEntries = await fsPromises.readdir(pinnedDirectory);
        const replacementEntries = await fsPromises.readdir(reviewedDirectory);

        expect(result).toEqual({
          success: false,
          message: "MP3 rating write could not be published safely",
          format: "mp3",
        });
        expect(pinnedEntries).toEqual(["song.mp3"]);
        expect(replacementEntries).toEqual(["song.mp3"]);
        await expect(fsPromises.readFile(targetPath)).resolves.toEqual(decoy);
      } finally {
        await fsPromises.rm(tempRoot, { force: true, recursive: true });
      }
    });

    it("rejects an MP3 source owned by an untrusted user before transformation", async () => {
      const effectiveUserId = typeof process.geteuid === "function" ? process.geteuid() : 1000;
      mockFsPromises.lstat.mockImplementation(async (path) =>
        path.endsWith(".mp3")
          ? { ...mockMp3Files.targetStats(), uid: effectiveUserId + 1 }
          : mockMp3Files.parentStats(),
      );

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating writes require a trusted, non-foreign-writable regular file",
        format: "mp3",
      });
      expect(mockNodeID3.update).not.toHaveBeenCalled();
      expect(mockFsPromises.rename).not.toHaveBeenCalled();
    });

    it("rejects group, world, or ACL-effective source writes before transformation", async () => {
      mockFsPromises.lstat.mockImplementation(async (path) =>
        path.endsWith(".mp3")
          ? { ...mockMp3Files.targetStats(), mode: 0o660 }
          : mockMp3Files.parentStats(),
      );

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating writes require a trusted, non-foreign-writable regular file",
        format: "mp3",
      });
      expect(mockNodeID3.update).not.toHaveBeenCalled();
      expect(mockFsPromises.rename).not.toHaveBeenCalled();
    });

    it("refuses publication when a concurrent writer changes the source after final preparation", async () => {
      let sourceStatCalls = 0;
      mockMp3Files.sourceHandle.stat.mockImplementation(async () => {
        sourceStatCalls += 1;
        const stats = mockMp3Files.targetStats();
        return sourceStatCalls === 4
          ? {
              ...stats,
              size: stats.size + 1,
              mtimeMs: stats.mtimeMs + 1,
              ctimeMs: stats.ctimeMs + 1,
            }
          : stats;
      });

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating-write target changed before publication",
        format: "mp3",
      });
      expect(mockFsPromises.rename).not.toHaveBeenCalled();
    });

    it("should write POPM rating to MP3 file with default options", async () => {
      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result.success).toBe(true);
      expect(result.format).toBe("mp3");
      expect(result.message).toBe("Rating written");

      // Verify node-id3 was called with correct parameters
      expect(mockNodeID3.update).toHaveBeenCalledWith(
        {
          popularimeter: {
            email: "no@email",
            rating: expect.any(Number),
            counter: 0,
          },
        },
        expect.any(Buffer),
      );

      // Verify POPM value calculation: 0.8 * 254 + 1 = 204
      const callArgs = mockNodeID3.update.mock.calls[0];
      expect(callArgs?.[0]?.popularimeter?.rating).toBe(204);
    });

    it("should preserve explicit POPM email and counter", async () => {
      const options = { popmEmail: "custom@player.com", popmCounter: 42 };

      await writeRating("/path/to/song.mp3", 0.5, options);

      const callArgs = mockNodeID3.update.mock.calls[0];
      expect(callArgs?.[0]?.popularimeter?.email).toBe("custom@player.com");
      expect(callArgs?.[0]?.popularimeter?.counter).toBe(42);
      expect(callArgs?.[1]).toEqual(expect.any(Buffer));
    });

    it("should use the default POPM identity when the source email is whitespace", async () => {
      await writeRating("/path/to/song.mp3", 0.5, { popmEmail: " \t " });

      const callArgs = mockNodeID3.update.mock.calls[0];
      expect(callArgs?.[0]?.popularimeter?.email).toBe("no@email");
    });

    it("should use NodeID3.write when preserveTags is false", async () => {
      await writeRating("/path/to/song.mp3", 0.6, { preserveTags: false });

      expect(mockNodeID3.write).toHaveBeenCalled();
      expect(mockNodeID3.update).not.toHaveBeenCalled();
    });

    it("should preserve existing tags by updating a descriptor-read buffer by default", async () => {
      await writeRating("/path/to/song.mp3", 0.6);

      expect(mockNodeID3.update).toHaveBeenCalledWith(expect.any(Object), expect.any(Buffer));
      expect(mockNodeID3.write).not.toHaveBeenCalled();
    });

    it("should use an explicit format for a private staged path", async () => {
      const stagedPath = "/path/to/.song.mp3.rfmedia-stage-id.tmp";

      const result = await writeRating(stagedPath, 0.6, { formatOverride: "mp3" });

      expect(result).toMatchObject({ success: true, format: "mp3" });
      expect(mockNodeID3.update).toHaveBeenCalledWith(expect.any(Object), expect.any(Buffer));
    });

    it("should atomically replace the file while retaining mode, title, and artwork", async () => {
      await expectPopmUpdateToPreserveFile();
    });

    it("fails closed before publication when required metadata cannot be retained", async () => {
      mockChildren.setMetadataCopyExitCode(1);

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating-write metadata could not be retained",
        format: "mp3",
      });
      expect(mockFsPromises.rename).not.toHaveBeenCalled();
      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        expect.stringMatching(/^\/proc\/self\/fd\/13\/\.song\.mp3\.rfmedia-rating-/),
      );
    });

    it("rejects a stage content change between its prepared snapshot and anchored rename", async () => {
      let statCalls = 0;
      mockMp3Files.stageHandle.stat.mockImplementation(async () => {
        statCalls += 1;
        const stats = mockMp3Files.targetStats();
        return {
          ...stats,
          ino: 3,
          ...(statCalls === 3 ? { ctimeMs: stats.ctimeMs + 1 } : {}),
        };
      });

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating-write stage changed before publication",
        format: "mp3",
      });
      expect(mockFsPromises.rename).not.toHaveBeenCalled();
    });

    it("rejects a substituted anchored stage entry immediately before publication", async () => {
      mockFsPromises.lstat.mockImplementation(async (path) => {
        if (path.includes(".rfmedia-rating-")) {
          return { ...mockMp3Files.stageStats(), ino: 99 };
        }
        return path.endsWith(".mp3") ? mockMp3Files.targetStats() : mockMp3Files.parentStats();
      });

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating-write stage changed before publication",
        format: "mp3",
      });
      expect(mockFsPromises.rename).not.toHaveBeenCalled();
      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });

    it("does not unlink a substituted stage entry during failed-write cleanup", async () => {
      mockChildren.setMetadataCopyExitCode(1);
      mockFsPromises.lstat.mockImplementation(async (path) => {
        if (path.includes(".rfmedia-rating-")) {
          return { ...mockMp3Files.stageStats(), ino: 99 };
        }
        return path.endsWith(".mp3") ? mockMp3Files.targetStats() : mockMp3Files.parentStats();
      });

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result).toEqual({
        success: false,
        message: "MP3 rating-write metadata could not be retained",
        format: "mp3",
      });
      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });

    it("bounds metadata preservation and escalates from SIGTERM to SIGKILL", async () => {
      vi.useFakeTimers();
      try {
        mockChildren.setMetadataCopyAutoExit(false);
        mockChildren.setMetadataCopyExitOnKillSignal("SIGKILL");
        const resultPromise = writeRating("/path/to/song.mp3", 0.8);
        const child = await waitForMetadataCopyChild();

        await vi.advanceTimersByTimeAsync(30_000);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

        await vi.advanceTimersByTimeAsync(1_000);

        await expect(resultPromise).resolves.toEqual({
          success: false,
          message: "MP3 rating-write metadata could not be retained",
          format: "mp3",
        });
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("aborts metadata preservation with the exact reason and reaps the child", async () => {
      vi.useFakeTimers();
      try {
        mockChildren.setMetadataCopyAutoExit(false);
        mockChildren.setMetadataCopyExitOnKillSignal("SIGKILL");
        const controller = new AbortController();
        const reason = new Error("cancel metadata preservation");
        const resultPromise = writeRating("/path/to/song.mp3", 0.8, {
          signal: controller.signal,
        });
        const rejection = expect(resultPromise).rejects.toBe(reason);
        const child = await waitForMetadataCopyChild();

        controller.abort(reason);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");

        await vi.advanceTimersByTimeAsync(1_000);

        await rejection;
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves supported extended attributes and POSIX ACLs on replacement", async () => {
      if (process.platform !== "linux") return;

      const actualNodeID3 = await vi.importActual<{ default: typeof import("node-id3") }>(
        "node-id3",
      );
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const fsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
      const { join } = await vi.importActual<typeof import("node:path")>("node:path");
      const tempDir = await fsPromises.mkdtemp(join(tmpdir(), "rfmedia-rating-metadata-"));
      const filePath = join(tempDir, "metadata.mp3");
      const execFile = (
        command: string,
        args: readonly string[],
      ): Promise<{ readonly stdout: string }> =>
        new Promise((resolveCommand, rejectCommand) => {
          actualChildProcess.execFile(command, [...args], { encoding: "utf8" }, (error, stdout) => {
            if (error !== null) rejectCommand(error);
            else resolveCommand({ stdout });
          });
        });

      try {
        await fsPromises.writeFile(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
        expect(actualNodeID3.default.write({ title: "Metadata" }, filePath)).toBe(true);
        try {
          await execFile("setfattr", ["-n", "user.rfmedia_test", "-v", "preserved", filePath]);
          await execFile("setfacl", ["-m", "u:65534:r--", filePath]);
        } catch {
          return;
        }
        const statsBefore = await fsPromises.stat(filePath);
        mockFsPromises.lstat.mockImplementation(fsPromises.lstat);
        mockFsPromises.open.mockImplementation(fsPromises.open);
        mockFsPromises.rename.mockImplementation(fsPromises.rename);
        mockFsPromises.unlink.mockImplementation(fsPromises.unlink);
        mockChildren.setSpawnDelegate(actualChildProcess.spawn);
        mockNodeID3.update.mockImplementationOnce((tags, source) =>
          actualNodeID3.default.update(tags, source),
        );

        const result = await writeRating(filePath, 0.8);
        const statsAfter = await fsPromises.stat(filePath);
        const xattr = await execFile("getfattr", [
          "--only-values",
          "-n",
          "user.rfmedia_test",
          filePath,
        ]);
        const acl = await execFile("getfacl", ["-cpn", filePath]);

        expect(result).toEqual({ success: true, message: "Rating written", format: "mp3" });
        expect(statsAfter.uid).toBe(statsBefore.uid);
        expect(statsAfter.gid).toBe(statsBefore.gid);
        expect(xattr.stdout.trim()).toBe("preserved");
        expect(acl.stdout).toContain("user:65534:r--");
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should write a fallback POPM identity when the source email is blank", async () => {
      await expectBlankPopmEmailToUseFallback();
    });

    it("should handle unrated (0) value correctly for MP3", async () => {
      await writeRating("/path/to/song.mp3", 0);

      const callArgs = mockNodeID3.update.mock.calls[0];
      // POPM 0 means unrated
      expect(callArgs?.[0]?.popularimeter?.rating).toBe(0);
    });

    it("should handle maximum rating (1.0) correctly for MP3", async () => {
      await writeRating("/path/to/song.mp3", 1.0);

      const callArgs = mockNodeID3.update.mock.calls[0];
      // 1.0 * 254 + 1 = 255
      expect(callArgs?.[0]?.popularimeter?.rating).toBe(255);
    });

    it("should return failure when node-id3 returns false", async () => {
      mockNodeID3.update.mockReturnValue(false);

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBe("mp3");
      expect(result.message).toBe("node-id3 write failed");
    });

    it("should return a bounded failure when node-id3 throws", async () => {
      mockNodeID3.update.mockImplementation(() => {
        throw new Error("File not found");
      });

      const result = await writeRating("/path/to/song.mp3", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBe("mp3");
      expect(result.message).toBe("node-id3 write failed");
    });

    it("should handle case-insensitive extension detection", async () => {
      await writeRating("/path/to/song.MP3", 0.8);

      expect(mockNodeID3.update).toHaveBeenCalled();
    });
  });

  describe("FLAC files", () => {
    it("should write Vorbis RATING comment with normalized scale (default)", async () => {
      const result = await writeRating("/path/to/song.flac", 0.8);

      expect(result.success).toBe(true);
      expect(result.format).toBe("flac");
      expect(result.message).toBe("Rating written");
      expect(mockStreamPromises.pipeline).toHaveBeenCalled();
      expect(mockFsPromises.rename).toHaveBeenCalled();
    });

    it("should write Vorbis RATING comment with stars scale", async () => {
      const result = await writeRating("/path/to/song.flac", 0.8, {
        vorbisScale: "stars",
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe("flac");
    });

    it("should write Vorbis RATING comment with percent scale", async () => {
      const result = await writeRating("/path/to/song.flac", 0.8, {
        vorbisScale: "percent",
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe("flac");
    });

    it("should clean up temp file on error", async () => {
      mockStreamPromises.pipeline.mockRejectedValue(new Error("Stream processing failed"));

      const result = await writeRating("/path/to/song.flac", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBe("flac");
      expect(result.message).toBe("Stream processing failed");
      // Should attempt to clean up temp file
      expect(mockFsPromises.unlink).toHaveBeenCalled();
    });

    it("should handle unlink failure gracefully during cleanup", async () => {
      mockStreamPromises.pipeline.mockRejectedValue(new Error("Stream processing failed"));
      mockFsPromises.unlink.mockRejectedValue(new Error("Cannot delete temp"));

      const result = await writeRating("/path/to/song.flac", 0.8);

      // Should still return the original error, not the cleanup error
      expect(result.success).toBe(false);
      expect(result.message).toBe("Stream processing failed");
    });

    it("should handle case-insensitive extension detection", async () => {
      const result = await writeRating("/path/to/song.FLAC", 0.8);

      expect(result.format).toBe("flac");
    });
  });

  describe("OGG/Opus files", () => {
    it("should return failure for OGG files", async () => {
      const result = await writeRating("/path/to/song.ogg", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBe("ogg");
      expect(result.message).toBe("OGG/Opus tag writing not yet implemented");
    });

    it("should return failure for Opus files", async () => {
      const result = await writeRating("/path/to/song.opus", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBe("ogg");
      expect(result.message).toBe("OGG/Opus tag writing not yet implemented");
    });
  });

  describe("M4A/AAC files", () => {
    it("should return failure for M4A files with iTunes database message", async () => {
      const result = await writeRating("/path/to/song.m4a", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBeUndefined();
      expect(result.message).toBe("M4A/AAC ratings stored in iTunes database, not file tags");
    });

    it("should return failure for AAC files with iTunes database message", async () => {
      const result = await writeRating("/path/to/song.aac", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBeUndefined();
      expect(result.message).toContain("iTunes database");
    });
  });

  describe("Unsupported formats", () => {
    it("should return failure for unknown extensions", async () => {
      const result = await writeRating("/path/to/song.xyz", 0.8);

      expect(result.success).toBe(false);
      expect(result.format).toBeUndefined();
      expect(result.message).toBe("Unsupported format: xyz");
    });

    it("should return failure for WAV files", async () => {
      const result = await writeRating("/path/to/song.wav", 0.8);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unsupported format");
    });

    it("should return failure for WMA files", async () => {
      const result = await writeRating("/path/to/song.wma", 0.8);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unsupported format");
    });

    it("should handle files without extension", async () => {
      const result = await writeRating("/path/to/song", 0.8);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unsupported format");
    });
  });

  describe("Rating value edge cases", () => {
    it("should handle negative rating as unrated for MP3", async () => {
      await writeRating("/path/to/song.mp3", -0.5);

      const callArgs = mockNodeID3.update.mock.calls[0];
      expect(callArgs?.[0]?.popularimeter?.rating).toBe(0);
    });

    it("should clamp minimum rating to 0 for MP3", async () => {
      await writeRating("/path/to/song.mp3", 0.001);

      const callArgs = mockNodeID3.update.mock.calls[0];
      // 0.001 * 254 + 1 = ~1, should be positive
      expect(callArgs?.[0]?.popularimeter?.rating).toBeGreaterThan(0);
    });

    it("should handle boundary values for POPM calculation", async () => {
      // Test 0.5 (2.5 stars) - should be around 128
      await writeRating("/path/to/song.mp3", 0.5);

      const callArgs = mockNodeID3.update.mock.calls[0];
      // 0.5 * 254 + 1 = 128
      expect(callArgs?.[0]?.popularimeter?.rating).toBe(128);
    });
  });

  describe("Path handling", () => {
    it("should handle paths with spaces", async () => {
      const result = await writeRating("/path/to/my song.mp3", 0.8);

      expect(result.success).toBe(true);
      expect(mockNodeID3.update).toHaveBeenCalledWith(expect.any(Object), expect.any(Buffer));
    });

    it("should handle paths with unicode characters", async () => {
      const result = await writeRating("/path/to/caf\u00e9.mp3", 0.8);

      expect(result.success).toBe(true);
      expect(mockNodeID3.update).toHaveBeenCalledWith(expect.any(Object), expect.any(Buffer));
    });

    it("should handle Windows-style paths", async () => {
      const result = await writeRating("C:\\Music\\song.mp3", 0.8);

      expect(result.success).toBe(true);
    });
  });
});

describe("writeConversionMp3Rating", () => {
  const stagedStat = vi.fn();
  const stagedFile = { fd: 17, stat: stagedStat } as unknown as FileHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildren.reset();
    stagedStat.mockResolvedValue({
      size: MAX_CONVERSION_MP3_RATING_FILE_BYTES,
      isFile: () => true,
    });
  });

  it("accepts the size cap and passes only the authoritative descriptor to the worker", async () => {
    const result = await writeConversionMp3Rating(stagedFile, 0.5, {
      popmEmail: "source@player",
      popmCounter: 42,
    });

    expect(result).toEqual({ success: true, message: "Rating written", format: "mp3" });
    const child = mockChildren.instances[0];
    expect(child?.command).toBe(process.execPath);
    expect(child?.args).toEqual([
      "--max-old-space-size=128",
      "--max-semi-space-size=32",
      "--stack-size=4096",
      "--import",
      "tsx",
      expect.stringMatching(/conversion-rating-worker\.ts$/),
    ]);
    expect(child?.args.join(" ")).not.toContain("source@player");
    expect(child?.options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", 17, "ipc"],
    });
    expect(child?.request).toEqual({
      rating: 0.5,
      popmEmail: "source@player",
      popmCounter: 42,
    });
    expect(child?.disconnect).toHaveBeenCalledOnce();
    expect(child?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns a sanitized failure from the isolated worker", async () => {
    mockChildren.setResponse({ ok: false, message: "node-id3 conversion write failed" });

    await expect(writeConversionMp3Rating(stagedFile, 0.8)).resolves.toEqual({
      success: false,
      message: "node-id3 conversion write failed",
      format: "mp3",
    });
  });

  it("rejects a staged MP3 above the synchronous writer cap before spawning", async () => {
    stagedStat.mockResolvedValue({
      size: MAX_CONVERSION_MP3_RATING_FILE_BYTES + 1,
      isFile: () => true,
    });

    await expect(writeConversionMp3Rating(stagedFile, 0.8)).resolves.toEqual({
      success: false,
      message: "Conversion MP3 exceeds the safe synchronous rating-write size limit",
      format: "mp3",
    });
    expect(mockChildren.instances).toHaveLength(0);
  });

  it("aborts with the exact signal reason and terminates the worker", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel rating write");
    const result = writeConversionMp3Rating(stagedFile, 0.8, {}, controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(mockChildren.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(mockChildren.instances[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
