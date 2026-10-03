/**
 * Bounded metadata projection and target policy for audio conversion.
 *
 * This module intentionally owns no FFmpeg process or destination publication.
 * It reads local metadata, describes target capabilities, creates the private
 * Opus metadata input, and audits a staged conversion before it may be committed.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { deserialize } from "node:v8";

import type { IAudioMetadata, IPicture } from "music-metadata";

import type { NormalizedRating } from "../types/index.js";
import type { ConvertFormat } from "../types/options.js";
import { extractNormalizedRating } from "./ratings.js";
import { resolveLocalWorkerEntrypoint } from "./worker-entrypoint.js";

type NativeTags = IAudioMetadata["native"];

const MAX_PICTURES = 16;
const MAX_PRIMARY_PICTURE_BYTES = 16 * 1024 * 1024;
const MAX_AGGREGATE_PICTURE_BYTES = 32 * 1024 * 1024;
const MAX_OPUS_SIDECAR_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_TAGS = 4_096;
const MAX_TEXT_KEY_BYTES = 255;
const MAX_TEXT_VALUE_BYTES = 1024 * 1024;
const MAX_AGGREGATE_TEXT_BYTES = 8 * 1024 * 1024;
const OPUS_RATING_DECIMALS = 6;
const METADATA_CHILD_TIMEOUT_MS = 30_000;
const METADATA_CHILD_KILL_GRACE_MS = 1_000;
export const MAX_METADATA_CHILD_IPC_BYTES = 32 * 1024 * 1024;
const METADATA_CHILD_EXEC_ARGS = [
  "--max-old-space-size=128",
  "--max-semi-space-size=32",
  "--stack-size=4096",
] as const;

/**
 * Mode the ffmpeg metadata input descriptor is CREATED with. The file is
 * `unlink`ed immediately after its content is synced, so this mode's only
 * job is to narrow the open-to-unlink window; the payload is thereafter
 * reachable only through the retained descriptor and is never published
 * under a pathname. Deliberately NOT secure-store's PRIVATE_FILE_MODE,
 * which names a permanent property of an on-disk credential document —
 * this descriptor has no on-disk lifetime to protect.
 */
const UNLINKED_DESCRIPTOR_MODE = 0o600;

const VORBIS_CANONICAL_KEYS = new Set([
  "ALBUM",
  "ARTIST",
  "DATE",
  "GENRE",
  "TITLE",
  "TOTALTRACKS",
  "TRACKNUMBER",
  "TRACKTOTAL",
]);

const ID3_CANONICAL_KEYS = new Set(["TALB", "TCON", "TDRC", "TIT2", "TPE1", "TRCK", "TYER"]);

const ITUNES_CANONICAL_KEYS = new Set(["TRKN", "©ALB", "©ART", "©DAY", "©GEN", "©NAM"]);

const HANDLED_OR_GENERATED_KEYS = new Set([
  "APIC",
  "COVERART",
  "COVERARTMIME",
  "COVR",
  "ENCODED-BY",
  "ENCODED_BY",
  "ENCODEDBY",
  "ENCODER",
  "ISFT",
  "COMPATIBLE_BRANDS",
  "MAJOR_BRAND",
  "METADATA_BLOCK_PICTURE",
  "MINOR_VERSION",
  "POPM",
  "RATING",
  "TENC",
  "TOOL",
  "TSSE",
  "VENDOR",
  "©TOO",
]);

const OPUS_RESERVED_CUSTOM_KEYS = new Set([
  ...VORBIS_CANONICAL_KEYS,
  ...HANDLED_OR_GENERATED_KEYS,
  "METADATA_BLOCK_PICTURE",
]);

const TARGET_POLICIES = {
  mp3: {
    format: "mp3",
    container: "mp3",
    muxer: "mp3",
    audioArgs: ["-c:a", "libmp3lame", "-b:a", "320k"],
    artworkMode: "attached-picture-copy",
    ratingMode: "popm-postwrite",
    customTextMode: "mapped-and-audited",
  },
  aac: {
    format: "aac",
    container: "m4a",
    muxer: "ipod",
    audioArgs: ["-c:a", "aac", "-b:a", "256k"],
    artworkMode: "attached-picture-copy",
    ratingMode: "unsupported",
    customTextMode: "unsupported",
  },
  alac: {
    format: "alac",
    container: "m4a",
    muxer: "ipod",
    audioArgs: ["-c:a", "alac"],
    artworkMode: "attached-picture-copy",
    ratingMode: "unsupported",
    customTextMode: "unsupported",
  },
  opus: {
    format: "opus",
    container: "opus",
    muxer: "opus",
    audioArgs: ["-c:a", "libopus", "-b:a", "128k"],
    artworkMode: "vorbis-picture-comment",
    ratingMode: "vorbis-comment",
    customTextMode: "mapped-and-audited",
  },
} as const satisfies Record<ConvertFormat, ConversionTargetPolicy>;

export interface ConversionCanonicalMetadata {
  readonly title?: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly track: {
    readonly no?: number;
    readonly of?: number;
  };
  readonly year?: number;
  readonly date?: string;
  readonly genres: readonly string[];
}

export interface ConversionTextTag {
  /** Exact native identifier, retaining case and namespace syntax. */
  readonly key: string;
  /** Uppercase key used only for safe classification and warning ordering. */
  readonly normalizedKey: string;
  readonly values: readonly string[];
  readonly sourceFamily: string;
  readonly kind: "canonical" | "custom";
  readonly namespace?: string;
  readonly descriptor?: string;
}

export interface ConversionPicture {
  /** Original index in music-metadata's common.picture collection. */
  readonly sourceIndex: number;
  readonly format: string;
  readonly type?: string;
  readonly description?: string;
  readonly data: Uint8Array;
  readonly digest: string;
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
  readonly colors?: number;
}

export interface ConversionMetadataSnapshot {
  readonly sourceTagFamilies: readonly string[];
  readonly canonical: ConversionCanonicalMetadata;
  readonly textTags: readonly ConversionTextTag[];
  readonly rating: NormalizedRating | null;
  /** Original picture count; only the bounded primary picture payload is retained. */
  readonly pictureCount: number;
  readonly pictures: readonly ConversionPicture[];
  /** Safe field categories for native structured/binary values that were not flattened. */
  readonly unsupportedNativeFields: readonly string[];
}

export interface ConversionTargetPolicy {
  readonly format: ConvertFormat;
  readonly container: "mp3" | "m4a" | "opus";
  readonly muxer: "mp3" | "ipod" | "opus";
  readonly audioArgs: readonly string[];
  readonly artworkMode: "attached-picture-copy" | "vorbis-picture-comment";
  readonly ratingMode: "popm-postwrite" | "vorbis-comment" | "unsupported";
  readonly customTextMode: "mapped-and-audited" | "unsupported";
}

export type ConversionWarningCode =
  | "additional_artwork_unsupported"
  | "custom_tag_unsupported"
  | "native_tag_unsupported"
  | "rating_unsupported";

export interface ConversionWarning {
  readonly code: ConversionWarningCode;
  readonly reason: string;
  readonly target: ConvertFormat;
  readonly fields: readonly string[];
  readonly source: string;
  readonly destination: string;
  readonly outputUsable: true;
}

