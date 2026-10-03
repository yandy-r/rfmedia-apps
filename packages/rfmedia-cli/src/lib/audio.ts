import path from "node:path";
import type { Readable } from "node:stream";
import fg from "fast-glob";

/**
 * Supported audio file extensions (lowercase).
 * Matches the extensions from cp-music.sh AUDIO_EXTENSIONS.
 */
export const AUDIO_EXTENSIONS = [
  "flac",
  "wav",
  "mp3",
  "ogg",
  "opus",
  "m4a",
  "aac",
  "wma",
  "aiff",
  "ape",
  "wv",
  "alac",
] as const;

export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

/**
 * Set of audio extensions for fast lookup.
 */
const AUDIO_EXTENSION_SET = new Set<string>(AUDIO_EXTENSIONS);

/** Raised when bounded audio discovery observes one candidate beyond its limit. */
export class AudioFileCandidateLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Audio discovery exceeds the ${limit}-file candidate limit.`);
    this.name = "AudioFileCandidateLimitError";
  }
}

/**
 * Checks if a file path has an audio file extension.
 * Performs case-insensitive matching.
 *
 * @param filePath - The file path to check
 * @returns true if the file has an audio extension
 */
export function isAudioFile(filePath: string): boolean {
  const ext = getAudioExtension(filePath);
  return ext !== null;
}

/**
 * Extracts the audio extension from a file path if it has one.
 * Returns the extension in lowercase without the leading dot.
 *
 * @param filePath - The file path to check
 * @returns The lowercase extension without dot, or null if not an audio file
 */
export function getAudioExtension(filePath: string): AudioExtension | null {
  const ext = path.extname(filePath).toLowerCase();
  // Remove leading dot
  const extWithoutDot = ext.slice(1);

  if (AUDIO_EXTENSION_SET.has(extWithoutDot)) {
    return extWithoutDot as AudioExtension;
  }
  return null;
}

/**
 * Finds all audio files in a directory recursively.
 * Uses fast-glob for efficient file discovery.
 *
 * @param dir - The directory to search in
 * @returns Array of absolute paths to audio files
 */
export async function findAudioFiles(dir: string): Promise<string[]> {
  // Build glob patterns for all audio extensions (case-insensitive)
  const patterns = AUDIO_EXTENSIONS.map((ext) => `**/*.${ext}`);

  const files = await fg(patterns, {
    cwd: dir,
    absolute: true,
    caseSensitiveMatch: false,
    onlyFiles: true,
    followSymbolicLinks: true,
  });

  return files;
}

/**
 * Finds all regular audio files in a directory recursively without following
 * symbolic links.
 *
 * Results are sorted by absolute path so reconciliation sees a deterministic
 * candidate order. Root containment and pre-write file validation remain the
 * caller's responsibility. When `maximumFiles` is supplied, discovery streams
 * entries and fails on candidate `maximumFiles + 1` instead of materializing an
 * unbounded result.
 *
 * @param dir - The directory to search in
 * @param maximumFiles - Optional hard candidate limit
 * @returns Deterministically ordered absolute paths to audio files
 */
export async function findAudioFilesNoFollow(
  dir: string,
  maximumFiles?: number,
): Promise<string[]> {
  if (maximumFiles !== undefined && (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1)) {
    throw new Error("Audio discovery maximumFiles must be a positive safe integer.");
  }

  const patterns = AUDIO_EXTENSIONS.map((ext) => `**/*.${ext}`);

  const stream = fg.stream(patterns, {
    cwd: dir,
    absolute: true,
    caseSensitiveMatch: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  }) as Readable;
  const files: string[] = [];

  for await (const entry of stream) {
    if (typeof entry !== "string") {
      throw new Error("Audio discovery returned an unexpected non-string entry.");
    }
    if (maximumFiles !== undefined && files.length === maximumFiles) {
      throw new AudioFileCandidateLimitError(maximumFiles);
    }
    files.push(entry);
  }

  return files.sort();
}

/**
 * Finds audio files directly in a directory (non-recursive).
 * Only checks immediate children, not subdirectories.
 *
 * @param dir - The directory to search in
 * @returns Array of absolute paths to audio files
 */
export async function findAudioFilesInDir(dir: string): Promise<string[]> {
  // Build glob patterns for all audio extensions (case-insensitive)
  // Use *.ext pattern (no **/) for non-recursive search
  const patterns = AUDIO_EXTENSIONS.map((ext) => `*.${ext}`);

  const files = await fg(patterns, {
    cwd: dir,
    absolute: true,
    caseSensitiveMatch: false,
    onlyFiles: true,
    followSymbolicLinks: true,
  });

  return files;
}
