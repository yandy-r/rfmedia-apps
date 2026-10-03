import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditConvertedMetadata: vi.fn(),
  createConversionArtworkInput: vi.fn(),
  createOpusMetadataSidecar: vi.fn(),
  ensureDir: vi.fn(),
  exec: vi.fn(),
  getConversionLimitations: vi.fn(),
  getConversionTargetPolicy: vi.fn(),
  lstat: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  open: vi.fn(),
  readConversionMetadataFromHandle: vi.fn(),
  renderConversionWarning: vi.fn(),
  replaceFileWithValidatedStage: vi.fn(),
  spawn: vi.fn(),
  writeConversionMp3Rating: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: mocks.exec,
  spawn: mocks.spawn,
}));

vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat,
  open: mocks.open,
}));

vi.mock("./conversion-metadata.js", () => ({
  auditConvertedMetadata: mocks.auditConvertedMetadata,
  createConversionArtworkInput: mocks.createConversionArtworkInput,
  createOpusMetadataSidecar: mocks.createOpusMetadataSidecar,
  getConversionLimitations: mocks.getConversionLimitations,
  getConversionTargetPolicy: mocks.getConversionTargetPolicy,
  readConversionMetadataFromHandle: mocks.readConversionMetadataFromHandle,
  renderConversionWarning: mocks.renderConversionWarning,
}));

vi.mock("./filesystem.js", () => ({
  ensureDir: mocks.ensureDir,
  replaceFileWithValidatedStage: mocks.replaceFileWithValidatedStage,
}));

vi.mock("./logger.js", () => ({
  logDebug: mocks.logDebug,
  logWarn: mocks.logWarn,
}));

vi.mock("./tag-writer.js", () => ({
  writeConversionMp3Rating: mocks.writeConversionMp3Rating,
}));

import type { ConvertFormat } from "../types/options.js";
import type { ConversionMetadataSnapshot, ConversionWarning } from "./conversion-metadata.js";
import type { ValidatedStageOptions } from "./filesystem.js";
import { convertFile, convertFileWithValidation } from "./convert.js";

const TARGETS = {
  mp3: {
    muxer: "mp3",
    audioArgs: ["-c:a", "libmp3lame", "-b:a", "320k"],
  },
  aac: {
    muxer: "ipod",
    audioArgs: ["-c:a", "aac", "-b:a", "256k"],
  },
  alac: {
    muxer: "ipod",
    audioArgs: ["-c:a", "alac"],
  },
  opus: {
    muxer: "opus",
    audioArgs: ["-c:a", "libopus", "-b:a", "128k"],
  },
} as const;
const EXPECTED_SOURCE_FD_PATH = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
const EXPECTED_STAGE_FD_PATH = process.platform === "linux" ? "/proc/self/fd/4" : "/dev/fd/4";
const EXPECTED_OPUS_METADATA_FD_PATH =
  process.platform === "linux" ? "/proc/self/fd/5" : "/dev/fd/5";
const EXPECTED_ARTWORK_FD_PATH = process.platform === "linux" ? "/proc/self/fd/6" : "/dev/fd/6";

function snapshot(rating: ConversionMetadataSnapshot["rating"] = null): ConversionMetadataSnapshot {
  return {
    sourceTagFamilies: [],
    canonical: {
      artists: [],
      track: {},
      genres: [],
    },
    textTags: [],
    rating,
    pictureCount: 0,
    pictures: [],
    unsupportedNativeFields: [],
  };
}

function makeChild(): EventEmitter & { stderr: EventEmitter } {
  return Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
}