export interface OpusMetadataSidecar {
  readonly handle: FileHandle;
  dispose(): Promise<void>;
}

export interface ConversionArtworkInput {
  readonly handle: FileHandle;
  dispose(): Promise<void>;
}

interface Id3Comment {
  readonly descriptor?: string;
  readonly language?: string;
  readonly text?: string;
}

export type ConversionMetadataErrorCode =
  | "audit_mismatch"
  | "invalid_source"
  | "metadata_parse_failed"
  | "resource_limit"
  | "sidecar_cleanup_failed"
  | "sidecar_write_failed";

export class ConversionMetadataError extends Error {
  override readonly name = "ConversionMetadataError";

  constructor(
    readonly code: ConversionMetadataErrorCode,
    message: string,
    readonly fields: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ConversionMetadataChildRequest {
  readonly filePath: string;
  readonly ratingPath: string;
}

export type ConversionMetadataChildResponse =
  | { readonly ok: true; readonly snapshot: ConversionMetadataSnapshot }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ConversionMetadataErrorCode;
        readonly message: string;
        readonly fields: readonly string[];
      };
    };

export function safeConversionMetadataChildMessage(code: ConversionMetadataErrorCode): string {
  switch (code) {
    case "audit_mismatch":
      return "Converted metadata failed semantic audit";
    case "invalid_source":
      return "Metadata source is not a trusted local regular file";
    case "metadata_parse_failed":
      return "Metadata could not be parsed safely";
    case "resource_limit":
      return "Metadata exceeds a configured resource limit";
    case "sidecar_cleanup_failed":
      return "Private metadata cleanup failed";
    case "sidecar_write_failed":
      return "Private metadata creation failed";
    default: {
      const exhaustive: never = code;
      return `Metadata child failed: ${String(exhaustive)}`;
    }
  }
}

/**
 * Read one cover-aware metadata snapshot from a local regular file.
 */
export async function readConversionMetadata(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<ConversionMetadataSnapshot> {
  signal?.throwIfAborted();
  assertLocalPath(sourcePath);
  await assertRegularFile(sourcePath);
  signal?.throwIfAborted();
  const sourceHandle = await open(sourcePath, "r");
  try {
    await assertRegularFileHandle(sourceHandle);
    const [handleStats, pathStats] = await Promise.all([sourceHandle.stat(), lstat(sourcePath)]);
    if (
      pathStats.isSymbolicLink() ||
      handleStats.dev !== pathStats.dev ||
      handleStats.ino !== pathStats.ino
    ) {
      throw new ConversionMetadataError(
        "invalid_source",
        "Conversion metadata source changed while opening",
      );
    }
    return await readConversionMetadataFromHandle(sourceHandle, sourcePath, signal);
  } finally {
    await sourceHandle.close();
  }
}

/**
 * Parse metadata from an already-authoritative descriptor.
 */
export async function readConversionMetadataFromHandle(
  sourceHandle: FileHandle,
  ratingPath: string,
  signal?: AbortSignal,
): Promise<ConversionMetadataSnapshot> {
  signal?.throwIfAborted();
  await assertRegularFileHandle(sourceHandle);
  signal?.throwIfAborted();
  return parseConversionMetadataInChild(
    metadataDescriptorPath(3),
    ratingPath,
    signal,
    sourceHandle,
  );
}

async function parseConversionMetadataInChild(
  filePath: string,
  ratingPath: string,
  signal?: AbortSignal,
  fileHandle?: FileHandle,
): Promise<ConversionMetadataSnapshot> {
  signal?.throwIfAborted();
  let child: ChildProcess;
  try {
    const childEntrypoint = resolveLocalWorkerEntrypoint(
      import.meta.url,
      "conversion-metadata-worker",
    );
    child = spawn(
      process.execPath,
      [
        ...METADATA_CHILD_EXEC_ARGS,
        ...childEntrypoint.runtimeArgs,
        childEntrypoint.path,
        filePath,
        ratingPath,
      ],
      {
        shell: false,
        windowsHide: true,
        serialization: "advanced",
        stdio:
          fileHandle === undefined
            ? ["ignore", "ignore", "ignore", "ipc"]
            : ["ignore", "ignore", "ignore", fileHandle.fd, "ipc"],
      },
    );
  } catch {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Metadata child process could not be started safely",
    );
  }

  return new Promise<ConversionMetadataSnapshot>((resolveSnapshot, rejectSnapshot) => {
    let settled = false;
    let pending:
      | { readonly ok: true; readonly snapshot: ConversionMetadataSnapshot }
      | { readonly ok: false; readonly error: unknown }
      | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (abortHandler !== undefined) signal?.removeEventListener("abort", abortHandler);
      child.removeAllListeners();
    };
    const settlePending = (): void => {
      if (settled || pending === undefined) return;
      settled = true;
      cleanup();
      if (pending.ok) {
        resolveSnapshot(pending.snapshot);
      } else {
        rejectSnapshot(pending.error);
      }
    };
    const terminateWith = (
      outcome: NonNullable<typeof pending>,
      signal: NodeJS.Signals = "SIGTERM",
    ): void => {
      if (settled || pending !== undefined) return;
      pending = outcome;
      if (child.connected) child.disconnect();
      child.kill(signal);
      if (child.exitCode !== null || child.signalCode !== null) {
        settlePending();
        return;
      }
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settlePending();
      }, METADATA_CHILD_KILL_GRACE_MS);
      killTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      terminateWith(
        {
          ok: false,
          error: new ConversionMetadataError(
            "metadata_parse_failed",
            "Metadata parsing exceeded the isolated child-process time limit",
          ),
        },
        "SIGKILL",
      );
    }, METADATA_CHILD_TIMEOUT_MS);
    timeoutTimer.unref();
    abortHandler = (): void => {
      terminateWith({ ok: false, error: signal?.reason });
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();

    child.once("message", (payload: unknown) => {
      const message = parseChildResponse(payload);
      if (message === null) {
        terminateWith({
          ok: false,
          error: new ConversionMetadataError(
            "metadata_parse_failed",
            "Metadata child process returned an invalid response",
          ),
        });
        return;
      }
      if (message.ok) {
        terminateWith({ ok: true, snapshot: message.snapshot });
      } else {
        terminateWith({
          ok: false,
          error: new ConversionMetadataError(
            message.error.code,
            safeConversionMetadataChildMessage(message.error.code),
            message.error.fields,
          ),
        });
      }
    });
    child.once("error", () => {
      terminateWith({
        ok: false,
        error: new ConversionMetadataError(
          "metadata_parse_failed",
          "Metadata child process failed while parsing",
        ),
      });
    });
    child.once("exit", (code, signal) => {
      if (pending !== undefined) {
        settlePending();
        return;
      }
      terminateWith({
        ok: false,
        error: new ConversionMetadataError(
          "metadata_parse_failed",
          `Metadata child process exited before returning a safe snapshot (${
            code === 0 && signal === null ? "empty" : "failed"
          })`,
        ),
      });
      settlePending();
    });
  });
}

function parseChildResponse(payload: unknown): ConversionMetadataChildResponse | null {
  if (!(payload instanceof Uint8Array) || payload.byteLength > MAX_METADATA_CHILD_IPC_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = deserialize(payload);
  } catch {
    return null;
  }
  return isChildResponse(value) ? value : null;
}

