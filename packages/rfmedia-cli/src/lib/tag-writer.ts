/**
 * Tag writer for audio file ratings.
 *
 * Provides a unified interface for writing ratings to different audio formats:
 * - MP3: POPM (Popularimeter) frame via node-id3
 * - FLAC/OGG: Vorbis RATING comment via flac-metadata
 *
 * @module lib/tag-writer
 */

import { Processor as FlacProcessor, data as flacData } from "flac-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, unlink, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { logDebug } from "./logger.js";
import { resolveLocalWorkerEntrypoint } from "./worker-entrypoint.js";
import type {
  ConversionRatingWorkerRequest,
  ConversionRatingWorkerResponse,
} from "./conversion-rating-worker.js";
import {
  encodePopmRating,
  MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES,
  writeMp3Rating,
} from "./tag-writer/mp3-publisher.js";

/**
 * Options for writing ratings to audio files.
 */
export interface WriteRatingOptions {
  /**
   * Explicit format for private staged files whose temporary suffix does not
   * identify the eventual container.
   */
  formatOverride?: "mp3" | "flac" | "ogg" | "opus" | "m4a" | "aac";
  /** POPM email identifier for MP3 files (blank values default to 'no@email') */
  popmEmail?: string;
  /** POPM play counter for MP3 files (default: 0) */
  popmCounter?: number;
  /** Vorbis rating scale: 'normalized' (0-1), 'stars' (0-5), 'percent' (0-100) */
  vorbisScale?: "normalized" | "stars" | "percent";
  /** Preserve existing tags (default: true) */
  preserveTags?: boolean;
  /** Cancels an in-progress MP3 metadata-preservation child process. */
  signal?: AbortSignal;
}

/**
 * Result of a tag write operation.
 */
export interface WriteRatingResult {
  success: boolean;
  message: string;
  format?: "mp3" | "flac" | "ogg";
}

/** Rating value the metadata reader will observe after a supported write. */
export type RatingWriteProjection =
  | {
      readonly supported: true;
      readonly normalized: number | null;
    }
  | {
      readonly supported: false;
      readonly normalized: null;
    };

const DEFAULT_POPM_EMAIL = "no@email";
export { MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES };
/** Compatibility alias for the isolated conversion writer's existing contract. */
export const MAX_CONVERSION_MP3_RATING_FILE_BYTES = MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES;
const RATING_CHILD_TIMEOUT_MS = 30_000;
const RATING_CHILD_KILL_GRACE_MS = 1_000;
const RATING_CHILD_EXEC_ARGS = [
  "--max-old-space-size=128",
  "--max-semi-space-size=32",
  "--stack-size=4096",
] as const;

function normalizeRating(rating: number): number {
  return Number.isFinite(rating) ? Math.max(0, Math.min(1, rating)) : 0;
}

function encodeVorbisRating(
  rating: number,
  scale: NonNullable<WriteRatingOptions["vorbisScale"]>,
): number {
  switch (scale) {
    case "stars":
      return Number((rating * 5).toFixed(1));
    case "percent":
      return Math.round(rating * 100);
    case "normalized":
      return Number(rating.toFixed(2));
  }
}

function observedVorbisRating(encoded: number): number | null {
  if (encoded <= 0) return null;
  if (encoded <= 1) return encoded;
  if (encoded <= 5) return encoded / 5;
  return encoded / 100;
}

/**
 * Projects a requested write through the selected container encoding and the
 * native-first metadata reader.
 */
export function projectRatingWrite(
  filePath: string,
  rating: number,
  options: Pick<WriteRatingOptions, "formatOverride" | "vorbisScale"> = {},
): RatingWriteProjection {
  const normalized = normalizeRating(rating);
  const extension = options.formatOverride ?? filePath.toLowerCase().split(".").pop();

  if (extension === "mp3") {
    const encoded = encodePopmRating(normalized);
    return {
      supported: true,
      normalized: encoded === 0 ? null : (encoded - 1) / 254,
    };
  }
  if (extension === "flac") {
    const encoded = encodeVorbisRating(normalized, options.vorbisScale ?? "normalized");
    return { supported: true, normalized: observedVorbisRating(encoded) };
  }
  return { supported: false, normalized: null };
}

