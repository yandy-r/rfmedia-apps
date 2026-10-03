/**
 * Audio conversion utilities for rfmedia CLI.
 *
 * Provides ffmpeg-based audio conversion with format presets for:
 * - ALAC (Apple Lossless Audio Codec) -> .m4a
 * - MP3 (MPEG Audio Layer 3) -> .mp3
 * - AAC (Advanced Audio Coding) -> .m4a
 * - Opus (Opus Interactive Audio Codec) -> .opus
 *
 * Requires ffmpeg to be installed on the system.
 */

import path from "node:path";
import { promisify } from "node:util";
import { exec, spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

import type { ConvertFormat } from "../types/options.js";
import { isAudioFile } from "./audio.js";
import {
  auditConvertedMetadata,
  createConversionArtworkInput,
  createOpusMetadataSidecar,
  getConversionLimitations,
  getConversionTargetPolicy,
  readConversionMetadataFromHandle,
  renderConversionWarning,
} from "./conversion-metadata.js";
import type {
  ConversionMetadataSnapshot,
  ConversionWarning,
  ConversionArtworkInput,
  OpusMetadataSidecar,
} from "./conversion-metadata.js";
import { ensureDir, replaceFileWithValidatedStage } from "./filesystem.js";
import { logDebug, logWarn } from "./logger.js";
import { writeConversionMp3Rating } from "./tag-writer.js";

const execAsync = promisify(exec);

/**
 * Configuration for each audio conversion format.
 */
interface ConversionPreset {
  /** FFmpeg audio codec name */
  codec: string;
  /** Output file extension (without dot) */
  extension: string;
  /** Human-readable format description */
  description: string;
}

/**
 * Conversion presets for each supported format.
 */
const CONVERSION_PRESETS: Record<ConvertFormat, ConversionPreset> = {
  alac: {
    codec: "alac",
    extension: "m4a",
    description: "Apple Lossless Audio Codec",
  },
  mp3: {
    codec: "libmp3lame",
    extension: "mp3",
    description: "MPEG Audio Layer 3 (320kbps)",
  },
  aac: {
    codec: "aac",
    extension: "m4a",
    description: "Advanced Audio Coding (256kbps)",
  },
  opus: {
    codec: "libopus",
    extension: "opus",
    description: "Opus Interactive Audio Codec (128kbps)",
  },
};

const MAX_PROGRESS_PERCENT = 99.99;
const MAX_STDERR_LENGTH = 10_000;
const RETAINED_STDERR_LENGTH = 5_000;
const FFMPEG_SOURCE_FD = 3;
const FFMPEG_STAGE_FD = 4;
const FFMPEG_OPUS_METADATA_FD = 5;
const FFMPEG_ARTWORK_FD = 6;

interface SourceFileVersion {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/**
 * Callback for conversion progress events.
 */
export interface ConversionProgressCallback {
  (progress: ConversionProgress): void;
}

/**
 * Progress information during audio conversion.
 */
export interface ConversionProgress {
  /** Percentage complete (0-100) */
  percent: number;
  /** Current processing time in seconds */
  timemark: string;
  /** Target size in kilobytes */
  targetSize?: number;
  /** Current frame being processed */
  currentFps?: number;
}

/**
 * Result of a conversion operation.
 */
export interface ConversionResult {
  /** Path to the converted file */
  outputPath: string;
  /** Duration of conversion in milliseconds */
  duration: number;
  /** Whether the conversion succeeded */
  success: boolean;
  /** Safe, deterministic target limitations for the usable output */
  warnings: readonly ConversionWarning[];
  /** Error message if conversion failed */
  error?: string;
}

/**
 * Optional validation applied to the same private conversion stage after the
 * metadata audit and before publication.
 */
export interface ConversionValidationOptions {
  readonly onProgress?: ConversionProgressCallback;
  readonly signal?: AbortSignal;
  readonly additionalValidator?: (
    stagedPath: string,
    signal: AbortSignal,
    stagedHandle: FileHandle,
  ) => Promise<void>;
}

/**
 * Error thrown when ffmpeg is not available.
 */
export class FfmpegNotFoundError extends Error {
  constructor() {
    super(
      "ffmpeg is not installed or not found in PATH. " +
        "Please install ffmpeg to use audio conversion features. " +
        "On Ubuntu/Debian: sudo apt install ffmpeg, " +
        "On macOS: brew install ffmpeg",
    );
    this.name = "FfmpegNotFoundError";
  }
}

/**
 * Error thrown when conversion fails.
 */
export class ConversionError extends Error {
  public readonly sourcePath: string;
  public readonly destPath: string;
  public readonly reason: string;

  constructor(sourcePath: string, destPath: string, reason: string) {
    super(`Failed to convert ${path.basename(sourcePath)}: ${reason}`);
    this.name = "ConversionError";
    this.sourcePath = sourcePath;
    this.destPath = destPath;
    this.reason = reason;
  }
}

/**
 * Checks if ffmpeg is available on the system.
 *
 * @returns true if ffmpeg is available, false otherwise
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execAsync("ffmpeg -version");
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that ffmpeg is available, throwing an error if not.
 *
 * @throws FfmpegNotFoundError if ffmpeg is not available
 */
export async function requireFfmpeg(): Promise<void> {
  const available = await isFfmpegAvailable();
  if (!available) {
    throw new FfmpegNotFoundError();
  }
}

/**
 * Gets the output filename for a converted audio file.
 *
 * Replaces the original extension with the appropriate extension
 * for the target format.
 *
 * @param originalPath - Path to the original audio file
 * @param format - Target conversion format
 * @returns New filename with the correct extension
 */
export function getConvertedFilename(originalPath: string, format: ConvertFormat): string {
  const preset = CONVERSION_PRESETS[format];
  const filename = path.basename(originalPath);
  const ext = path.extname(filename);
  const nameWithoutExt = filename.slice(0, -ext.length);

  return `${nameWithoutExt}.${preset.extension}`;
}

/**
 * Gets the output file extension for a conversion format.
 *
 * @param format - Target conversion format
 * @returns File extension without the leading dot
 */
export function getConvertedExtension(format: ConvertFormat): string {
  return CONVERSION_PRESETS[format].extension;
}

/**
 * Gets the human-readable description for a conversion format.
 *
 * @param format - Conversion format
 * @returns Description string
 */
export function getFormatDescription(format: ConvertFormat): string {
  return CONVERSION_PRESETS[format].description;
}

/**
 * Parses time string from ffmpeg output (HH:MM:SS.mmm format).
 *
 * @param timeStr - Time string in format HH:MM:SS.mmm or MM:SS.mmm
 * @returns Time in seconds, or null if parsing fails
 */
function parseTime(timeStr: string): number | null {
  const parts = timeStr.split(":");
  if (parts.length === 3) {
    // HH:MM:SS.mmm
    const hours = parseFloat(parts[0] ?? "0");
    const minutes = parseFloat(parts[1] ?? "0");
    const seconds = parseFloat(parts[2] ?? "0");
    return hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    // MM:SS.mmm
    const minutes = parseFloat(parts[0] ?? "0");
    const seconds = parseFloat(parts[1] ?? "0");
    return minutes * 60 + seconds;
  }
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function sourceVersionFromStat(
  source: string,
  destination: string,
  stats: Stats,
): SourceFileVersion {
  if (!stats.isFile()) {
    throw new ConversionError(source, destination, "Source is not a regular file");
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameSourceVersion(left: SourceFileVersion, right: SourceFileVersion): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function openStableSource(
  source: string,
  destination: string,
): Promise<{ readonly handle: FileHandle; readonly version: SourceFileVersion }> {
  let pathStats: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStats = await lstat(source);
  } catch (error) {
    throw new ConversionError(
      source,
      destination,
      isErrno(error, "ENOENT") ? `Source file not found: ${source}` : "Source could not be read",
    );
  }
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new ConversionError(source, destination, "Source is not a local regular file");
  }

  const handle = await open(source, "r");
  try {
    const version = sourceVersionFromStat(source, destination, await handle.stat());
    const currentPathVersion = sourceVersionFromStat(source, destination, await lstat(source));
    if (!sameSourceVersion(version, currentPathVersion)) {
      throw new ConversionError(source, destination, "Source changed while opening");
    }
    return { handle, version };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertSourceUnchanged(
  source: string,
  destination: string,
  expected: SourceFileVersion,
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(source);
  } catch (error) {
    throw new ConversionError(
      source,
      destination,
      isErrno(error, "ENOENT") ? "Source disappeared during conversion" : "Source changed",
    );
  }
  if (
    current.isSymbolicLink() ||
    !sameSourceVersion(expected, sourceVersionFromStat(source, destination, current))
  ) {
    throw new ConversionError(source, destination, "Source changed during conversion");
  }
}

function childDescriptorPath(fd: number, source: string, destination: string): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new ConversionError(
    source,
    destination,
    "Secure descriptor-backed conversion is not supported on this platform",
  );
}

function buildFfmpegArgs(
  sourceInput: string,
  stagedOutput: string,
  format: ConvertFormat,
  snapshot: ConversionMetadataSnapshot,
  opusMetadataInput: string | undefined,
  artworkInput: string | undefined,
): string[] {
  const policy = getConversionTargetPolicy(format);

  if (format === "opus") {
    if (opusMetadataInput === undefined) {
      throw new ConversionError(sourceInput, stagedOutput, "Opus metadata input was not prepared");
    }
    return [
      "-nostdin",
      "-i",
      sourceInput,
      "-f",
      "ffmetadata",
      "-i",
      opusMetadataInput,
      "-map",
      "0:a:0",
      "-map_metadata",
      "0:g",
      "-map_metadata:s:a",
      "1:g",
      ...policy.audioArgs,
      "-f",
      policy.muxer,
      "-y",
      stagedOutput,
    ];
  }

  const track = snapshot.canonical.track;
  const trackMetadataArgs =
    track.no === undefined && track.of === undefined
      ? []
      : ["-metadata", `track=${track.no ?? 0}${track.of === undefined ? "" : `/${track.of}`}`];
  const primaryPicture = snapshot.pictures[0];
  const artworkInputArgs =
    primaryPicture === undefined || artworkInput === undefined
      ? []
      : ["-f", "image2pipe", "-i", artworkInput];
  const artworkArgs =
    primaryPicture === undefined || artworkInput === undefined
      ? []
      : ["-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"];

  return [
    "-nostdin",
    "-i",
    sourceInput,
    ...artworkInputArgs,
    "-map",
    "0:a:0",
    "-map_metadata",
    "0:g",
    ...trackMetadataArgs,
    ...policy.audioArgs,
    ...artworkArgs,
    "-f",
    policy.muxer,
    "-y",
    stagedOutput,
  ];
}

function actionableFfmpegError(
  stderr: string,
  source: string,
  dest: string,
  codec: string,
  code: number | null,
): ConversionError {
  let reason =
    code === null ? "FFmpeg process terminated unexpectedly" : `FFmpeg exited with ${code}`;

  if (stderr.includes("No such file or directory") || stderr.includes("No such file")) {
    reason = `Source file not found: ${source}`;
  } else if (stderr.includes("Permission denied")) {
    reason = `Permission denied writing to: ${dest}`;
  } else if (stderr.includes("Unknown encoder") || stderr.includes("Encoder not found")) {
    reason =
      `FFmpeg codec '${codec}' is not available. ` +
      "Make sure ffmpeg is compiled with the required codec support.";
  } else if (stderr.includes("Invalid data found") || stderr.includes("Invalid argument")) {
    reason = `Invalid or corrupted audio file: ${source}`;
  }

  return new ConversionError(source, dest, reason);
}

async function runFfmpeg(
  source: string,
  dest: string,
  format: ConvertFormat,
  opusSidecar: OpusMetadataSidecar | undefined,
  artworkInput: ConversionArtworkInput | undefined,
  onProgress: ConversionProgressCallback | undefined,
  signal: AbortSignal,
  snapshot: ConversionMetadataSnapshot,
  sourceHandle: FileHandle,
  stagedHandle: FileHandle,
): Promise<void> {
  signal.throwIfAborted();
  const argv = buildFfmpegArgs(
    childDescriptorPath(FFMPEG_SOURCE_FD, source, dest),
    childDescriptorPath(FFMPEG_STAGE_FD, source, dest),
    format,
    snapshot,
    opusSidecar === undefined
      ? undefined
      : childDescriptorPath(FFMPEG_OPUS_METADATA_FD, source, dest),
    artworkInput === undefined ? undefined : childDescriptorPath(FFMPEG_ARTWORK_FD, source, dest),
  );
  const preset = CONVERSION_PRESETS[format];

  await new Promise<void>((resolve, reject) => {
    let ffmpegProcess: ReturnType<typeof spawn>;
    try {
      ffmpegProcess = spawn("ffmpeg", argv, {
        shell: false,
        signal,
        stdio: [
          "ignore",
          "ignore",
          "pipe",
          sourceHandle.fd,
          stagedHandle.fd,
          opusSidecar?.handle.fd ?? "ignore",
          artworkInput?.handle.fd ?? "ignore",
        ],
      });
    } catch (error) {
      if (signal.aborted) {
        reject(signal.reason);
      } else {
        const message = error instanceof Error ? error.message : "";
        reject(
          message.includes("ENOENT") || message.includes("spawn ffmpeg")
            ? new FfmpegNotFoundError()
            : new ConversionError(source, dest, message || "FFmpeg could not be started"),
        );
      }
      return;
    }

    let settled = false;
    let aborted = false;
    let abortReason: unknown;
    let processError: Error | undefined;
    let mediaDuration: number | null = null;
    let stderrBuffer = "";

    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const handleAbort = (): void => {
      aborted = true;
      abortReason = signal.reason;
    };

    signal.addEventListener("abort", handleAbort, { once: true });

    ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();

      const durationMatch = stderrBuffer.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (durationMatch && mediaDuration === null) {
        mediaDuration = parseTime(durationMatch[1] ?? "");
      }

      const timeMatches = [...stderrBuffer.matchAll(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/g)];
      const currentMatch = timeMatches.at(-1);
      if (onProgress && currentMatch && mediaDuration) {
        const currentTime = parseTime(currentMatch[1] ?? "");
        if (currentTime !== null) {
          const percent = Math.min(
            MAX_PROGRESS_PERCENT,
            Math.max(0, (currentTime / mediaDuration) * 100),
          );
          onProgress({
            percent: Math.round(percent * 100) / 100,
            timemark: currentMatch[1] ?? "00:00:00.00",
          });
        }
      }

      if (stderrBuffer.length > MAX_STDERR_LENGTH) {
        stderrBuffer = stderrBuffer.slice(-RETAINED_STDERR_LENGTH);
      }
    });

    ffmpegProcess.once("close", (code) => {
      if (signal.aborted && !aborted) {
        handleAbort();
      }

      if (aborted) {
        settle(abortReason);
      } else if (processError) {
        if (
          processError.message.includes("ENOENT") ||
          processError.message.includes("spawn ffmpeg")
        ) {
          settle(new FfmpegNotFoundError());
        } else {
          settle(new ConversionError(source, dest, processError.message || "Unknown ffmpeg error"));
        }
      } else if (code === 0) {
        settle();
      } else {
        settle(actionableFfmpegError(stderrBuffer, source, dest, preset.codec, code));
      }
    });

    ffmpegProcess.once("error", (error: Error) => {
      if (signal.aborted) {
        if (!aborted) {
          handleAbort();
        }
      } else {
        processError = error;
      }
    });

    if (signal.aborted) {
      handleAbort();
    }
  });
  signal.throwIfAborted();
}

async function writeMp3Popm(
  source: string,
  dest: string,
  stagedHandle: FileHandle,
  snapshot: ConversionMetadataSnapshot,
  signal: AbortSignal,
): Promise<void> {
  if (snapshot.rating === null) return;

  const writeResult = await writeConversionMp3Rating(
    stagedHandle,
    snapshot.rating.value,
    {
      popmEmail: snapshot.rating.email,
      popmCounter: snapshot.rating.counter,
    },
    signal,
  );
  if (!writeResult.success) {
    throw new ConversionError(source, dest, "MP3 rating metadata could not be preserved");
  }
}

/**
 * Converts an audio file to a different format using ffmpeg.
 *
 * @param source - Path to the source audio file
 * @param dest - Path for the output file (extension should match format)
 * @param format - Target conversion format
 * @param onProgress - Optional callback for progress updates
 * @param signal - Optional signal for cancelling the ffmpeg process
 * @returns Promise that resolves when conversion is complete
 * @throws ConversionError if the conversion fails
 * @throws FfmpegNotFoundError if ffmpeg is not available
 */
export async function convertFile(
  source: string,
  dest: string,
  format: ConvertFormat,
  onProgress?: ConversionProgressCallback,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  return convertFileWithValidation(source, dest, format, { onProgress, signal });
}

/**
 * Convert, audit, optionally validate, and atomically publish one audio file.
 *
 * @internal
 */
export async function convertFileWithValidation(
  source: string,
  dest: string,
  format: ConvertFormat,
  options: ConversionValidationOptions = {},
): Promise<ConversionResult> {
  const { additionalValidator, onProgress, signal } = options;
  throwIfAborted(signal);
  const startTime = Date.now();
  const preset = CONVERSION_PRESETS[format];
  let opusSidecar: OpusMetadataSidecar | undefined;
  let artworkInput: ConversionArtworkInput | undefined;
  let sourceHandle: FileHandle | undefined;
  let published = false;

  try {
    await ensureDir(path.dirname(dest));
    throwIfAborted(signal);

    if (path.resolve(source) === path.resolve(dest)) {
      throw new ConversionError(source, dest, "Source and destination must be different files");
    }

    const stableSource = await openStableSource(source, dest);
    sourceHandle = stableSource.handle;
    throwIfAborted(signal);

    const snapshot = await readConversionMetadataFromHandle(stableSource.handle, source, signal);
    await assertSourceUnchanged(source, dest, stableSource.version);
    throwIfAborted(signal);
    const warnings = getConversionLimitations(snapshot, format, source, dest);
    throwIfAborted(signal);

    if (format === "opus") {
      opusSidecar = await createOpusMetadataSidecar(dest, snapshot);
      throwIfAborted(signal);
    } else if (snapshot.pictures[0] !== undefined) {
      artworkInput = await createConversionArtworkInput(dest, snapshot.pictures[0]);
      throwIfAborted(signal);
    }

    logDebug(`Converting ${source} to ${format} (${preset.description})`);
    logDebug(`  Codec: ${preset.codec}, Output: ${dest}`);

    await replaceFileWithValidatedStage(dest, {
      signal,
      preserveDestinationMode: true,
      missingDestinationMode: 0o666 & ~process.umask(),
      forbidDestinationIdentity: {
        dev: stableSource.version.dev,
        ino: stableSource.version.ino,
      },
      materialize: async (_stagedPath, stagedSignal, stagedHandle) => {
        stagedSignal.throwIfAborted();
        await assertSourceUnchanged(source, dest, stableSource.version);
        await runFfmpeg(
          source,
          dest,
          format,
          opusSidecar,
          artworkInput,
          onProgress,
          stagedSignal,
          snapshot,
          stableSource.handle,
          stagedHandle,
        );
        await opusSidecar?.dispose();
        await artworkInput?.dispose();
        await assertSourceUnchanged(source, dest, stableSource.version);
        stagedSignal.throwIfAborted();

        if (format === "mp3") {
          await writeMp3Popm(source, dest, stagedHandle, snapshot, stagedSignal);
          stagedSignal.throwIfAborted();
        }
      },
      validate: async (stagedPath, stagedSignal, stagedHandle) => {
        stagedSignal.throwIfAborted();
        await auditConvertedMetadata(snapshot, stagedHandle, format, stagedSignal);
        await assertSourceUnchanged(source, dest, stableSource.version);
        stagedSignal.throwIfAborted();

        if (additionalValidator) {
          await additionalValidator(stagedPath, stagedSignal, stagedHandle);
          stagedSignal.throwIfAborted();
        }
      },
    });
    published = true;

    const duration = Date.now() - startTime;
    onProgress?.({ percent: 100, timemark: "complete" });
    for (const warning of warnings) {
      logWarn(renderConversionWarning(warning));
    }
    logDebug(`Conversion complete: ${dest} (${duration}ms)`);
    return {
      outputPath: dest,
      duration,
      success: true,
      warnings,
    };
  } catch (error) {
    if (!published && signal?.aborted) {
      throw signal.reason;
    }
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await opusSidecar?.dispose();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await artworkInput?.dispose();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await sourceHandle?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
      if (!published && signal?.aborted) throw signal.reason;
      throw cleanupError;
    }
  }
}