/**
 * Return the immutable policy for a conversion target.
 */
export function getConversionTargetPolicy(format: ConvertFormat): ConversionTargetPolicy {
  return TARGET_POLICIES[format];
}

/**
 * Return known, value-free target limitations in deterministic order.
 */
export function getConversionLimitations(
  snapshot: ConversionMetadataSnapshot,
  target: ConvertFormat,
  source: string,
  destination: string,
): readonly ConversionWarning[] {
  const warnings: ConversionWarning[] = [];

  if (snapshot.pictureCount > 1) {
    warnings.push(
      makeWarning(
        "additional_artwork_unsupported",
        "only one primary picture is preserved",
        target,
        ["artwork"],
        source,
        destination,
      ),
    );
  }

  const policy = getConversionTargetPolicy(target);
  const customFields = snapshot.textTags
    .filter(({ kind }) => kind === "custom")
    .filter((tag) => !isCustomTagCompatible(tag, target))
    .map(({ key }) => key);

  if (customFields.length > 0) {
    warnings.push(
      makeWarning(
        "custom_tag_unsupported",
        policy.customTextMode === "unsupported"
          ? "custom text is not represented by the standard M4A mapping"
          : "custom text key cannot safely round-trip through the target metadata grammar",
        target,
        customFields,
        source,
        destination,
      ),
    );
  }

  if (snapshot.unsupportedNativeFields.length > 0) {
    warnings.push(
      makeWarning(
        "native_tag_unsupported",
        "structured or binary native metadata is not portable to the target",
        target,
        snapshot.unsupportedNativeFields,
        source,
        destination,
      ),
    );
  }

  if (policy.ratingMode === "unsupported" && snapshot.rating !== null) {
    warnings.push(
      makeWarning(
        "rating_unsupported",
        "rating is not represented by the standard M4A mapping",
        target,
        ["rating"],
        source,
        destination,
      ),
    );
  }

  return sortAndDedupeWarnings(warnings);
}

/**
 * Render a warning for human stderr without allowing paths or fields to inject
 * terminal controls. Structured warning values remain unchanged for callers.
 */
export function renderConversionWarning(warning: ConversionWarning): string {
  const fields = warning.fields.map(sanitizeHumanText).join(",");
  return (
    `[WARN] Metadata preservation [${warning.code}] ` +
    `${sanitizeHumanText(warning.source)} -> ${sanitizeHumanText(warning.destination)} ` +
    `(${warning.target}): ${sanitizeHumanText(warning.reason)}; ` +
    `fields=${fields}; converted output is usable`
  );
}

/**
 * Escape one FFmetadata value without changing its Unicode content.
 */
export function escapeFfmetadataValue(value: string): string {
  if (value.includes("\0")) {
    throw new ConversionMetadataError("resource_limit", "FFmetadata values must not contain NUL");
  }
  return value.replace(/[\\\r\n=;#]/g, "\\$&");
}

export function escapeFfmetadataKey(key: string): string {
  return escapeFfmetadataValue(key);
}

/**
 * Build the exact FLAC picture block used by Vorbis/Opus metadata.
 */
export function buildFlacPictureBlock(picture: ConversionPicture): Buffer {
  const mime = validatedPictureMime(picture.format);
  const description = validatedPictureText(picture.description ?? "", "picture description");
  const mimeBytes = Buffer.from(mime, "utf8");
  const descriptionBytes = Buffer.from(description, "utf8");
  const data = Buffer.from(picture.data);
  const headerLength = 4 * 8 + mimeBytes.length + descriptionBytes.length;
  const block = Buffer.allocUnsafe(headerLength + data.length);
  let offset = 0;

  offset = writeUint32(block, offset, 3);
  offset = writeUint32(block, offset, mimeBytes.length);
  offset += mimeBytes.copy(block, offset);
  offset = writeUint32(block, offset, descriptionBytes.length);
  offset += descriptionBytes.copy(block, offset);
  offset = writeUint32(block, offset, picture.width ?? 0);
  offset = writeUint32(block, offset, picture.height ?? 0);
  offset = writeUint32(block, offset, picture.depth ?? 0);
  offset = writeUint32(block, offset, picture.colors ?? 0);
  offset = writeUint32(block, offset, data.length);
  data.copy(block, offset);
  return block;
}

/**
 * Serialize the complete bounded FFmetadata input used for Opus conversion.
 */
export function serializeOpusMetadata(snapshot: ConversionMetadataSnapshot): Buffer {
  const entries = opusMetadataEntries(snapshot);
  const document = [
    ";FFMETADATA1",
    ...entries.map(([key, value]) => `${escapeFfmetadataKey(key)}=${escapeFfmetadataValue(value)}`),
    "",
  ].join("\n");
  const content = Buffer.from(document, "utf8");

  if (content.length > MAX_OPUS_SIDECAR_BYTES) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Opus metadata sidecar exceeds the configured byte limit",
      ["metadata"],
    );
  }
  return content;
}

/** Create an unlinked descriptor-backed FFmetadata input for Opus. */
export async function createOpusMetadataSidecar(
  destinationPath: string,
  snapshot: ConversionMetadataSnapshot,
): Promise<OpusMetadataSidecar> {
  return createUnlinkedDescriptorInput(
    destinationPath,
    `.rfmedia-opus-metadata-${randomUUID()}.ffmeta`,
    serializeOpusMetadata(snapshot),
    "Opus metadata",
  );
}

/** Create an unlinked descriptor-backed image input from the selected payload. */
export async function createConversionArtworkInput(
  destinationPath: string,
  picture: ConversionPicture,
): Promise<ConversionArtworkInput> {
  return createUnlinkedDescriptorInput(
    destinationPath,
    `.rfmedia-artwork-${randomUUID()}.input`,
    Buffer.from(picture.data),
    "artwork",
  );
}

async function createUnlinkedDescriptorInput(
  destinationPath: string,
  basename: string,
  content: Uint8Array,
  label: string,
): Promise<OpusMetadataSidecar> {
  assertLocalPath(destinationPath);
  let parent: string;
  try {
    parent = await realpath(resolve(dirname(destinationPath)));
    const parentStats = await stat(parent);
    if (!parentStats.isDirectory()) throw new Error("not a directory");
    if ((parentStats.mode & 0o022) !== 0) {
      throw new Error("group- or world-writable parent");
    }
  } catch (error) {
    throw new ConversionMetadataError(
      "sidecar_write_failed",
      `Private ${label} input parent is not trustworthy`,
      [],
      { cause: error },
    );
  }

  const inputPath = join(parent, basename);
  let handle: FileHandle | undefined;
  let unlinked = false;
  try {
    handle = await open(inputPath, "wx+", UNLINKED_DESCRIPTOR_MODE);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error("not a regular file");
    await writeDescriptorContent(handle, content);
    await handle.sync();
    await unlink(inputPath);
    unlinked = true;
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The primary creation/write failure remains authoritative.
    }
    if (!unlinked) {
      try {
        await unlink(inputPath);
      } catch (cleanupError) {
        if (!isErrno(cleanupError, "ENOENT")) {
          throw new ConversionMetadataError(
            "sidecar_cleanup_failed",
            `Private ${label} input could not be removed after a write failure`,
            [],
            { cause: error },
          );
        }
      }
    }
    throw new ConversionMetadataError(
      "sidecar_write_failed",
      `Private ${label} input could not be created`,
      [],
      { cause: error },
    );
  }

  let disposed = false;
  return {
    handle,
    async dispose(): Promise<void> {
      if (disposed) return;
      try {
        await handle.close();
        disposed = true;
      } catch (error) {
        throw new ConversionMetadataError(
          "sidecar_cleanup_failed",
          `Private ${label} descriptor could not be closed`,
          [],
          { cause: error },
        );
      }
    },
  };
}