/**
 * Write a rating to an audio file.
 *
 * Detects the file format and uses the appropriate method:
 * - MP3: Writes POPM frame using node-id3
 * - FLAC: Writes RATING Vorbis comment using flac-metadata
 * - OGG/Opus: Currently unsupported (returns failure)
 *
 * @param filePath - Path to the audio file
 * @param rating - Normalized rating (0.0 to 1.0)
 * @param options - Optional settings for the write operation
 * @returns Result of the write operation
 *
 * @example
 * const result = await writeRating('/path/to/song.mp3', 0.8);
 * // Writes POPM with rating 204 (0.8 * 255)
 */
export async function writeRating(
  filePath: string,
  rating: number,
  options: WriteRatingOptions = {},
): Promise<WriteRatingResult> {
  // Validate and clamp rating to [0, 1] range
  // Treat NaN or non-finite values as 0 to prevent metadata corruption
  const normalizedRating = normalizeRating(rating);

  const extension = options.formatOverride ?? filePath.toLowerCase().split(".").pop();

  switch (extension) {
    case "mp3":
      return writeMp3Rating(filePath, normalizedRating, options);
    case "flac":
      return writeFlacRating(filePath, normalizedRating, options);
    case "ogg":
    case "opus":
      return {
        success: false,
        message: "OGG/Opus tag writing not yet implemented",
        format: "ogg",
      };
    case "m4a":
    case "aac":
      return {
        success: false,
        message: "M4A/AAC ratings stored in iTunes database, not file tags",
      };
    default:
      return {
        success: false,
        message: `Unsupported format: ${extension}`,
      };
  }
}

/**
 * Write a conversion POPM tag through a memory-limited child that inherits the
 * already-validated staged file descriptor. The worker never resolves or
 * reopens the staged pathname.
 */
export async function writeConversionMp3Rating(
  stagedFile: FileHandle,
  rating: number,
  options: Pick<WriteRatingOptions, "popmEmail" | "popmCounter"> = {},
  signal?: AbortSignal,
): Promise<WriteRatingResult> {
  signal?.throwIfAborted();
  const normalizedRating = Number.isFinite(rating) ? Math.max(0, Math.min(1, rating)) : 0;
  const sourcePopmEmail = options.popmEmail ?? DEFAULT_POPM_EMAIL;
  const request: ConversionRatingWorkerRequest = {
    rating: normalizedRating,
    popmEmail: sourcePopmEmail.trim().length > 0 ? sourcePopmEmail : DEFAULT_POPM_EMAIL,
    popmCounter: options.popmCounter ?? 0,
  };

  if (process.platform !== "linux" && process.platform !== "darwin") {
    return {
      success: false,
      message: "Descriptor-based conversion rating writes are unsupported on this platform",
      format: "mp3",
    };
  }

  try {
    const stagedStats = await stagedFile.stat();
    if (
      !stagedStats.isFile() ||
      !Number.isSafeInteger(stagedStats.size) ||
      stagedStats.size < 0 ||
      stagedStats.size > MAX_CONVERSION_MP3_RATING_FILE_BYTES
    ) {
      return {
        success: false,
        message: "Conversion MP3 exceeds the safe synchronous rating-write size limit",
        format: "mp3",
      };
    }
  } catch {
    return {
      success: false,
      message: "Conversion MP3 descriptor could not be validated",
      format: "mp3",
    };
  }

  let child: ChildProcess;
  try {
    const workerEntrypoint = resolveLocalWorkerEntrypoint(
      import.meta.url,
      "conversion-rating-worker",
    );
    child = spawn(
      process.execPath,
      [...RATING_CHILD_EXEC_ARGS, ...workerEntrypoint.runtimeArgs, workerEntrypoint.path],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", stagedFile.fd, "ipc"],
      },
    );
  } catch {
    return {
      success: false,
      message: "Conversion rating worker could not be started safely",
      format: "mp3",
    };
  }

  return new Promise<WriteRatingResult>((resolveResult, rejectResult) => {
    let settled = false;
    let pending:
      | { readonly ok: true; readonly result: WriteRatingResult }
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
      if (pending.ok) resolveResult(pending.result);
      else rejectResult(pending.error);
    };
    const terminateWith = (
      outcome: NonNullable<typeof pending>,
      terminationSignal: NodeJS.Signals = "SIGTERM",
    ): void => {
      if (settled || pending !== undefined) return;
      pending = outcome;
      if (child.connected) child.disconnect();
      child.kill(terminationSignal);
      if (child.exitCode !== null || child.signalCode !== null) {
        settlePending();
        return;
      }
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settlePending();
      }, RATING_CHILD_KILL_GRACE_MS);
      killTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      terminateWith(
        {
          ok: true,
          result: {
            success: false,
            message: "Conversion rating write exceeded the isolated child-process time limit",
            format: "mp3",
          },
        },
        "SIGKILL",
      );
    }, RATING_CHILD_TIMEOUT_MS);
    timeoutTimer.unref();

    abortHandler = (): void => {
      terminateWith({ ok: false, error: signal?.reason });
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.once("message", (payload: unknown) => {
      if (!isConversionRatingWorkerResponse(payload)) {
        terminateWith({
          ok: true,
          result: {
            success: false,
            message: "Conversion rating worker returned an invalid response",
            format: "mp3",
          },
        });
        return;
      }
      terminateWith({
        ok: true,
        result: payload.ok
          ? { success: true, message: "Rating written", format: "mp3" }
          : { success: false, message: payload.message, format: "mp3" },
      });
    });
    child.once("error", () => {
      terminateWith({
        ok: true,
        result: {
          success: false,
          message: "Conversion rating worker failed",
          format: "mp3",
        },
      });
    });
    child.once("exit", () => {
      if (pending !== undefined) {
        settlePending();
        return;
      }
      terminateWith({
        ok: true,
        result: {
          success: false,
          message: "Conversion rating worker exited before returning a result",
          format: "mp3",
        },
      });
      settlePending();
    });

    if (signal?.aborted) {
      abortHandler();
      return;
    }
    if (child.send === undefined) {
      terminateWith({
        ok: true,
        result: {
          success: false,
          message: "Conversion rating worker IPC is unavailable",
          format: "mp3",
        },
      });
      return;
    }
    child.send(request, (error) => {
      if (error === null) return;
      terminateWith({
        ok: true,
        result: {
          success: false,
          message: "Conversion rating worker request could not be sent",
          format: "mp3",
        },
      });
    });
  });
}