/**
 * Checks if a file should be converted based on format and whether it's an audio file.
 *
 * Non-audio files are never converted.
 * Audio files are converted only when a format is specified.
 *
 * @param filePath - Path to the file
 * @param format - Optional conversion format
 * @returns true if the file should be converted
 */
export function shouldConvert(filePath: string, format: ConvertFormat | undefined): boolean {
  if (!format) {
    return false;
  }

  return isAudioFile(filePath);
}

/**
 * Gets the destination path for a file, handling conversion if needed.
 *
 * If conversion is enabled and the file is an audio file, the extension
 * is changed to match the target format. Otherwise, the original filename
 * is preserved.
 *
 * @param sourcePath - Path to the source file
 * @param destDir - Destination directory
 * @param format - Optional conversion format
 * @returns Full destination path
 */
export function getDestinationPath(
  sourcePath: string,
  destDir: string,
  format: ConvertFormat | undefined,
): string {
  const filename = shouldConvert(sourcePath, format)
    ? getConvertedFilename(sourcePath, format!)
    : path.basename(sourcePath);

  return path.join(destDir, filename);
}

/**
 * Validates that a conversion format string is valid.
 *
 * @param format - Format string to validate
 * @returns true if the format is valid
 */
export function isValidConvertFormat(format: string): format is ConvertFormat {
  return format in CONVERSION_PRESETS;
}

/**
 * Gets all valid conversion format names.
 *
 * @returns Array of valid format names
 */
export function getValidFormats(): ConvertFormat[] {
  return Object.keys(CONVERSION_PRESETS) as ConvertFormat[];
}