async function writeDescriptorContent(handle: FileHandle, content: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.byteLength - offset,
      offset,
    );
    if (bytesWritten <= 0) throw new Error("descriptor write made no progress");
    offset += bytesWritten;
  }
}

/**
 * Reparse and semantically audit one staged conversion.
 *
 * Known target limitations are excluded by policy; every supported source
 * value must survive, otherwise the audit rejects publication.
 */
export async function auditConvertedMetadata(
  source: ConversionMetadataSnapshot,
  destinationHandle: FileHandle,
  target: ConvertFormat,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertRegularFileHandle(destinationHandle);
  signal?.throwIfAborted();
  const destination = await parseConversionMetadataInChild(
    metadataDescriptorPath(3),
    ratingPathForTarget(target),
    signal,
    destinationHandle,
  );
  auditConversionMetadataSnapshots(source, destination, target);
}

/**
 * Audit two already-bounded snapshots without reparsing either file.
 */
export function auditConversionMetadataSnapshots(
  source: ConversionMetadataSnapshot,
  destination: ConversionMetadataSnapshot,
  target: ConvertFormat,
): void {
  const mismatches = auditMismatches(source, destination, getConversionTargetPolicy(target));
  if (mismatches.length > 0) {
    throw new ConversionMetadataError(
      "audit_mismatch",
      "Converted metadata lost or changed supported fields",
      mismatches,
    );
  }
}

/**
 * Project parsed metadata inside the isolated child before it may cross into
 * the main process.
 *
 * @internal
 */
export function projectConversionMetadataForChild(
  metadata: IAudioMetadata,
  ratingPath: string,
): ConversionMetadataSnapshot {
  // music-metadata quality warnings are advisory (for example ordinary ID3
  // padding notices). Fatal parser failures arrive as thrown exceptions.
  const canonical = projectCanonical(metadata);
  const { textTags, unsupportedNativeFields } = projectTextTags(metadata.native);
  const { pictures, pictureCount } = projectPictures(metadata.common.picture ?? []);
  const rating = validatedRating(extractNormalizedRating(metadata, ratingPath));
  const sourceTagFamilies = [...new Set(metadata.format.tagTypes)]
    .map((family) => validatedKey(family))
    .sort();
  if (sourceTagFamilies.length > MAX_TEXT_TAGS) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Source tag-family count exceeds the configured limit",
      ["text"],
    );
  }
  assertSnapshotTextBounds(canonical, textTags, rating, sourceTagFamilies, unsupportedNativeFields);

  return {
    sourceTagFamilies,
    canonical,
    textTags,
    rating,
    pictureCount,
    pictures,
    unsupportedNativeFields,
  };
}

function projectCanonical(metadata: IAudioMetadata): ConversionCanonicalMetadata {
  const common = metadata.common;
  const artists =
    common.artists !== undefined && common.artists.length > 0
      ? common.artists.map((value) => validatedText(value, "artist"))
      : common.artist === undefined
        ? []
        : [validatedText(common.artist, "artist")];
  const genres = (common.genre ?? []).map((value) => validatedText(value, "genre"));

  return {
    ...(common.title === undefined ? {} : { title: validatedText(common.title, "title") }),
    artists,
    ...(common.album === undefined ? {} : { album: validatedText(common.album, "album") }),
    track: {
      ...(common.track.no === null ? {} : { no: validatedCount(common.track.no, "track") }),
      ...(common.track.of === null ? {} : { of: validatedCount(common.track.of, "track total") }),
    },
    ...(common.year === undefined ? {} : { year: validatedCount(common.year, "year") }),
    ...(common.date === undefined ? {} : { date: validatedText(common.date, "date") }),
    genres,
  };
}

function projectTextTags(native: NativeTags): {
  readonly textTags: readonly ConversionTextTag[];
  readonly unsupportedNativeFields: readonly string[];
} {
  const entries = Object.entries(native);
  const tagCount = entries.reduce((count, [, tags]) => count + tags.length, 0);
  if (tagCount > MAX_TEXT_TAGS) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Source text-tag count exceeds the configured limit",
      ["text"],
    );
  }

  let aggregateBytes = 0;
  let textValueCount = 0;
  const grouped = new Map<string, { tag: ConversionTextTag; values: string[] }>();
  const unsupported = new Set<string>();

  for (const [rawSourceFamily, tags] of entries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sourceFamily = validatedKey(rawSourceFamily);
    for (const nativeTag of tags) {
      const key = validatedKey(nativeTag.id);
      const normalizedKey = normalizeTextKey(key);
      if (HANDLED_OR_GENERATED_KEYS.has(normalizedKey)) continue;

      const projected = projectNativeTextValue(sourceFamily, key, nativeTag.value);
      if (projected === null) {
        unsupported.add(safeFieldName(key));
        continue;
      }
      if (projected.unsupportedField !== undefined) {
        unsupported.add(safeFieldName(projected.unsupportedField));
      }

      const keyBytes = Buffer.byteLength(key, "utf8");
      aggregateBytes += keyBytes;
      const validatedValues = projected.values.map((value) => {
        textValueCount += 1;
        if (textValueCount > MAX_TEXT_TAGS) {
          throw new ConversionMetadataError(
            "resource_limit",
            "Source text-value count exceeds the configured limit",
            ["text"],
          );
        }
        const safeValue = validatedText(value, "text value");
        const valueBytes = Buffer.byteLength(safeValue, "utf8");
        if (valueBytes > MAX_TEXT_VALUE_BYTES) {
          throw new ConversionMetadataError(
            "resource_limit",
            "Source text value exceeds the configured byte limit",
            [safeFieldName(key)],
          );
        }
        aggregateBytes += valueBytes;
        return safeValue;
      });

      if (aggregateBytes > MAX_AGGREGATE_TEXT_BYTES) {
        throw new ConversionMetadataError(
          "resource_limit",
          "Aggregate source text exceeds the configured byte limit",
          ["text"],
        );
      }

      const kind = isCanonicalNativeTag(sourceFamily, key) ? "canonical" : "custom";
      const customIdentity =
        kind === "custom" ? (projected.customIdentity ?? parseCustomIdentity(key)) : {};
      const groupKey = [
        sourceFamily,
        key,
        kind,
        customIdentity.namespace ?? "",
        customIdentity.descriptor ?? "",
      ].join("\0");
      const existing = grouped.get(groupKey);
      if (existing) {
        existing.values.push(...validatedValues);
      } else {
        grouped.set(groupKey, {
          tag: {
            key,
            normalizedKey,
            values: [],
            sourceFamily,
            kind,
            ...customIdentity,
          },
          values: [...validatedValues],
        });
      }
    }
  }

  return {
    textTags: [...grouped.values()].map(({ tag, values }) => ({ ...tag, values })),
    unsupportedNativeFields: [...unsupported].sort(),
  };
}