function isConversionRatingWorkerResponse(value: unknown): value is ConversionRatingWorkerResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return true;
  return (
    value.ok === false && "message" in value && value.message === "node-id3 conversion write failed"
  );
}

/**
 * Write rating to FLAC file using Vorbis RATING comment.
 */
async function writeFlacRating(
  filePath: string,
  rating: number,
  options: WriteRatingOptions,
): Promise<WriteRatingResult> {
  const { vorbisScale = "normalized" } = options;

  const encodedRating = encodeVorbisRating(rating, vorbisScale);
  const ratingValue =
    vorbisScale === "stars"
      ? encodedRating.toFixed(1)
      : vorbisScale === "normalized"
        ? encodedRating.toFixed(2)
        : encodedRating.toString();

  // Create temp file in same directory as source to avoid EXDEV on rename
  const tempPath = join(dirname(filePath), `.${randomUUID()}.flac.tmp`);

  try {
    const processor = new FlacProcessor();
    let existingComments: string[] = [];

    processor.on("preprocess", (mdb) => {
      if (mdb.type === FlacProcessor.MDB_TYPE_VORBIS_COMMENT) {
        // Preserve existing comments except RATING
        const commentData = flacData(mdb);
        existingComments = commentData.comments.filter(
          (c) => !c.toUpperCase().startsWith("RATING="),
        );
        mdb.remove();
      }
    });

    processor.on("postprocess", (mdbList) => {
      // Re-add comments with new RATING
      const comments = [...existingComments, `RATING=${ratingValue}`];
      mdbList.push({
        type: FlacProcessor.MDB_TYPE_VORBIS_COMMENT,
        vendor: "rfmedia-cli",
        comments,
      });
    });

    await pipeline(createReadStream(filePath), processor, createWriteStream(tempPath));

    // Atomic replace
    await rename(tempPath, filePath);

    logDebug(`Wrote Vorbis RATING=${ratingValue} to ${filePath}`);
    return { success: true, message: "Rating written", format: "flac" };
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message, format: "flac" };
  }
}