function closeSuccessfully(): EventEmitter & { stderr: EventEmitter } {
  const child = makeChild();
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function regularStats(
  overrides: Partial<Record<"dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "mode", number>> = {},
) {
  return {
    dev: 1,
    ino: 2,
    size: 1_024,
    mtimeMs: 10,
    ctimeMs: 10,
    mode: 0o100644,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

const stagedHandle = {
  fd: 41,
  stat: vi.fn().mockResolvedValue(regularStats()),
};
const opusHandle = { fd: 42 };
const artworkHandle = { fd: 43 };

describe("conversion transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDir.mockResolvedValue(undefined);
    mocks.lstat.mockImplementation(async (filePath: string) => {
      if (filePath.startsWith("/source")) return regularStats();
      throw enoent();
    });
    mocks.open.mockResolvedValue({
      fd: 40,
      stat: vi.fn().mockResolvedValue(regularStats()),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mocks.readConversionMetadataFromHandle.mockResolvedValue(snapshot());
    mocks.getConversionLimitations.mockReturnValue([]);
    mocks.getConversionTargetPolicy.mockImplementation((format: ConvertFormat) => TARGETS[format]);
    mocks.createOpusMetadataSidecar.mockResolvedValue({
      handle: opusHandle,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    mocks.createConversionArtworkInput.mockResolvedValue({
      handle: artworkHandle,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    mocks.auditConvertedMetadata.mockResolvedValue(undefined);
    mocks.renderConversionWarning.mockImplementation(
      (warning: ConversionWarning) => `safe:${warning.code}`,
    );
    mocks.writeConversionMp3Rating.mockResolvedValue({
      success: true,
      message: "Rating written",
      format: "mp3",
    });
    mocks.spawn.mockImplementation(closeSuccessfully);
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
      },
    );
  });

  it.each([
    [
      "mp3",
      [
        "-nostdin",
        "-i",
        EXPECTED_SOURCE_FD_PATH,
        "-map",
        "0:a:0",
        "-map_metadata",
        "0:g",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "320k",
        "-f",
        "mp3",
        "-y",
        EXPECTED_STAGE_FD_PATH,
      ],
    ],
    [
      "aac",
      [
        "-nostdin",
        "-i",
        EXPECTED_SOURCE_FD_PATH,
        "-map",
        "0:a:0",
        "-map_metadata",
        "0:g",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        "-f",
        "ipod",
        "-y",
        EXPECTED_STAGE_FD_PATH,
      ],
    ],
    [
      "alac",
      [
        "-nostdin",
        "-i",
        EXPECTED_SOURCE_FD_PATH,
        "-map",
        "0:a:0",
        "-map_metadata",
        "0:g",
        "-c:a",
        "alac",
        "-f",
        "ipod",
        "-y",
        EXPECTED_STAGE_FD_PATH,
      ],
    ],
    [
      "opus",
      [
        "-nostdin",
        "-i",
        EXPECTED_SOURCE_FD_PATH,
        "-f",
        "ffmetadata",
        "-i",
        EXPECTED_OPUS_METADATA_FD_PATH,
        "-map",
        "0:a:0",
        "-map_metadata",
        "0:g",
        "-map_metadata:s:a",
        "1:g",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
        "-f",
        "opus",
        "-y",
        EXPECTED_STAGE_FD_PATH,
      ],
    ],
  ] as const)("uses fixed discrete %s argv", async (format, expectedArgv) => {
    await convertFile("/source.flac", `/dest/track.${format}`, format);

    expect(mocks.spawn).toHaveBeenCalledWith("ffmpeg", expectedArgv, {
      shell: false,
      signal: expect.any(AbortSignal),
      stdio: ["ignore", "ignore", "pipe", 40, 41, format === "opus" ? 42 : "ignore", "ignore"],
    });
    expect(expectedArgv.at(-2)).toBe("-y");
    expect(expectedArgv.at(-1)).toBe(EXPECTED_STAGE_FD_PATH);
    expect(expectedArgv.filter((token) => token.startsWith("-"))).not.toContainEqual(
      expect.stringMatching(/\s/),
    );
  });

  it("rejects the same canonical source and destination before opening the source", async () => {
    await expect(convertFile("/music/track.flac", "/music/./track.flac", "mp3")).rejects.toThrow(
      "Source and destination must be different files",
    );

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("binds the source inode against destination hardlink aliases at the stage boundary", async () => {
    let forbiddenIdentity: ValidatedStageOptions["forbidDestinationIdentity"];
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        forbiddenIdentity = options.forbidDestinationIdentity;
      },
    );

    await convertFile("/source.flac", "/dest/track.mp3", "mp3");

    expect(forbiddenIdentity).toEqual({ dev: 1, ino: 2 });
  });

  it("parses source metadata through the retained authoritative descriptor", async () => {
    await convertFile("/source.flac", "/dest/track.mp3", "mp3");

    expect(mocks.readConversionMetadataFromHandle).toHaveBeenCalledWith(
      expect.objectContaining({ fd: 40 }),
      "/source.flac",
      undefined,
    );
    expect(mocks.auditConvertedMetadata).toHaveBeenCalledWith(
      expect.any(Object),
      stagedHandle,
      "mp3",
      expect.any(AbortSignal),
    );
  });

  it("rejects a source version change after metadata snapshotting", async () => {
    mocks.lstat
      .mockResolvedValueOnce(regularStats())
      .mockResolvedValueOnce(regularStats())
      .mockResolvedValueOnce(regularStats({ size: 2_048, mtimeMs: 11, ctimeMs: 11 }));

    await expect(convertFile("/source.flac", "/dest/track.mp3", "mp3")).rejects.toThrow(
      "Source changed during conversion",
    );

    expect(mocks.replaceFileWithValidatedStage).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("maps the picture selected by metadata projection", async () => {
    mocks.readConversionMetadataFromHandle.mockResolvedValue({
      ...snapshot(),
      pictureCount: 2,
      pictures: [
        {
          sourceIndex: 1,
          format: "image/png",
          data: new Uint8Array([1]),
          digest: "a".repeat(64),
        },
      ],
    });

    await convertFile("/source.flac", "/dest/track.mp3", "mp3");

    expect(mocks.spawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining([
        "-f",
        "image2pipe",
        "-i",
        EXPECTED_ARTWORK_FD_PATH,
        "-map",
        "1:v:0",
        "-disposition:v:0",
        "attached_pic",
      ]),
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "ignore", "pipe", 40, 41, "ignore", 43],
      }),
    );
    expect(mocks.createConversionArtworkInput).toHaveBeenCalledWith(
      "/dest/track.mp3",
      expect.objectContaining({ sourceIndex: 1, data: new Uint8Array([1]) }),
    );
    const argv = mocks.spawn.mock.calls[0]?.[1] as readonly string[];
    expect(argv).not.toContain("0:v:1?");
  });

  it("refuses work when the conversion signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      convertFile("/source.flac", "/dest/track.mp3", "mp3", undefined, controller.signal),
    ).rejects.toBe(controller.signal.reason);
    expect(mocks.ensureDir).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("settles once and preserves the exact in-flight abort reason", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const reason = { kind: "stop-exactly" };

    const conversion = convertFile(
      "/source.flac",
      "/dest/track.mp3",
      "mp3",
      undefined,
      controller.signal,
    );
    let settled = false;
    void conversion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

    controller.abort(reason);
    child.emit("error", new Error("late process error"));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", 1);

    await expect(conversion).rejects.toBe(reason);
    expect(settled).toBe(true);
    expect(mocks.auditConvertedMetadata).not.toHaveBeenCalled();
  });

  it("orders MP3 POPM, audit, additional validation, and publication", async () => {
    const events: string[] = [];
    mocks.readConversionMetadataFromHandle.mockImplementation(async () => {
      events.push("snapshot");
      return snapshot({
        value: 0.8,
        source: "POPM",
        email: "source@player",
        counter: 42,
      });
    });
    mocks.spawn.mockImplementation(() => {
      events.push("ffmpeg");
      return closeSuccessfully();
    });
    mocks.writeConversionMp3Rating.mockImplementation(async () => {
      events.push("popm");
      return { success: true, message: "Rating written", format: "mp3" };
    });
    mocks.auditConvertedMetadata.mockImplementation(async () => {
      events.push("audit");
    });
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        events.push("stage");
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        events.push("publish");
      },
    );

    await convertFileWithValidation("/source.flac", "/dest/track.mp3", "mp3", {
      additionalValidator: async () => {
        events.push("additional");
      },
    });

    expect(events).toEqual([
      "snapshot",
      "stage",
      "ffmpeg",
      "popm",
      "audit",
      "additional",
      "publish",
    ]);
    expect(mocks.writeConversionMp3Rating).toHaveBeenCalledWith(
      stagedHandle,
      0.8,
      {
        popmEmail: "source@player",
        popmCounter: 42,
      },
      expect.any(AbortSignal),
    );
  });

  it.each([
    [{ no: 3, of: 12 }, "track=3/12"],
    [{ of: 12 }, "track=0/12"],
  ] as const)(
    "writes canonical track components explicitly for FFmpeg targets",
    async (track, expected) => {
      const sourceSnapshot = snapshot();
      mocks.readConversionMetadataFromHandle.mockResolvedValue({
        ...sourceSnapshot,
        canonical: {
          ...sourceSnapshot.canonical,
          track,
        },
      });

      await convertFile("/source.flac", "/dest/track.mp3", "mp3");

      expect(mocks.spawn).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining(["-metadata", expected]),
        expect.objectContaining({ shell: false }),
      );
    },
  );

  it("requires Opus sidecar disposal before publication and retries cleanup on failure", async () => {
    const events: string[] = [];
    const dispose = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("required-dispose");
        throw new Error("cleanup failed");
      })
      .mockImplementationOnce(async () => {
        events.push("safety-dispose");
      });
    mocks.createOpusMetadataSidecar.mockResolvedValue({ handle: opusHandle, dispose });
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        events.push("publish");
      },
    );

    await expect(convertFile("/source.flac", "/dest/track.opus", "opus")).rejects.toThrow(
      "cleanup failed",
    );
    expect(events).toEqual(["required-dispose", "safety-dispose"]);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("disposes the Opus sidecar before successful publication", async () => {
    const events: string[] = [];
    let disposed = false;
    const dispose = vi.fn(async () => {
      if (!disposed) {
        disposed = true;
        events.push("dispose");
      }
    });
    mocks.createOpusMetadataSidecar.mockResolvedValue({ handle: opusHandle, dispose });
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        events.push("publish");
      },
    );

    await convertFile("/source.flac", "/dest/track.opus", "opus");

    expect(events).toEqual(["dispose", "publish"]);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("returns and logs safe warnings only after successful publication", async () => {
    const events: string[] = [];
    const warning: ConversionWarning = {
      code: "rating_unsupported",
      reason: "rating is unsupported",
      target: "aac",
      fields: ["rating"],
      source: "/source.flac",
      destination: "/dest/track.aac",
      outputUsable: true,
    };
    mocks.getConversionLimitations.mockReturnValue([warning]);
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        events.push("publish");
      },
    );
    mocks.logWarn.mockImplementation(() => {
      events.push("warn");
    });

    const result = await convertFile("/source.flac", "/dest/track.aac", "aac");

    expect(result).toMatchObject({ success: true, warnings: [warning] });
    expect(mocks.renderConversionWarning).toHaveBeenCalledWith(warning);
    expect(mocks.logWarn).toHaveBeenCalledWith("safe:rating_unsupported");
    expect(events).toEqual(["publish", "warn"]);
  });

  it("clamps FFmpeg progress below 100 and emits one final 100 after publication", async () => {
    const events: string[] = [];
    mocks.spawn.mockImplementation(() => {
      const child = makeChild();
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("Duration: 00:00:10.00 time=00:00:10.00"));
        child.emit("close", 0);
      });
      return child;
    });
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        events.push("publish");
      },
    );

    await convertFile("/source.flac", "/dest/track.mp3", "mp3", (progress) => {
      events.push(`progress:${progress.percent}`);
    });

    expect(events).toEqual(["progress:99.99", "publish", "progress:100"]);
  });

  it("does not publish, complete progress, or warn when additional validation fails", async () => {
    const events: string[] = [];
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        events.push("publish");
      },
    );

    await expect(
      convertFileWithValidation("/source.flac", "/dest/track.mp3", "mp3", {
        onProgress: (progress) => events.push(`progress:${progress.percent}`),
        additionalValidator: async () => {
          throw new Error("tier failed");
        },
      }),
    ).rejects.toThrow("tier failed");
    expect(events).not.toContain("publish");
    expect(events).not.toContain("progress:100");
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("delegates atomic destination mode preservation with the umask default", async () => {
    const publicationOptions: Array<{
      preserveDestinationMode: boolean | undefined;
      missingDestinationMode: number | undefined;
    }> = [];
    mocks.replaceFileWithValidatedStage.mockImplementation(
      async (_destination: string, options: ValidatedStageOptions) => {
        publicationOptions.push({
          preserveDestinationMode: options.preserveDestinationMode,
          missingDestinationMode: options.missingDestinationMode,
        });
        const stagedSignal = options.signal ?? new AbortController().signal;
        await options.materialize("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
        await options.validate("/dest/.track-stage.tmp", stagedSignal, stagedHandle as never);
      },
    );
    const expectedNewMode = 0o666 & ~process.umask();

    await convertFile("/source.flac", "/dest/existing.mp3", "mp3");

    expect(publicationOptions).toEqual([
      {
        preserveDestinationMode: true,
        missingDestinationMode: expectedNewMode,
      },
    ]);
  });
});