function projectPictures(sourcePictures: readonly IPicture[]): {
  readonly pictures: readonly ConversionPicture[];
  readonly pictureCount: number;
} {
  if (sourcePictures.length > MAX_PICTURES) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Source picture count exceeds the configured limit",
      ["artwork"],
    );
  }

  let aggregateBytes = 0;
  const ordered = sourcePictures
    .map((picture, index) => ({ picture, index }))
    .sort((left, right) => picturePriority(left.picture) - picturePriority(right.picture));

  for (const { picture } of ordered) {
    if (!(picture.data instanceof Uint8Array)) {
      throw new ConversionMetadataError(
        "metadata_parse_failed",
        "Source picture data is not trustworthy",
        ["artwork"],
      );
    }
    aggregateBytes += picture.data.byteLength;
  }

  if (aggregateBytes > MAX_AGGREGATE_PICTURE_BYTES) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Aggregate source artwork exceeds the configured byte limit",
      ["artwork"],
    );
  }

  const primary = ordered[0];
  if (primary !== undefined && primary.picture.data.byteLength > MAX_PRIMARY_PICTURE_BYTES) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Primary source artwork exceeds the configured byte limit",
      ["artwork"],
    );
  }

  return {
    pictures: primary === undefined ? [] : [projectPicture(primary.picture, primary.index)],
    pictureCount: sourcePictures.length,
  };
}

function projectPicture(picture: IPicture, sourceIndex: number): ConversionPicture {
  const format = validatedPictureMime(picture.format);
  if (format === "-->") {
    throw new ConversionMetadataError(
      "invalid_source",
      "External picture references are not supported",
      ["artwork"],
    );
  }

  return {
    sourceIndex,
    format,
    ...(picture.type === undefined ? {} : { type: validatedText(picture.type, "picture type") }),
    ...(picture.description === undefined
      ? {}
      : { description: validatedPictureText(picture.description, "picture description") }),
    data: picture.data,
    digest: createHash("sha256").update(picture.data).digest("hex"),
    ...optionalPictureDimensions(picture),
  };
}

function optionalPictureDimensions(picture: IPicture): {
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
  readonly colors?: number;
} {
  return {
    ...optionalUint32Property(picture, "width", "width"),
    ...optionalUint32Property(picture, "height", "height"),
    ...optionalUint32Property(picture, "colour_depth", "depth"),
    ...optionalUint32Property(picture, "indexed_color", "colors"),
  };
}

function optionalUint32Property(
  value: object,
  sourceKey: "width" | "height" | "colour_depth" | "indexed_color",
  targetKey: "width" | "height" | "depth" | "colors",
): Partial<Record<"width" | "height" | "depth" | "colors", number>> {
  if (!(sourceKey in value)) return {};
  const candidate = Reflect.get(value, sourceKey);
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < 0 ||
    candidate > 0xffff_ffff
  ) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Source picture dimensions are not trustworthy",
      ["artwork"],
    );
  }
  return { [targetKey]: candidate };
}

function opusMetadataEntries(snapshot: ConversionMetadataSnapshot): readonly [string, string][] {
  const entries: [string, string][] = [];
  const canonical = snapshot.canonical;

  pushOptionalEntry(entries, "TITLE", canonical.title);
  for (const artist of canonical.artists) entries.push(["ARTIST", artist]);
  pushOptionalEntry(entries, "ALBUM", canonical.album);
  if (canonical.track.no !== undefined) entries.push(["TRACKNUMBER", String(canonical.track.no)]);
  if (canonical.track.of !== undefined) entries.push(["TRACKTOTAL", String(canonical.track.of)]);
  if (canonical.date !== undefined) {
    entries.push(["DATE", canonical.date]);
  } else if (canonical.year !== undefined) {
    entries.push(["DATE", String(canonical.year)]);
  }
  for (const genre of canonical.genres) entries.push(["GENRE", genre]);

  for (const tag of snapshot.textTags) {
    if (tag.kind !== "custom" || !isCustomTagCompatible(tag, "opus")) continue;
    const key = validatedVorbisKey(opusCustomKey(tag));
    for (const value of tag.values) entries.push([key, value]);
  }

  if (snapshot.rating !== null) {
    entries.push(["RATING", formatOpusRating(snapshot.rating.value)]);
  }
  const primaryPicture = snapshot.pictures[0];
  if (primaryPicture !== undefined) {
    entries.push([
      "METADATA_BLOCK_PICTURE",
      buildFlacPictureBlock(primaryPicture).toString("base64"),
    ]);
  }

  return entries;
}

function auditMismatches(
  source: ConversionMetadataSnapshot,
  destination: ConversionMetadataSnapshot,
  policy: ConversionTargetPolicy,
): readonly string[] {
  const mismatches = new Set<string>();
  compareOptionalScalar("title", source.canonical.title, destination.canonical.title, mismatches);
  compareOptionalScalar("album", source.canonical.album, destination.canonical.album, mismatches);
  compareMultiset("artist", source.canonical.artists, destination.canonical.artists, mismatches);
  compareMultiset("genre", source.canonical.genres, destination.canonical.genres, mismatches);
  compareOptionalNumber(
    "track",
    source.canonical.track.no,
    destination.canonical.track.no,
    mismatches,
  );
  compareOptionalNumber(
    "trackTotal",
    source.canonical.track.of,
    destination.canonical.track.of,
    mismatches,
  );
  compareOptionalNumber("year", source.canonical.year, destination.canonical.year, mismatches);
  compareOptionalScalar("date", source.canonical.date, destination.canonical.date, mismatches);

  const sourcePicture = source.pictures[0];
  if (sourcePicture !== undefined && destination.pictures[0]?.digest !== sourcePicture.digest) {
    mismatches.add("artwork");
  }

  if (source.rating !== null && policy.ratingMode !== "unsupported") {
    const destinationRating = destination.rating?.value;
    const tolerance =
      policy.ratingMode === "popm-postwrite" ? 1 / 255 : 10 ** -OPUS_RATING_DECIMALS;
    if (
      destinationRating === undefined ||
      Math.abs(source.rating.value - destinationRating) > tolerance
    ) {
      mismatches.add("rating");
    }
  }

  if (policy.customTextMode === "mapped-and-audited") {
    const sourceCustom = customTextMultiset(source.textTags, policy.format);
    const destinationCustom = customTextMultiset(destination.textTags, policy.format);
    for (const [key, sourceValues] of sourceCustom) {
      if (!containsStringMultiset(destinationCustom.get(key) ?? [], sourceValues)) {
        mismatches.add(safeFieldName(key));
      }
    }
  }

  return [...mismatches].sort();
}

function customTextMultiset(
  tags: readonly ConversionTextTag[],
  target: ConvertFormat,
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const tag of tags) {
    if (tag.kind !== "custom" || !isCustomTagCompatible(tag, target)) continue;
    const identity = customTagIdentity(tag);
    const values = result.get(identity) ?? [];
    values.push(...tag.values);
    result.set(identity, values);
  }
  for (const values of result.values()) values.sort();
  return result;
}

