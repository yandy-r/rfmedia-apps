import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";

import type { IAudioMetadata, IPicture } from "music-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

type NativeTags = IAudioMetadata["native"];

const mockFs = vi.hoisted(() => ({
  openImpl: undefined as ((...args: readonly unknown[]) => Promise<unknown>) | undefined,
  reset(): void {
    this.openImpl = undefined;
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      mockFs.openImpl === undefined ? actual.open(...args) : mockFs.openImpl(...args),
  };
});

const mockChildren = vi.hoisted(() => {
  type ChildEvent = "error" | "exit" | "message";
  type Listener = (...values: unknown[]) => void;
  type QueuedEvent = { readonly event: ChildEvent; readonly values: readonly unknown[] };
  const queuedEvents: QueuedEvent[] = [];
  const instances: MockChild[] = [];
  let holdNext = false;

  class MockChild {
    readonly listeners = new Map<ChildEvent, Listener>();
    readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      this.signalCode = signal;
      queueMicrotask(() => this.listeners.get("exit")?.(null, signal));
      return true;
    });
    readonly disconnect = vi.fn(() => {
      this.connected = false;
    });
    connected = true;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    constructor(
      readonly command: string,
      readonly args: readonly string[],
      readonly options: unknown,
    ) {
      instances.push(this);
      queueMicrotask(() => {
        if (holdNext) {
          holdNext = false;
          return;
        }
        const next = queuedEvents.shift() ?? {
          event: "error",
          values: [new Error("unconfigured child")],
        };
        this.listeners.get(next.event)?.(...next.values);
      });
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
    spawn(command: string, args: readonly string[], options: unknown): MockChild {
      return new MockChild(command, args, options);
    },
    instances,
    queue(event: ChildEvent, ...values: readonly unknown[]): void {
      queuedEvents.push({ event, values });
    },
    hold(): void {
      holdNext = true;
    },
    reset(): void {
      queuedEvents.length = 0;
      instances.length = 0;
      holdNext = false;
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: mockChildren.spawn,
}));

import {
  ConversionMetadataError,
  auditConversionMetadataSnapshots,
  auditConvertedMetadata,
  buildFlacPictureBlock,
  createConversionArtworkInput,
  createOpusMetadataSidecar,
  escapeFfmetadataKey,
  escapeFfmetadataValue,
  getConversionLimitations,
  getConversionTargetPolicy,
  projectConversionMetadataForChild,
  readConversionMetadata,
  renderConversionWarning,
  serializeOpusMetadata,
  type ConversionMetadataSnapshot,
  type ConversionPicture,
} from "./conversion-metadata.js";

const METADATA_FD_PATH = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
const TINY_PICTURE_BYTES = Uint8Array.from([1, 2, 3]);
const TINY_PICTURE_DIGEST = createHash("sha256").update(TINY_PICTURE_BYTES).digest("hex");
const TINY_PICTURE: ConversionPicture = {
  sourceIndex: 0,
  format: "image/png",
  type: "Cover (front)",
  description: "",
  data: TINY_PICTURE_BYTES,
  digest: TINY_PICTURE_DIGEST,
};

function makeMetadata(
  options: {
    readonly common?: Partial<IAudioMetadata["common"]>;
    readonly native?: NativeTags;
    readonly pictures?: readonly IPicture[];
    readonly tagTypes?: IAudioMetadata["format"]["tagTypes"];
    readonly warnings?: readonly { readonly message: string }[];
  } = {},
): IAudioMetadata {
  const native = options.native ?? {};
  return {
    format: {
      trackInfo: [],
      tagTypes: options.tagTypes ?? [],
    },
    native,
    quality: {
      warnings: [...(options.warnings ?? [])],
    },
    common: {
      ...options.common,
      track: options.common?.track ?? { no: null, of: null },
      disk: options.common?.disk ?? { no: null, of: null },
      movementIndex: options.common?.movementIndex ?? { no: null, of: null },
      ...(options.pictures === undefined ? {} : { picture: [...options.pictures] }),
    },
  };
}

function makeSnapshot(
  overrides: Partial<ConversionMetadataSnapshot> = {},
): ConversionMetadataSnapshot {
  return {
    sourceTagFamilies: [],
    canonical: {
      artists: [],
      track: {},
      genres: [],
    },
    textTags: [],
    rating: null,
    pictureCount: 0,
    pictures: [],
    unsupportedNativeFields: [],
    ...overrides,
  };
}

function queueChildSnapshot(snapshot: ConversionMetadataSnapshot): void {
  mockChildren.queue("message", serialize({ ok: true, snapshot }));
}

async function withLocalFile<T>(
  extension: string,
  callback: (filePath: string, tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-conversion-metadata-"));
  const filePath = join(tempDir, `track.${extension}`);
  await writeFile(filePath, "audio");
  try {
    return await callback(filePath, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function auditLocalFile(
  source: ConversionMetadataSnapshot,
  destinationPath: string,
  target: "mp3" | "aac" | "alac" | "opus",
  signal?: AbortSignal,
): Promise<void> {
  const handle = await open(destinationPath, "r");
  try {
    await auditConvertedMetadata(source, handle, target, signal);
  } finally {
    await handle.close();
  }
}

beforeEach(() => {
  mockFs.reset();
  mockChildren.reset();
});

describe("conversion target policies", () => {
  it.each([
    {
      format: "mp3" as const,
      expected: {
        container: "mp3",
        muxer: "mp3",
        audioArgs: ["-c:a", "libmp3lame", "-b:a", "320k"],
        artworkMode: "attached-picture-copy",
        ratingMode: "popm-postwrite",
        customTextMode: "mapped-and-audited",
      },
    },
    {
      format: "aac" as const,
      expected: {
        container: "m4a",
        muxer: "ipod",
        audioArgs: ["-c:a", "aac", "-b:a", "256k"],
        artworkMode: "attached-picture-copy",
        ratingMode: "unsupported",
        customTextMode: "unsupported",
      },
    },
    {
      format: "alac" as const,
      expected: {
        container: "m4a",
        muxer: "ipod",
        audioArgs: ["-c:a", "alac"],
        artworkMode: "attached-picture-copy",
        ratingMode: "unsupported",
        customTextMode: "unsupported",
      },
    },
    {
      format: "opus" as const,
      expected: {
        container: "opus",
        muxer: "opus",
        audioArgs: ["-c:a", "libopus", "-b:a", "128k"],
        artworkMode: "vorbis-picture-comment",
        ratingMode: "vorbis-comment",
        customTextMode: "mapped-and-audited",
      },
    },
  ])("defines the exhaustive $format policy", ({ format, expected }) => {
    const policy = getConversionTargetPolicy(format);

    expect(policy).toEqual({ format, ...expected });
    expect(policy.audioArgs.every((token) => !/\s/.test(token))).toBe(true);
    expect(policy.audioArgs).not.toContain("use_metadata_tags");
  });
});

describe("source snapshot", () => {
  it("projects canonical, native-first rating, custom identity, and front artwork", () => {
    const metadata = makeMetadata({
      common: {
        title: "Title",
        artists: ["Artist B", "Artist A"],
        album: "Album",
        track: { no: 2, of: 9 },
        year: 2025,
        date: "2025-01-02",
        genre: ["Rock", "Pop"],
        rating: [{ rating: 0.008 }],
      },
      native: {
        vorbis: [
          { id: "RATING", value: "0.80" },
          { id: "Mood", value: "calm" },
          { id: "BINARY", value: Uint8Array.from([9]) },
        ],
      },
      pictures: [
        { format: "image/jpeg", type: "Back", data: Uint8Array.from([8]) },
        {
          format: "image/png",
          type: "Cover (front)",
          description: "Primary",
          data: TINY_PICTURE_BYTES,
          width: 1,
          height: 2,
          colour_depth: 24,
          indexed_color: 3,
        } as IPicture,
      ],
      tagTypes: ["vorbis"],
    });

    const snapshot = projectConversionMetadataForChild(metadata, "track.flac");

    expect(snapshot).toMatchObject({
      sourceTagFamilies: ["vorbis"],
      canonical: {
        title: "Title",
        artists: ["Artist B", "Artist A"],
        album: "Album",
        track: { no: 2, of: 9 },
        year: 2025,
        date: "2025-01-02",
        genres: ["Rock", "Pop"],
      },
      rating: { value: 0.8, source: "Vorbis" },
      pictureCount: 2,
      unsupportedNativeFields: ["BINARY"],
    });
    expect(snapshot.textTags).toEqual([
      {
        key: "Mood",
        normalizedKey: "MOOD",
        values: ["calm"],
        sourceFamily: "vorbis",
        kind: "custom",
        descriptor: "Mood",
      },
    ]);
    expect(snapshot.pictures[0]).toMatchObject({
      sourceIndex: 1,
      format: "image/png",
      type: "Cover (front)",
      digest: TINY_PICTURE_DIGEST,
      width: 1,
      height: 2,
      depth: 24,
      colors: 3,
    });
  });

  it("accepts a parsed tagless source without inventing metadata or warnings", () => {
    const snapshot = projectConversionMetadataForChild(makeMetadata(), "track.flac");
    expect(snapshot).toEqual(makeSnapshot());
    expect(getConversionLimitations(snapshot, "aac", "track.flac", "output.m4a")).toEqual([]);
    expect(serializeOpusMetadata(snapshot).toString("utf8")).toBe(";FFMETADATA1\n");
  });

  it.each([
    {
      label: "URL",
      run: () => readConversionMetadata("https://example.test/track.flac"),
    },
    {
      label: "protocol input",
      run: () => readConversionMetadata("data:audio/flac;base64,AAAA"),
    },
    {
      label: "non-regular source",
      run: async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-conversion-directory-"));
        try {
          await readConversionMetadata(tempDir);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
    },
  ])("rejects $label without parsing or fetching", async ({ run }) => {
    await expect(run()).rejects.toMatchObject({ code: "invalid_source" });
    expect(mockChildren.instances).toHaveLength(0);
  });

  it.each(["C:\\Music\\track.flac", "\\\\server\\share\\track.flac"])(
    "treats Windows path syntax as local before filesystem validation",
    async (filePath) => {
      await expect(readConversionMetadata(filePath)).rejects.not.toThrow(
        /requires a local filesystem path/,
      );
      expect(mockChildren.instances).toHaveLength(0);
    },
  );

  it("isolates parsing in a heap-limited child with bounded IPC and deterministic termination", async () => {
    await withLocalFile("flac", async (filePath) => {
      mockChildren.queue(
        "message",
        serialize({
          ok: false,
          error: {
            code: "metadata_parse_failed",
            message: "Metadata could not be parsed safely",
            fields: [],
          },
        }),
      );

      const result = readConversionMetadata(filePath);

      await expect(result).rejects.toMatchObject({ code: "metadata_parse_failed" });
      await expect(result).rejects.not.toThrow(/private|untrusted|parser stack/);
      const child = mockChildren.instances[0];
      expect(child?.command).toBe(process.execPath);
      expect(child?.args).toEqual([
        "--max-old-space-size=128",
        "--max-semi-space-size=32",
        "--stack-size=4096",
        "--import",
        "tsx",
        expect.stringMatching(/conversion-metadata-worker\.ts$/),
        METADATA_FD_PATH,
        filePath,
      ]);
      expect(child?.options).toMatchObject({
        shell: false,
        windowsHide: true,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", expect.any(Number), "ipc"],
      });
      expect(child?.disconnect).toHaveBeenCalledOnce();
      expect(child?.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it("sanitizes child runtime errors and always kills the child", async () => {
    await withLocalFile("flac", async (filePath) => {
      mockChildren.queue("error", new Error("private parser path and stack"));

      await expect(readConversionMetadata(filePath)).rejects.toMatchObject({
        code: "metadata_parse_failed",
        message: "Metadata child process failed while parsing",
      });
      expect(mockChildren.instances[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it("rejects a pathname ABA while retaining the originally opened source descriptor", async () => {
    await withLocalFile("flac", async (filePath, tempDir) => {
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const originalPath = join(tempDir, "original.flac");
      mockFs.openImpl = async () => {
        const originalHandle = await actualFs.open(filePath, "r");
        await actualFs.rename(filePath, originalPath);
        await actualFs.writeFile(filePath, "replacement");
        return originalHandle;
      };

      await expect(readConversionMetadata(filePath)).rejects.toMatchObject({
        code: "invalid_source",
        message: "Conversion metadata source changed while opening",
      });
      expect(mockChildren.instances).toHaveLength(0);
    });
  });

  it("accepts advisory parser warnings from ordinary FFmpeg ID3 padding", () => {
    expect(
      projectConversionMetadataForChild(
        makeMetadata({
          warnings: [{ message: "id3v2.4 header has non-zero padding bytes" }],
          common: { title: "FFmpeg output" },
          tagTypes: ["ID3v2.4"],
        }),
        "track.mp3",
      ),
    ).toMatchObject(
      makeSnapshot({
        sourceTagFamilies: ["ID3v2.4"],
        canonical: { title: "FFmpeg output", artists: [], track: {}, genres: [] },
      }),
    );
  });

  it("contains a hostile child crash and returns only a sanitized parse failure", async () => {
    await withLocalFile("mp3", async (filePath) => {
      mockChildren.queue("exit", null, "SIGABRT");

      await expect(readConversionMetadata(filePath)).rejects.toMatchObject({
        code: "metadata_parse_failed",
        message: "Metadata child process exited before returning a safe snapshot (failed)",
      });
    });
  });

  it("aborts metadata parsing with the exact signal reason and terminates the child", async () => {
    await withLocalFile("flac", async (filePath) => {
      const controller = new AbortController();
      const reason = new Error("cancel metadata parse");
      mockChildren.hold();
      const result = readConversionMetadata(filePath, controller.signal);

      await vi.waitFor(() => expect(mockChildren.instances).toHaveLength(1));
      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
      expect(mockChildren.instances[0]?.disconnect).toHaveBeenCalledOnce();
      expect(mockChildren.instances[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it.each([
    {
      label: "canonical shape",
      snapshot: { ...makeSnapshot(), canonical: null },
    },
    {
      label: "text-tag value type",
      snapshot: {
        ...makeSnapshot(),
        textTags: [
          {
            key: "Mood",
            normalizedKey: "MOOD",
            values: [7],
            sourceFamily: "vorbis",
            kind: "custom",
          },
        ],
      },
    },
    {
      label: "rating range",
      snapshot: { ...makeSnapshot(), rating: { value: 2, source: "POPM" } },
    },
    {
      label: "source family type",
      snapshot: { ...makeSnapshot(), sourceTagFamilies: [null] },
    },
    {
      label: "unsupported field byte bound",
      snapshot: {
        ...makeSnapshot(),
        unsupportedNativeFields: ["X".repeat(256)],
      },
    },
    {
      label: "picture digest",
      snapshot: {
        ...makeSnapshot(),
        pictureCount: 1,
        pictures: [{ ...TINY_PICTURE, digest: "0".repeat(64) }],
      },
    },
    {
      label: "required picture count",
      snapshot: { ...makeSnapshot(), pictureCount: undefined },
    },
    {
      label: "picture source index",
      snapshot: {
        ...makeSnapshot(),
        pictureCount: 1,
        pictures: [{ ...TINY_PICTURE, sourceIndex: 1 }],
      },
    },
  ])("rejects a malformed successful child response: $label", async ({ snapshot }) => {
    await withLocalFile("mp3", async (filePath) => {
      mockChildren.queue("message", serialize({ ok: true, snapshot }));

      await expect(readConversionMetadata(filePath)).rejects.toMatchObject({
        code: "metadata_parse_failed",
        message: "Metadata child process returned an invalid response",
      });
    });
  });

  it("rejects external picture references without fetching them", () => {
    expect(() =>
      projectConversionMetadataForChild(
        makeMetadata({
          pictures: [
            {
              format: "-->",
              description: "https://example.test/cover.jpg",
              data: Uint8Array.from([1]),
            },
          ],
        }),
        "track.flac",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_source",
        fields: ["artwork"],
      }),
    );
  });

  it.each([
    {
      label: "picture count",
      metadata: () =>
        makeMetadata({
          pictures: Array.from({ length: 17 }, () => ({
            format: "image/png",
            data: new Uint8Array(),
          })),
        }),
    },
    {
      label: "primary picture bytes",
      metadata: () =>
        makeMetadata({
          pictures: [
            {
              format: "image/png",
              type: "Cover (front)",
              data: new Uint8Array(16 * 1024 * 1024 + 1),
            },
          ],
        }),
    },
    {
      label: "aggregate picture bytes",
      metadata: () =>
        makeMetadata({
          pictures: [
            { format: "image/png", data: new Uint8Array(16 * 1024 * 1024) },
            { format: "image/png", data: new Uint8Array(16 * 1024 * 1024 + 1) },
          ],
        }),
    },
    {
      label: "text tag count",
      metadata: () =>
        makeMetadata({
          native: {
            vorbis: Array.from({ length: 4_097 }, (_, index) => ({
              id: `KEY${index}`,
              value: "v",
            })),
          },
        }),
    },
    {
      label: "text key bytes",
      metadata: () =>
        makeMetadata({
          native: { vorbis: [{ id: "K".repeat(256), value: "v" }] },
        }),
    },
    {
      label: "individual text value bytes",
      metadata: () =>
        makeMetadata({
          native: { vorbis: [{ id: "KEY", value: "v".repeat(1024 * 1024 + 1) }] },
        }),
    },
    {
      label: "aggregate text bytes",
      metadata: () =>
        makeMetadata({
          native: {
            vorbis: Array.from({ length: 9 }, (_, index) => ({
              id: `KEY${index}`,
              value: "v".repeat(1024 * 1024),
            })),
          },
        }),
    },
    {
      label: "rating provenance bytes",
      metadata: () =>
        makeMetadata({
          common: {
            rating: [{ rating: 0.5, source: "e".repeat(1024 * 1024 + 1) }],
          },
        }),
    },
  ])("enforces the $label bound before child-process transfer", ({ metadata }) => {
    expect(() => projectConversionMetadataForChild(metadata(), "track.flac")).toThrow(
      expect.objectContaining({
        code: "resource_limit",
      }),
    );
  });

  it("rejects NUL text and never coerces structured native values", () => {
    expect(() =>
      projectConversionMetadataForChild(
        makeMetadata({ native: { vorbis: [{ id: "KEY", value: "a\0b" }] } }),
        "track.flac",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "metadata_parse_failed",
      }),
    );

    const snapshot = projectConversionMetadataForChild(
      makeMetadata({ native: { vorbis: [{ id: "STRUCTURED", value: { secret: "value" } }] } }),
      "track.flac",
    );
    expect(snapshot.textTags).toEqual([]);
    expect(snapshot.unsupportedNativeFields).toEqual(["STRUCTURED"]);
  });

  it("keeps TXXX descriptors custom and excludes FFmpeg-generated encoder tags", () => {
    const snapshot = projectConversionMetadataForChild(
      makeMetadata({
        native: {
          "ID3v2.4": [
            { id: "TIT2", value: "Canonical title" },
            { id: "TXXX:TITLE", value: "Distinct custom title" },
            { id: "TSSE", value: "Lavf" },
            { id: "TENC", value: "Lavc" },
          ],
          vorbis: [{ id: "ISFT", value: "Lavf" }],
        },
        tagTypes: ["ID3v2.4", "vorbis"],
      }),
      "track.mp3",
    );

    expect(snapshot.textTags).toEqual([
      {
        key: "TIT2",
        normalizedKey: "TIT2",
        values: ["Canonical title"],
        sourceFamily: "ID3v2.4",
        kind: "canonical",
      },
      {
        key: "TXXX:TITLE",
        normalizedKey: "TXXX:TITLE",
        values: ["Distinct custom title"],
        sourceFamily: "ID3v2.4",
        kind: "custom",
        namespace: "TXXX",
        descriptor: "TITLE",
      },
    ]);
  });

  it("projects real ID3 COMM objects as audited portable comments", () => {
    const source = projectConversionMetadataForChild(
      makeMetadata({
        native: {
          "ID3v2.4": [
            {
              id: "COMM",
              value: { language: "eng", descriptor: "review", text: "Source comment" },
            },
          ],
        },
        tagTypes: ["ID3v2.4"],
      }),
      "track.mp3",
    );
    const destination = projectConversionMetadataForChild(
      makeMetadata({
        native: { vorbis: [{ id: "COMMENT", value: "Source comment" }] },
        tagTypes: ["vorbis"],
      }),
      "track.opus",
    );
    const changedDescriptorDestination = projectConversionMetadataForChild(
      makeMetadata({
        native: {
          "ID3v2.4": [
            {
              id: "COMM",
              value: { language: "eng", descriptor: "changed", text: "Source comment" },
            },
          ],
        },
        tagTypes: ["ID3v2.4"],
      }),
      "output.mp3",
    );

    expect(source.textTags).toEqual([
      {
        key: "COMM",
        normalizedKey: "COMM",
        values: ["Source comment"],
        sourceFamily: "ID3v2.4",
        kind: "custom",
        namespace: "COMM",
        descriptor: "review",
      },
    ]);
    expect(source.unsupportedNativeFields).toEqual(["COMM:descriptor"]);
    expect(getConversionLimitations(source, "opus", "source.mp3", "output.opus")).toEqual([
      expect.objectContaining({
        code: "native_tag_unsupported",
        fields: ["COMM:descriptor"],
        outputUsable: true,
      }),
    ]);
    expect(() => auditConversionMetadataSnapshots(source, destination, "opus")).not.toThrow();
    expect(() =>
      auditConversionMetadataSnapshots(source, changedDescriptorDestination, "mp3"),
    ).not.toThrow();
    expect(() => auditConversionMetadataSnapshots(source, makeSnapshot(), "opus")).toThrow(
      expect.objectContaining({ code: "audit_mismatch", fields: ["COMMENT"] }),
    );
  });

  it("rejects unsafe text inside a structured ID3 comment", () => {
    expect(() =>
      projectConversionMetadataForChild(
        makeMetadata({
          native: {
            "ID3v2.4": [
              { id: "COMM", value: { descriptor: "unsafe\0descriptor", text: "comment" } },
            ],
          },
        }),
        "track.mp3",
      ),
    ).toThrow(expect.objectContaining({ code: "metadata_parse_failed" }));
  });

  it("ignores MP4 implementation keys and classifies iTunes trkn as canonical", () => {
    const snapshot = projectConversionMetadataForChild(
      makeMetadata({
        native: {
          iTunes: [
            { id: "major_brand", value: "M4A " },
            { id: "minor_version", value: "512" },
            { id: "compatible_brands", value: "M4A isomiso2" },
            { id: "trkn", value: "3/12" },
            { id: "©cmt", value: "User comment" },
          ],
        },
        tagTypes: ["iTunes"],
      }),
      "track.m4a",
    );

    expect(snapshot.textTags).toEqual([
      {
        key: "trkn",
        normalizedKey: "TRKN",
        values: ["3/12"],
        sourceFamily: "iTunes",
        kind: "canonical",
      },
      {
        key: "©cmt",
        normalizedKey: "©CMT",
        values: ["User comment"],
        sourceFamily: "iTunes",
        kind: "custom",
        descriptor: "©cmt",
      },
    ]);
  });
});

describe("limitation warnings", () => {
  const snapshot = makeSnapshot({
    textTags: [
      {
        key: "TXXX:MOOD",
        normalizedKey: "TXXX:MOOD",
        values: ["private-value"],
        sourceFamily: "ID3v2.4",
        kind: "custom",
      },
      {
        key: "TXXX:MOOD",
        normalizedKey: "TXXX:MOOD",
        values: ["another-private-value"],
        sourceFamily: "ID3v2.4",
        kind: "custom",
      },
    ],
    rating: { value: 0.8, source: "POPM", email: "private@example.test", counter: 99 },
    pictureCount: 2,
    pictures: [TINY_PICTURE],
    unsupportedNativeFields: ["PRIVATE_FRAME", "PRIVATE_FRAME"],
  });

  it("sorts and deduplicates safe M4A limitations without metadata values", () => {
    const warnings = getConversionLimitations(snapshot, "aac", "source.flac", "dest.m4a");

    expect(warnings.map(({ code }) => code)).toEqual([
      "additional_artwork_unsupported",
      "custom_tag_unsupported",
      "native_tag_unsupported",
      "rating_unsupported",
    ]);
    expect(warnings.map(({ fields }) => fields)).toEqual([
      ["artwork"],
      ["TXXX:MOOD"],
      ["PRIVATE_FRAME"],
      ["rating"],
    ]);
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("private@example.test");
    expect(warnings.every(({ outputUsable }) => outputUsable)).toBe(true);
  });

  it.each(["mp3", "opus"] as const)(
    "does not warn for supported custom text or rating on %s",
    (target) => {
      expect(
        getConversionLimitations(snapshot, target, "source", "dest").map(({ code }) => code),
      ).toEqual(["additional_artwork_unsupported", "native_tag_unsupported"]);
    },
  );

  it("warns instead of serializing an Opus custom key that cannot round-trip", () => {
    const unsafe = makeSnapshot({
      textTags: [
        {
          key: "Unsafe=Key",
          normalizedKey: "UNSAFE=KEY",
          values: ["value"],
          sourceFamily: "vorbis",
          kind: "custom",
          descriptor: "Unsafe=Key",
        },
      ],
    });

    expect(getConversionLimitations(unsafe, "opus", "source", "dest")).toMatchObject([
      {
        code: "custom_tag_unsupported",
        fields: ["Unsafe_Key"],
      },
    ]);
    expect(serializeOpusMetadata(unsafe).toString("utf8")).toBe(";FFMETADATA1\n");
  });

  it("keeps TXXX:MOOD portable but rejects TXXX:TITLE as reserved in Opus", () => {
    const source = makeSnapshot({
      textTags: [
        {
          key: "TXXX:TITLE",
          normalizedKey: "TXXX:TITLE",
          values: ["custom title"],
          sourceFamily: "ID3v2.4",
          kind: "custom",
          namespace: "TXXX",
          descriptor: "TITLE",
        },
        {
          key: "TXXX:MOOD",
          normalizedKey: "TXXX:MOOD",
          values: ["calm"],
          sourceFamily: "ID3v2.4",
          kind: "custom",
          namespace: "TXXX",
          descriptor: "MOOD",
        },
        {
          key: "TXXX:RATING",
          normalizedKey: "TXXX:RATING",
          values: ["custom rating"],
          sourceFamily: "ID3v2.4",
          kind: "custom",
          namespace: "TXXX",
          descriptor: "RATING",
        },
        {
          key: "TXXX:ALBUM",
          normalizedKey: "TXXX:ALBUM",
          values: ["custom album"],
          sourceFamily: "ID3v2.4",
          kind: "custom",
          namespace: "TXXX",
          descriptor: "ALBUM",
        },
      ],
    });
    const destination = makeSnapshot({
      textTags: [
        {
          key: "MOOD",
          normalizedKey: "MOOD",
          values: ["calm"],
          sourceFamily: "vorbis",
          kind: "custom",
          descriptor: "MOOD",
        },
      ],
    });

    expect(getConversionLimitations(source, "opus", "source.mp3", "dest.opus")).toMatchObject([
      {
        code: "custom_tag_unsupported",
        fields: ["TXXX:ALBUM", "TXXX:RATING", "TXXX:TITLE"],
      },
    ]);
    expect(serializeOpusMetadata(source).toString("utf8")).toBe(";FFMETADATA1\nMOOD=calm\n");
    expect(() => auditConversionMetadataSnapshots(source, destination, "opus")).not.toThrow();
  });

  it("renders structured paths without terminal-control injection", () => {
    const warning = getConversionLimitations(
      makeSnapshot({ rating: { value: 0.5, source: "Vorbis" } }),
      "aac",
      "source\n\u001b[31m.flac",
      "dest\r.m4a",
    )[0];

    expect(warning?.source).toBe("source\n\u001b[31m.flac");
    const rendered = renderConversionWarning(warning!);
    expect(rendered).toContain("source\\u000a\\u001b[31m.flac");
    expect(rendered).toContain("dest\\u000d.m4a");
    expect(rendered).not.toMatch(/[\r\n\u001b]/);
  });
});

describe("Opus metadata serialization", () => {
  it("builds the exact tiny big-endian FLAC picture block and base64", () => {
    const block = buildFlacPictureBlock(TINY_PICTURE);

    expect(block.toString("hex")).toBe(
      "0000000300000009696d6167652f706e67000000000000000000000000000000000000000000000003010203",
    );
    expect(block.toString("base64")).toBe(
      "AAAAAwAAAAlpbWFnZS9wbmcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBAgM=",
    );
  });

  it("escapes FFmetadata syntax and controls while rejecting NUL", () => {
    expect(escapeFfmetadataValue("a\\b=c;d#e\r\nf")).toBe("a\\\\b\\=c\\;d\\#e\\\r\\\nf");
    expect(escapeFfmetadataKey("A;B#C\\D")).toBe("A\\;B\\#C\\\\D");
    expect(() => escapeFfmetadataValue("a\0b")).toThrow(ConversionMetadataError);
  });

  it("serializes bounded canonical/custom text, rating, and picture deterministically", () => {
    const snapshot = makeSnapshot({
      canonical: {
        title: "A=B",
        artists: ["Artist"],
        track: { no: 2, of: 9 },
        year: 2025,
        genres: ["Rock"],
      },
      textTags: [
        {
          key: "Mood;Custom",
          normalizedKey: "MOOD;CUSTOM",
          values: ["calm"],
          sourceFamily: "vorbis",
          kind: "custom",
          descriptor: "Mood;Custom",
        },
      ],
      rating: { value: 0.8, source: "Vorbis" },
      pictureCount: 1,
      pictures: [TINY_PICTURE],
    });

    expect(serializeOpusMetadata(snapshot).toString("utf8")).toBe(
      [
        ";FFMETADATA1",
        "TITLE=A\\=B",
        "ARTIST=Artist",
        "TRACKNUMBER=2",
        "TRACKTOTAL=9",
        "DATE=2025",
        "GENRE=Rock",
        "Mood\\;Custom=calm",
        "RATING=0.800000",
        "METADATA_BLOCK_PICTURE=AAAAAwAAAAlpbWFnZS9wbmcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBAgM\\=",
        "",
      ].join("\n"),
    );
  });

  it("enforces the complete 24 MiB sidecar bound", () => {
    const oneMiB = "v".repeat(1024 * 1024);
    const snapshot = makeSnapshot({
      textTags: [
        {
          key: "CUSTOM",
          normalizedKey: "CUSTOM",
          values: [oneMiB, oneMiB, oneMiB],
          sourceFamily: "vorbis",
          kind: "custom",
        },
      ],
      pictureCount: 1,
      pictures: [
        {
          ...TINY_PICTURE,
          description: "d".repeat(1024 * 1024),
          data: new Uint8Array(16 * 1024 * 1024),
        },
      ],
    });

    expect(() => serializeOpusMetadata(snapshot)).toThrow(
      expect.objectContaining({ code: "resource_limit" }),
    );
  });

  it("creates an unlinked private Opus input and disposes its retained handle idempotently", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-opus-sidecar-"));
    try {
      const destination = join(tempDir, "output.opus");
      const snapshot = makeSnapshot({ rating: { value: 0.5, source: "Vorbis" } });

      const sidecar = await createOpusMetadataSidecar(destination, snapshot);
      const buffer = Buffer.alloc(4_096);
      const { bytesRead } = await sidecar.handle.read(buffer, 0, buffer.length, 0);

      expect((await sidecar.handle.stat()).mode & 0o777).toBe(0o600);
      expect(buffer.subarray(0, bytesRead).toString("utf8")).toContain("RATING=0.500000");
      expect(await readdir(tempDir)).toEqual([]);
      await sidecar.dispose();
      await sidecar.dispose();
      await expect(sidecar.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates selected artwork as exact unlinked descriptor bytes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-opus-sidecar-"));
    try {
      const artwork = await createConversionArtworkInput(join(tempDir, "output.mp3"), TINY_PICTURE);
      const bytes = Buffer.alloc(TINY_PICTURE_BYTES.length);
      await artwork.handle.read(bytes, 0, bytes.length, 0);

      expect(bytes).toEqual(Buffer.from(TINY_PICTURE_BYTES));
      expect(await readdir(tempDir)).toEqual([]);
      await artwork.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not unlink an unverified path after a sidecar write failure", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-opus-sidecar-"));
    const writeError = new Error("private write detail");
    const close = vi.fn(async () => undefined);
    mockFs.openImpl = async () => ({
      stat: vi.fn(async () => ({ isFile: () => true, dev: 1, ino: 2 })),
      write: vi.fn(async () => {
        throw writeError;
      }),
      sync: vi.fn(async () => undefined),
      close,
    });

    try {
      const error = await createOpusMetadataSidecar(
        join(tempDir, "output.opus"),
        makeSnapshot(),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "sidecar_write_failed",
        message: "Private Opus metadata input could not be created",
        cause: writeError,
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("semantic destination audit", () => {
  const canonical = {
    title: "Cafe\u0301",
    artists: ["Artist B", "Artist A"],
    album: "Album",
    track: { no: 2, of: 9 },
    year: 2025,
    date: "2025-01-02",
    genres: ["Rock", "Pop"],
  } as const;
  const source = makeSnapshot({
    canonical,
    textTags: [
      {
        key: "MOOD",
        normalizedKey: "MOOD",
        values: ["calm"],
        sourceFamily: "vorbis",
        kind: "custom",
      },
    ],
    rating: { value: 0.8, source: "Vorbis" },
    pictureCount: 1,
    pictures: [TINY_PICTURE],
  });

  function matchingCommon(title = "Caf\u00e9"): Partial<IAudioMetadata["common"]> {
    return {
      title,
      artists: ["Artist A", "Artist B"],
      album: "Album",
      track: { no: 2, of: 9 },
      year: 2025,
      date: "2025-01-02",
      genre: ["Pop", "Rock"],
    };
  }

  it.each([
    {
      label: "Vorbis descriptor to MP3 TXXX descriptor",
      target: "mp3" as const,
      sourceTag: {
        key: "Mood",
        normalizedKey: "MOOD",
        values: ["calm"],
        sourceFamily: "vorbis",
        kind: "custom" as const,
        descriptor: "Mood",
      },
      destinationTag: {
        key: "TXXX:Mood",
        normalizedKey: "TXXX:MOOD",
        values: ["calm"],
        sourceFamily: "ID3v2.4",
        kind: "custom" as const,
        namespace: "TXXX",
        descriptor: "Mood",
      },
    },
    {
      label: "MP3 TXXX descriptor to Opus descriptor",
      target: "opus" as const,
      sourceTag: {
        key: "TXXX:Mood",
        normalizedKey: "TXXX:MOOD",
        values: ["calm"],
        sourceFamily: "ID3v2.4",
        kind: "custom" as const,
        namespace: "TXXX",
        descriptor: "Mood",
      },
      destinationTag: {
        key: "Mood",
        normalizedKey: "MOOD",
        values: ["calm"],
        sourceFamily: "vorbis",
        kind: "custom" as const,
        descriptor: "Mood",
      },
    },
  ])("audits portable custom identity directly across $label", (testCase) => {
    expect(() =>
      auditConversionMetadataSnapshots(
        makeSnapshot({ textTags: [testCase.sourceTag] }),
        makeSnapshot({ textTags: [testCase.destinationTag] }),
        testCase.target,
      ),
    ).not.toThrow();
  });

  it("ignores a destination-only ID3 comment introduced by FFmpeg", () => {
    const testKey = {
      key: "TXXX:TESTKEY",
      normalizedKey: "TXXX:TESTKEY",
      values: ["Custom Value"],
      sourceFamily: "ID3v2.3",
      kind: "custom" as const,
      namespace: "TXXX",
      descriptor: "TESTKEY",
    };
    const generatedComment = {
      key: "TXXX:comment",
      normalizedKey: "TXXX:COMMENT",
      values: ["Generated destination comment"],
      sourceFamily: "ID3v2.3",
      kind: "custom" as const,
      namespace: "TXXX",
      descriptor: "comment",
    };

    expect(() =>
      auditConversionMetadataSnapshots(
        makeSnapshot({ textTags: [testKey] }),
        makeSnapshot({ textTags: [testKey, generatedComment] }),
        "mp3",
      ),
    ).not.toThrow();
  });

  it("still rejects a source-only custom tag missing from the destination", () => {
    expect(() =>
      auditConversionMetadataSnapshots(
        makeSnapshot({
          textTags: [
            {
              key: "TESTKEY",
              normalizedKey: "TESTKEY",
              values: ["Custom Value"],
              sourceFamily: "vorbis",
              kind: "custom",
              descriptor: "TESTKEY",
            },
          ],
        }),
        makeSnapshot(),
        "opus",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "audit_mismatch",
        fields: ["TESTKEY"],
      }),
    );
  });

  it.each([
    {
      label: "FLAC COMMENT to Opus DESCRIPTION",
      target: "opus" as const,
      sourceTag: {
        key: "COMMENT",
        normalizedKey: "COMMENT",
        values: ["Source comment"],
        sourceFamily: "vorbis",
        kind: "custom" as const,
        descriptor: "COMMENT",
      },
      destinationTag: {
        key: "DESCRIPTION",
        normalizedKey: "DESCRIPTION",
        values: ["Source comment"],
        sourceFamily: "vorbis",
        kind: "custom" as const,
        descriptor: "DESCRIPTION",
      },
    },
    {
      label: "MP4 comment to MP3 TXXX comment",
      target: "mp3" as const,
      sourceTag: {
        key: "©cmt",
        normalizedKey: "©CMT",
        values: ["Source comment"],
        sourceFamily: "iTunes",
        kind: "custom" as const,
        descriptor: "©cmt",
      },
      destinationTag: {
        key: "TXXX:comment",
        normalizedKey: "TXXX:COMMENT",
        values: ["Source comment"],
        sourceFamily: "ID3v2.3",
        kind: "custom" as const,
        namespace: "TXXX",
        descriptor: "comment",
      },
    },
    {
      label: "MP4 comment to Opus DESCRIPTION",
      target: "opus" as const,
      sourceTag: {
        key: "©cmt",
        normalizedKey: "©CMT",
        values: ["Source comment"],
        sourceFamily: "iTunes",
        kind: "custom" as const,
        descriptor: "©cmt",
      },
      destinationTag: {
        key: "DESCRIPTION",
        normalizedKey: "DESCRIPTION",
        values: ["Source comment"],
        sourceFamily: "vorbis",
        kind: "custom" as const,
        descriptor: "DESCRIPTION",
      },
    },
  ])("audits the narrow comment alias: $label", ({ target, sourceTag, destinationTag }) => {
    expect(() =>
      auditConversionMetadataSnapshots(
        makeSnapshot({ textTags: [sourceTag] }),
        makeSnapshot({ textTags: [destinationTag] }),
        target,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      target: "mp3" as const,
      customKey: "TXXX:MOOD",
      native: {
        "ID3v2.4": [
          { id: "TXXX:MOOD", value: "calm" },
          { id: "POPM", value: { email: "no@email", rating: 204, counter: 0 } },
        ],
      } as NativeTags,
      tagTypes: ["ID3v2.4"] as const,
    },
    {
      target: "opus" as const,
      customKey: "MOOD",
      native: {
        vorbis: [
          { id: "MOOD", value: "calm" },
          { id: "RATING", value: "0.800001" },
        ],
      } as NativeTags,
      tagTypes: ["vorbis"] as const,
    },
  ])("accepts supported $target semantics and native rating tolerance", async (testCase) => {
    await withLocalFile(testCase.target, async (destinationPath) => {
      const destination = projectConversionMetadataForChild(
        makeMetadata({
          common: matchingCommon(),
          native: testCase.native,
          pictures: [
            {
              format: "image/png",
              type: "Cover (front)",
              data: TINY_PICTURE_BYTES,
            },
          ],
          tagTypes: [...testCase.tagTypes],
        }),
        `audit.${testCase.target}`,
      );
      queueChildSnapshot(destination);
      const caseSource = makeSnapshot({
        ...source,
        textTags: [
          {
            key: testCase.customKey,
            normalizedKey: testCase.customKey,
            values: ["calm"],
            sourceFamily: testCase.target === "mp3" ? "ID3v2.4" : "vorbis",
            kind: "custom",
            ...(testCase.target === "mp3"
              ? { namespace: "TXXX", descriptor: "MOOD" }
              : { descriptor: "MOOD" }),
          },
        ],
      });

      await expect(
        auditLocalFile(caseSource, destinationPath, testCase.target),
      ).resolves.toBeUndefined();
    });
  });

  it.each([
    { label: "canonical text", title: "Changed", picture: TINY_PICTURE_BYTES, field: "title" },
    {
      label: "primary artwork",
      title: "Caf\u00e9",
      picture: Uint8Array.from([9, 9, 9]),
      field: "artwork",
    },
  ])("rejects supported $label loss", async ({ title, picture, field }) => {
    await withLocalFile("opus", async (destinationPath) => {
      queueChildSnapshot(
        projectConversionMetadataForChild(
          makeMetadata({
            common: matchingCommon(title),
            native: {
              vorbis: [
                { id: "MOOD", value: "calm" },
                { id: "RATING", value: "0.8" },
              ],
            },
            pictures: [{ format: "image/png", type: "Cover (front)", data: picture }],
            tagTypes: ["vorbis"],
          }),
          "audit.opus",
        ),
      );

      await expect(auditLocalFile(source, destinationPath, "opus")).rejects.toMatchObject({
        code: "audit_mismatch",
        fields: expect.arrayContaining([field]),
      });
    });
  });

  it("does not make representable output fatal for declared M4A rating/custom limits", async () => {
    await withLocalFile("m4a", async (destinationPath) => {
      queueChildSnapshot(
        projectConversionMetadataForChild(
          makeMetadata({
            common: matchingCommon(),
            pictures: [{ format: "image/png", data: TINY_PICTURE_BYTES }],
            tagTypes: ["iTunes"],
          }),
          "audit.m4a",
        ),
      );

      await expect(auditLocalFile(source, destinationPath, "aac")).resolves.toBeUndefined();
    });
  });

  it.each([
    { label: "value bytes", destinationKey: "Mood", destinationValue: "Caf\u00e9" },
    { label: "key case", destinationKey: "MOOD", destinationValue: "Cafe\u0301" },
  ])("compares custom $label exactly without normalization", async (testCase) => {
    await withLocalFile("opus", async (destinationPath) => {
      const exactSource = makeSnapshot({
        textTags: [
          {
            key: "Mood",
            normalizedKey: "MOOD",
            values: ["Cafe\u0301"],
            sourceFamily: "vorbis",
            kind: "custom",
            descriptor: "Mood",
          },
        ],
      });
      queueChildSnapshot(
        makeSnapshot({
          textTags: [
            {
              key: testCase.destinationKey,
              normalizedKey: "MOOD",
              values: [testCase.destinationValue],
              sourceFamily: "vorbis",
              kind: "custom",
              descriptor: testCase.destinationKey,
            },
          ],
        }),
      );

      await expect(auditLocalFile(exactSource, destinationPath, "opus")).rejects.toMatchObject({
        code: "audit_mismatch",
      });
    });
  });
});