function compareOptionalScalar(
  field: string,
  source: string | undefined,
  destination: string | undefined,
  mismatches: Set<string>,
): void {
  if (source !== undefined && (destination === undefined || nfc(source) !== nfc(destination))) {
    mismatches.add(field);
  }
}

function compareOptionalNumber(
  field: string,
  source: number | undefined,
  destination: number | undefined,
  mismatches: Set<string>,
): void {
  if (source !== undefined && source !== destination) mismatches.add(field);
}

function compareMultiset(
  field: string,
  source: readonly string[],
  destination: readonly string[],
  mismatches: Set<string>,
): void {
  if (source.length > 0 && !sameStrings(source.map(nfc).sort(), destination.map(nfc).sort())) {
    mismatches.add(field);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsStringMultiset(
  available: readonly string[],
  required: readonly string[],
): boolean {
  const counts = new Map<string, number>();
  for (const value of available) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of required) {
    const remaining = counts.get(value) ?? 0;
    if (remaining === 0) return false;
    counts.set(value, remaining - 1);
  }
  return true;
}

function makeWarning(
  code: ConversionWarningCode,
  reason: string,
  target: ConvertFormat,
  fields: readonly string[],
  source: string,
  destination: string,
): ConversionWarning {
  return {
    code,
    reason,
    target,
    fields: [...new Set(fields.map(safeFieldName))].sort(),
    source,
    destination,
    outputUsable: true,
  };
}

function sortAndDedupeWarnings(
  warnings: readonly ConversionWarning[],
): readonly ConversionWarning[] {
  const byReason = new Map<string, ConversionWarning>();
  for (const warning of warnings) {
    const key = [
      warning.source,
      warning.destination,
      warning.target,
      warning.code,
      warning.reason,
    ].join("\0");
    const existing = byReason.get(key);
    byReason.set(
      key,
      existing === undefined
        ? warning
        : { ...warning, fields: [...new Set([...existing.fields, ...warning.fields])].sort() },
    );
  }
  return [...byReason.values()].sort((left, right) =>
    [left.source, left.destination, left.code, left.fields[0] ?? "", left.reason]
      .join("\0")
      .localeCompare(
        [right.source, right.destination, right.code, right.fields[0] ?? "", right.reason].join(
          "\0",
        ),
      ),
  );
}

function scalarTextValues(value: unknown): readonly string[] | null {
  if (typeof value === "string") return [value];
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)),
    )
  ) {
    return value.map(String);
  }
  return null;
}

function projectNativeTextValue(
  sourceFamily: string,
  key: string,
  value: unknown,
): {
  readonly values: readonly string[];
  readonly customIdentity?: {
    readonly namespace?: string;
    readonly descriptor?: string;
  };
  readonly unsupportedField?: string;
} | null {
  if (sourceFamily.toLowerCase().startsWith("id3") && key.toUpperCase() === "COMM") {
    if (!isId3Comment(value) || value.text === undefined) return null;
    const descriptor =
      value.descriptor === undefined
        ? undefined
        : validatedText(value.descriptor, "comment descriptor");
    if (value.language !== undefined) validatedText(value.language, "comment language");
    return {
      values: [value.text],
      ...(descriptor === undefined || descriptor.length === 0
        ? {}
        : { unsupportedField: "COMM:descriptor" }),
      customIdentity: {
        namespace: "COMM",
        ...(descriptor === undefined ? {} : { descriptor }),
      },
    };
  }
  const values = scalarTextValues(value);
  return values === null ? null : { values };
}

function isId3Comment(value: unknown): value is Id3Comment {
  if (!isRecord(value)) return false;
  const { descriptor, language, text } = value;
  return (
    (descriptor === undefined || typeof descriptor === "string") &&
    (language === undefined || typeof language === "string") &&
    (text === undefined || typeof text === "string")
  );
}

function normalizeTextKey(key: string): string {
  return key.toUpperCase();
}

function isCanonicalNativeTag(sourceFamily: string, key: string): boolean {
  const family = sourceFamily.toLowerCase();
  const normalizedKey = key.toUpperCase();
  if (family.startsWith("id3")) return ID3_CANONICAL_KEYS.has(normalizedKey);
  if (family === "vorbis") return VORBIS_CANONICAL_KEYS.has(normalizedKey);
  if (family === "itunes") return ITUNES_CANONICAL_KEYS.has(normalizedKey);
  return false;
}

function parseCustomIdentity(key: string): {
  readonly namespace?: string;
  readonly descriptor?: string;
} {
  const separator = key.indexOf(":");
  if (separator < 0) return { descriptor: key };
  if (key.startsWith("----:")) {
    const descriptorSeparator = key.lastIndexOf(":");
    return {
      namespace: key.slice(0, descriptorSeparator),
      descriptor: key.slice(descriptorSeparator + 1),
    };
  }
  return {
    namespace: key.slice(0, separator),
    descriptor: key.slice(separator + 1),
  };
}

function customTagIdentity(tag: ConversionTextTag): string {
  if (isPortableCommentTag(tag)) return "COMMENT";
  return portableCustomDescriptor(tag);
}

function isPortableCommentTag(tag: ConversionTextTag): boolean {
  const family = tag.sourceFamily.toLowerCase();
  const nativeKey = tag.key.toUpperCase();
  const descriptor = portableCustomDescriptor(tag).toUpperCase();
  if (family.startsWith("id3")) {
    return (
      nativeKey === "COMM" || (tag.namespace?.toUpperCase() === "TXXX" && descriptor === "COMMENT")
    );
  }
  if (family === "vorbis") {
    return nativeKey === "COMMENT" || nativeKey === "DESCRIPTION";
  }
  return family === "itunes" && nativeKey === "©CMT";
}

function portableCustomDescriptor(tag: ConversionTextTag): string {
  return tag.descriptor ?? parseCustomIdentity(tag.key).descriptor ?? tag.key;
}

function opusCustomKey(tag: ConversionTextTag): string {
  return isPortableCommentTag(tag) ? "COMMENT" : portableCustomDescriptor(tag);
}

function isCustomTagCompatible(tag: ConversionTextTag, target: ConvertFormat): boolean {
  if (tag.kind !== "custom") return false;
  const policy = getConversionTargetPolicy(target);
  if (policy.customTextMode === "unsupported") return false;
  if (target === "opus") {
    const descriptor = opusCustomKey(tag);
    return (
      isVorbisCompatibleKey(descriptor) && !OPUS_RESERVED_CUSTOM_KEYS.has(descriptor.toUpperCase())
    );
  }
  return true;
}

function isVorbisCompatibleKey(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= MAX_TEXT_KEY_BYTES &&
    /^[\x20-\x3c\x3e-\x7e]+$/.test(value) &&
    !value.includes("=")
  );
}

function validatedKey(value: string): string {
  const key = validatedText(value, "text key").trim();
  if (key.length === 0) {
    throw new ConversionMetadataError("metadata_parse_failed", "Source text key is empty", [
      "text",
    ]);
  }
  if (Buffer.byteLength(key, "utf8") > MAX_TEXT_KEY_BYTES) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Source text key exceeds the configured byte limit",
      ["text"],
    );
  }
  return key;
}

function validatedVorbisKey(value: string): string {
  if (!isVorbisCompatibleKey(value)) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Source custom text key is not compatible with Vorbis comments",
      ["text"],
    );
  }
  return value;
}

function validatedText(value: string, field: string): string {
  if (value.includes("\0")) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      `Source ${field} contains a forbidden NUL`,
      [safeFieldName(field)],
    );
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_VALUE_BYTES) {
    throw new ConversionMetadataError(
      "resource_limit",
      `Source ${field} exceeds the configured byte limit`,
      [safeFieldName(field)],
    );
  }
  return value;
}

function validatedPictureText(value: string, field: string): string {
  return validatedText(value, field);
}

function validatedPictureMime(value: string): string {
  const mime = validatedText(value, "picture MIME");
  if (!/^[\x20-\x7e]+$/.test(mime)) {
    throw new ConversionMetadataError("metadata_parse_failed", "Source picture MIME is not safe", [
      "artwork",
    ]);
  }
  return mime;
}

function assertSnapshotTextBounds(
  canonical: ConversionCanonicalMetadata,
  textTags: readonly ConversionTextTag[],
  rating: NormalizedRating | null,
  sourceTagFamilies: readonly string[],
  unsupportedNativeFields: readonly string[],
): void {
  const canonicalValues = [
    canonical.title,
    ...canonical.artists,
    canonical.album,
    canonical.date,
    ...canonical.genres,
  ].filter((value): value is string => value !== undefined);
  const ratingValues =
    rating === null ? [] : [rating.source, ...(rating.email === undefined ? [] : [rating.email])];
  const totalValueCount =
    canonicalValues.length +
    ratingValues.length +
    sourceTagFamilies.length +
    unsupportedNativeFields.length +
    textTags.length +
    textTags.reduce((total, tag) => total + tag.values.length, 0);
  if (totalValueCount > MAX_TEXT_TAGS) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Source metadata field count exceeds the configured limit",
      ["text"],
    );
  }
  const totalBytes =
    canonicalValues.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) +
    ratingValues.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) +
    sourceTagFamilies.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) +
    unsupportedNativeFields.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) +
    textTags.reduce(
      (total, tag) =>
        total +
        Buffer.byteLength(tag.key, "utf8") +
        Buffer.byteLength(tag.normalizedKey, "utf8") +
        Buffer.byteLength(tag.sourceFamily, "utf8") +
        (tag.namespace === undefined ? 0 : Buffer.byteLength(tag.namespace, "utf8")) +
        (tag.descriptor === undefined ? 0 : Buffer.byteLength(tag.descriptor, "utf8")) +
        tag.values.reduce(
          (valuesTotal, value) => valuesTotal + Buffer.byteLength(value, "utf8"),
          0,
        ),
      0,
    );
  if (totalBytes > MAX_AGGREGATE_TEXT_BYTES) {
    throw new ConversionMetadataError(
      "resource_limit",
      "Aggregate source text exceeds the configured byte limit",
      ["text"],
    );
  }
}

function validatedRating(rating: NormalizedRating | null): NormalizedRating | null {
  if (rating === null) return null;
  if (
    !Number.isFinite(rating.value) ||
    rating.value <= 0 ||
    rating.value > 1 ||
    !["POPM", "Vorbis", "iTunes", "unknown"].includes(rating.source)
  ) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Source rating provenance is not trustworthy",
      ["rating"],
    );
  }
  if (
    rating.counter !== undefined &&
    (!Number.isSafeInteger(rating.counter) || rating.counter < 0)
  ) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Source rating counter is not trustworthy",
      ["rating"],
    );
  }
  return {
    value: rating.value,
    source: rating.source,
    ...(rating.email === undefined ? {} : { email: validatedText(rating.email, "rating email") }),
    ...(rating.counter === undefined ? {} : { counter: rating.counter }),
  };
}

function validatedCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      `Source ${field} is not a non-negative integer`,
      [safeFieldName(field)],
    );
  }
  return value;
}

function safeFieldName(value: string): string {
  const safe = value
    .normalize("NFC")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 255);
  return safe.length === 0 ? "metadata" : safe;
}

function sanitizeHumanText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined ? "" : `\\u${codePoint.toString(16).padStart(4, "0")}`;
  });
}

function picturePriority(picture: IPicture): number {
  const type = picture.type?.toLowerCase() ?? "";
  return type.includes("front") || type === "cover" ? 0 : 1;
}

function writeUint32(buffer: Buffer, offset: number, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Picture metadata exceeds the FLAC unsigned integer range",
      ["artwork"],
    );
  }
  buffer.writeUInt32BE(value, offset);
  return offset + 4;
}

function pushOptionalEntry(
  entries: [string, string][],
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) entries.push([key, value]);
}

function formatOpusRating(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConversionMetadataError(
      "metadata_parse_failed",
      "Normalized rating is outside the supported range",
      ["rating"],
    );
  }
  return value.toFixed(OPUS_RATING_DECIMALS);
}

function ratingPathForTarget(target: ConvertFormat): string {
  switch (target) {
    case "mp3":
      return "audit.mp3";
    case "opus":
      return "audit.opus";
    case "aac":
    case "alac":
      return "audit.m4a";
    default: {
      const exhaustive: never = target;
      throw new Error(`Unhandled conversion target: ${String(exhaustive)}`);
    }
  }
}

function assertLocalPath(filePath: string): void {
  const windowsDrivePath = /^[A-Za-z]:[\\/]/.test(filePath);
  const windowsUncPath = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(filePath);
  if (
    filePath.length === 0 ||
    filePath.includes("\0") ||
    (!windowsDrivePath && !windowsUncPath && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(filePath))
  ) {
    throw new ConversionMetadataError(
      "invalid_source",
      "Conversion metadata requires a local filesystem path",
    );
  }
}

function metadataDescriptorPath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new ConversionMetadataError(
    "invalid_source",
    "Descriptor-backed metadata parsing is unsupported on this platform",
  );
}

async function assertRegularFile(filePath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new ConversionMetadataError(
      "invalid_source",
      "Conversion metadata requires a readable local regular file",
      [],
      { cause: error },
    );
  }
  if (!stats.isFile()) {
    throw new ConversionMetadataError(
      "invalid_source",
      "Conversion metadata requires a local regular file",
    );
  }
}

async function assertRegularFileHandle(handle: FileHandle): Promise<void> {
  try {
    const stats = await handle.stat();
    if (stats.isFile()) return;
  } catch (error) {
    throw new ConversionMetadataError(
      "invalid_source",
      "Conversion metadata requires a readable regular-file descriptor",
      [],
      { cause: error },
    );
  }
  throw new ConversionMetadataError(
    "invalid_source",
    "Conversion metadata requires a regular-file descriptor",
  );
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isChildResponse(value: unknown): value is ConversionMetadataChildResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  if (value.ok) {
    return "snapshot" in value && isConversionMetadataSnapshot(value.snapshot);
  }
  return (
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error &&
    isConversionMetadataErrorCode(value.error.code) &&
    "message" in value.error &&
    typeof value.error.message === "string" &&
    "fields" in value.error &&
    Array.isArray(value.error.fields) &&
    value.error.fields.length <= MAX_TEXT_TAGS &&
    value.error.fields.every(
      (field) =>
        typeof field === "string" &&
        Buffer.byteLength(field, "utf8") <= MAX_TEXT_KEY_BYTES &&
        !field.includes("\0"),
    )
  );
}

function isConversionMetadataSnapshot(value: unknown): value is ConversionMetadataSnapshot {
  if (!isRecord(value)) return false;
  const {
    sourceTagFamilies,
    canonical,
    textTags,
    rating,
    unsupportedNativeFields,
    pictureCount,
    pictures,
  } = value;
  if (
    !isBoundedStringArray(sourceTagFamilies, MAX_TEXT_TAGS, MAX_TEXT_KEY_BYTES) ||
    !isCanonicalMetadata(canonical) ||
    !isConversionTextTags(textTags) ||
    !isNormalizedRating(rating) ||
    !isBoundedStringArray(unsupportedNativeFields, MAX_TEXT_TAGS, MAX_TEXT_KEY_BYTES) ||
    typeof pictureCount !== "number" ||
    !Number.isSafeInteger(pictureCount) ||
    pictureCount < 0 ||
    pictureCount > MAX_PICTURES ||
    !Array.isArray(pictures) ||
    pictures.length > 1 ||
    pictures.length !== Math.min(pictureCount, 1) ||
    !pictures.every(isConversionPicture) ||
    pictures.some((picture) => picture.sourceIndex >= pictureCount)
  ) {
    return false;
  }

  const snapshot = value as unknown as ConversionMetadataSnapshot;
  const canonicalValues = [
    snapshot.canonical.title,
    ...snapshot.canonical.artists,
    snapshot.canonical.album,
    snapshot.canonical.date,
    ...snapshot.canonical.genres,
  ].filter((entry): entry is string => entry !== undefined);
  const ratingValues =
    snapshot.rating === null
      ? []
      : [
          snapshot.rating.source,
          ...(snapshot.rating.email === undefined ? [] : [snapshot.rating.email]),
        ];
  const textValueCount =
    canonicalValues.length +
    ratingValues.length +
    snapshot.sourceTagFamilies.length +
    snapshot.unsupportedNativeFields.length +
    snapshot.textTags.length +
    snapshot.textTags.reduce((total, tag) => total + tag.values.length, 0);
  if (textValueCount > MAX_TEXT_TAGS) return false;

  const textBytes = [
    ...canonicalValues,
    ...ratingValues,
    ...snapshot.sourceTagFamilies,
    ...snapshot.unsupportedNativeFields,
    ...snapshot.textTags.flatMap((tag) => [
      tag.key,
      tag.normalizedKey,
      tag.sourceFamily,
      ...(tag.namespace === undefined ? [] : [tag.namespace]),
      ...(tag.descriptor === undefined ? [] : [tag.descriptor]),
      ...tag.values,
    ]),
  ].reduce((total, entry) => total + Buffer.byteLength(entry, "utf8"), 0);
  return textBytes <= MAX_AGGREGATE_TEXT_BYTES;
}

function isCanonicalMetadata(value: unknown): value is ConversionCanonicalMetadata {
  if (!isRecord(value)) return false;
  const { title, artists, album, track, year, date, genres } = value;
  if (!isRecord(track)) return false;
  const { no, of } = track;
  return (
    isOptionalBoundedString(title) &&
    isBoundedStringArray(artists, MAX_TEXT_TAGS, MAX_TEXT_VALUE_BYTES) &&
    isOptionalBoundedString(album) &&
    isOptionalNonNegativeSafeInteger(no) &&
    isOptionalNonNegativeSafeInteger(of) &&
    isOptionalNonNegativeSafeInteger(year) &&
    isOptionalBoundedString(date) &&
    isBoundedStringArray(genres, MAX_TEXT_TAGS, MAX_TEXT_VALUE_BYTES)
  );
}

function isConversionTextTags(value: unknown): value is readonly ConversionTextTag[] {
  if (!Array.isArray(value) || value.length > MAX_TEXT_TAGS) return false;
  let valueCount = 0;
  for (const tag of value) {
    if (!isRecord(tag)) return false;
    const { key, normalizedKey, sourceFamily, kind, namespace, descriptor, values } = tag;
    if (
      !isBoundedString(key, MAX_TEXT_KEY_BYTES) ||
      key.trim().length === 0 ||
      !isBoundedString(normalizedKey, MAX_TEXT_KEY_BYTES) ||
      normalizedKey !== key.toUpperCase() ||
      !isBoundedString(sourceFamily, MAX_TEXT_KEY_BYTES) ||
      (kind !== "canonical" && kind !== "custom") ||
      !isOptionalBoundedString(namespace, MAX_TEXT_KEY_BYTES) ||
      !isOptionalBoundedString(descriptor, MAX_TEXT_KEY_BYTES) ||
      !isBoundedStringArray(values, MAX_TEXT_TAGS, MAX_TEXT_VALUE_BYTES)
    ) {
      return false;
    }
    valueCount += values.length;
    if (valueCount > MAX_TEXT_TAGS) return false;
  }
  return true;
}

function isNormalizedRating(value: unknown): value is NormalizedRating | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const { value: ratingValue, source, email, counter } = value;
  return (
    typeof ratingValue === "number" &&
    Number.isFinite(ratingValue) &&
    ratingValue > 0 &&
    ratingValue <= 1 &&
    (source === "POPM" || source === "Vorbis" || source === "iTunes" || source === "unknown") &&
    isOptionalBoundedString(email) &&
    isOptionalNonNegativeSafeInteger(counter)
  );
}

function isConversionPicture(value: unknown): value is ConversionPicture {
  if (!isRecord(value)) return false;
  const { sourceIndex, format, type, description, data, digest, width, height, depth, colors } =
    value;
  if (
    typeof sourceIndex !== "number" ||
    !Number.isSafeInteger(sourceIndex) ||
    sourceIndex < 0 ||
    sourceIndex >= MAX_PICTURES ||
    !isBoundedString(format, MAX_TEXT_VALUE_BYTES) ||
    !/^[\x20-\x7e]+$/.test(format) ||
    format === "-->" ||
    !isOptionalBoundedString(type) ||
    !isOptionalBoundedString(description) ||
    !(data instanceof Uint8Array) ||
    data.byteLength > MAX_PRIMARY_PICTURE_BYTES ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !isOptionalUint32(width) ||
    !isOptionalUint32(height) ||
    !isOptionalUint32(depth) ||
    !isOptionalUint32(colors)
  ) {
    return false;
  }
  return createHash("sha256").update(data).digest("hex") === digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isOptionalBoundedString(
  value: unknown,
  maxBytes = MAX_TEXT_VALUE_BYTES,
): value is string | undefined {
  return value === undefined || isBoundedString(value, maxBytes);
}

function isBoundedStringArray(
  value: unknown,
  maxCount: number,
  maxBytes: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxCount &&
    value.every((entry) => isBoundedString(entry, maxBytes))
  );
}

function isOptionalNonNegativeSafeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isOptionalUint32(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff)
  );
}

function isConversionMetadataErrorCode(value: unknown): value is ConversionMetadataErrorCode {
  return (
    value === "audit_mismatch" ||
    value === "invalid_source" ||
    value === "metadata_parse_failed" ||
    value === "resource_limit" ||
    value === "sidecar_cleanup_failed" ||
    value === "sidecar_write_failed"
  );
}

function nfc(value: string): string {
  return value.normalize("NFC");
}
