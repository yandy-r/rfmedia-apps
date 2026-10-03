/**
 * Filesystem utilities for rfmedia CLI.
 *
 * Provides hardlink detection, copy/link operations, directory management,
 * and error handling with retry support for transient errors.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fse from "fs-extra";
import trash from "trash";

import { logDebug } from "./logger.js";
import type { CopyMethod } from "../types/results.js";
import {
  calculateHash as calculatePathHash,
  compareFileBytes as comparePathBytes,
  FileChangedDuringReadError,
} from "./integrity.js";
import type { ByteCompareResult } from "./integrity.js";
import type { VerificationDependencies, VerificationStat } from "./tiered-verification.js";

/**
 * Error codes that can be retried (transient errors).
 */
const RETRYABLE_ERROR_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY"]);
const FILE_HANDLE_READ_CHUNK_SIZE = 64 * 1024;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const READ_ONLY_NOFOLLOW_FLAGS = constants.O_RDONLY | NOFOLLOW_FLAG;

/**
 * Mode the replacement stage is CREATED with, so a half-built artifact is
 * unobservable to other users. This is a transient window, not a published
 * mode — see `publishMode` / `preserveDestinationMode` and the relaxing
 * `chmod` at the last pre-rename point. Deliberately NOT secure-store's
 * PRIVATE_FILE_MODE, which names a permanent property of a credential
 * document.
 *
 * The floor is ENFORCED by an `fchmod` on the stage handle, not established by
 * the `open` mode argument — `open(2)` masks its mode with the process umask,
 * so the argument alone is a request, not a guarantee.
 */
const STAGE_PRIVATE_MODE = 0o600;

/**
 * Custom error interface for filesystem operations.
 */
interface FileOperationError extends Error {
  code?: string;
  path?: string;
  syscall?: string;
}

/**
 * Wraps an operation with retry logic for transient errors.
 *
 * @param operation - The async operation to execute
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param delayMs - Initial delay between retries in ms (default: 100)
 * @returns The result of the operation
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delayMs = 100,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const error = err as FileOperationError;

      // Only retry if the error is retryable and we have attempts left
      if (!RETRYABLE_ERROR_CODES.has(error.code ?? "") || attempt === maxRetries - 1) {
        throw error;
      }

      logDebug(
        `Retrying operation after ${error.code} error (attempt ${attempt + 1}/${maxRetries})`,
      );

      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error("Unreachable: withRetry exhausted all attempts");
}

/**
 * Regex for invalid filesystem characters.
 * Includes: < > : " / \ | ? * and control characters (0x00-0x1F)
 */
const INVALID_FS_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/**
 * Reserved Windows filenames that cannot be used.
 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Sanitizes a string for use as a filesystem name (file or folder).
 *
 * This function handles:
 * - Invalid filesystem characters (< > : " / \ | ? *) replaced with dash
 * - Control characters (0x00-0x1F) removed
 * - Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) prefixed with underscore
 * - Unicode and emojis are preserved (valid on modern filesystems)
 * - Collapses multiple consecutive dashes
 * - Trims leading/trailing whitespace and dashes
 *
 * @param name - The name to sanitize
 * @returns A filesystem-safe version of the name
 * @throws Error if the name cannot be sanitized to a valid result
 *
 * @example
 * sanitizeForFilesystem('Teen Pop');           // 'Teen Pop'
 * sanitizeForFilesystem('❤️ Tracks');          // '❤️ Tracks'
 * sanitizeForFilesystem('File: Test');         // 'File- Test'
 * sanitizeForFilesystem('CON');                // '_CON'
 * sanitizeForFilesystem('path/to/file');       // 'path-to-file'
 */
export function sanitizeForFilesystem(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("Name is required and must be a non-empty string");
  }

  let sanitized = name
    // Replace invalid filesystem characters with dash
    .replace(INVALID_FS_CHARS, "-")
    // Collapse multiple consecutive dashes into single dash
    .replace(/-+/g, "-")
    // Collapse multiple consecutive spaces into single space
    .replace(/\s+/g, " ")
    // Trim whitespace from both ends
    .trim()
    // Remove leading/trailing dashes
    .replace(/^-+|-+$/g, "");

  // Handle Windows reserved names by prefixing with underscore
  if (WINDOWS_RESERVED_NAMES.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Validate the result
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`Cannot create valid folder name from: "${name}"`);
  }

  return sanitized;
}

/**
 * Checks if a hardlink can be created between source and destination.
 * Hardlinks require both paths to be on the same filesystem (same device).
 *
 * GOTCHA: If destDir doesn't exist, walks up to the nearest existing
 * parent directory to check the filesystem device ID.
 *
 * @param source - Path to the source file
 * @param destDir - Directory where the hardlink would be created
 * @returns true if hardlink is possible, false otherwise
 */
export async function canHardlink(source: string, destDir: string): Promise<boolean> {
  try {
    const sourceStat = await stat(source);

    // Find the nearest existing parent directory for destination
    let checkPath = destDir;
    let destStat: Awaited<ReturnType<typeof stat>> | null = null;

    while (checkPath !== "/" && checkPath !== ".") {
      try {
        destStat = await stat(checkPath);
        break;
      } catch (err) {
        const error = err as FileOperationError;
        if (error.code !== "ENOENT") {
          throw error;
        }
        // Directory doesn't exist, try parent
        checkPath = dirname(checkPath);
      }
    }

    // If we couldn't find any existing parent, try root
    if (destStat === null) {
      destStat = await stat("/");
    }

    const sameDevice = sourceStat.dev === destStat.dev;
    logDebug(
      `canHardlink: source.dev=${sourceStat.dev}, dest.dev=${destStat.dev}, same=${sameDevice}`,
    );

    return sameDevice;
  } catch (err) {
    const error = err as FileOperationError;
    logDebug(`canHardlink check failed: ${error.code} - ${error.message}`);
    return false;
  }
}

/**
 * Creates an actionable error message for filesystem errors.
 *
 * @param error - The filesystem error
 * @param context - Description of what operation was being attempted
 * @returns A user-friendly error message
 */
function createActionableMessage(error: FileOperationError, context: string): string {
  switch (error.code) {
    case "ENOENT":
      return `Path not found: ${error.path ?? "unknown"} (${context})`;
    case "EACCES":
      return `Permission denied: ${error.path ?? "unknown"}. Check file permissions. (${context})`;
    case "EXDEV":
      return `Cannot create hardlink across filesystems: ${error.path ?? "unknown"}. Source and destination must be on the same filesystem. (${context})`;
    case "EMFILE":
      return `Too many open files. Consider increasing ulimit or processing files in smaller batches. (${context})`;
    case "ENOSPC":
      return `Disk full: ${error.path ?? "unknown"}. Free up disk space and try again. (${context})`;
    case "EEXIST":
      return `File already exists: ${error.path ?? "unknown"}. Use --force to overwrite. (${context})`;
    case "EBUSY":
      return `Resource busy: ${error.path ?? "unknown"}. The file may be in use by another process. (${context})`;
    default:
      return `Filesystem error [${error.code ?? "UNKNOWN"}]: ${error.message} (${context})`;
  }
}

/**
 * Wraps a filesystem error with actionable context while retaining its
 * classification and original cause.
 */
function createActionableError(error: FileOperationError, context: string): FileOperationError {
  const actionableError = new Error(createActionableMessage(error, context), {
    cause: error,
  }) as FileOperationError;
  actionableError.name = error.name;
  actionableError.code = error.code;
  actionableError.path = error.path;
  actionableError.syscall = error.syscall;
  return actionableError;
}

interface OpenFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly atimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function snapshotOpenFile(stats: BigIntStats): OpenFileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    atimeNs: stats.atimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameOpenFileSnapshot(left: OpenFileSnapshot, right: OpenFileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertOpenRegularFile(stats: BigIntStats, filePath: string): void {
  if (!stats.isFile()) {
    throw new TypeError(`File-handle operation requires a regular file: ${filePath}`);
  }
}

async function requestedOpenFileSnapshot(filePath: string): Promise<OpenFileSnapshot> {
  const stats = await lstat(filePath, { bigint: true });
  if (stats.isSymbolicLink()) {
    throw new TypeError(`File-handle operation rejects symbolic links: ${filePath}`);
  }
  assertOpenRegularFile(stats, filePath);
  return snapshotOpenFile(stats);
}

async function openStableReadHandle(
  filePath: string,
): Promise<{ readonly handle: FileHandle; readonly snapshot: OpenFileSnapshot }> {
  const requestedBefore = await requestedOpenFileSnapshot(filePath);
  const handle = await open(filePath, READ_ONLY_NOFOLLOW_FLAGS);
  try {
    const handleStats = await handle.stat({ bigint: true });
    assertOpenRegularFile(handleStats, filePath);
    const handleSnapshot = snapshotOpenFile(handleStats);
    const requestedAfter = await requestedOpenFileSnapshot(filePath);
    if (
      !sameOpenFileSnapshot(requestedBefore, requestedAfter) ||
      !sameOpenFileSnapshot(requestedAfter, handleSnapshot)
    ) {
      throw new FileChangedDuringReadError(filePath);
    }
    return { handle, snapshot: handleSnapshot };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readOpenFileChunk(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  signal?: AbortSignal,
): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

async function writeOpenFileChunk(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
  signal?: AbortSignal,
): Promise<void> {
  let written = 0;
  while (written < length) {
    signal?.throwIfAborted();
    const result = await handle.write(buffer, written, length - written, position + written);
    if (result.bytesWritten === 0) {
      throw new Error("File-handle write made no progress");
    }
    written += result.bytesWritten;
  }
  signal?.throwIfAborted();
}

async function assertStableReadHandle(
  filePath: string,
  handle: FileHandle,
  before: OpenFileSnapshot,
): Promise<void> {
  const [handleAfter, requestedAfter] = await Promise.all([
    handle.stat({ bigint: true }).then(snapshotOpenFile),
    requestedOpenFileSnapshot(filePath),
  ]);
  if (
    !sameOpenFileSnapshot(before, handleAfter) ||
    !sameOpenFileSnapshot(handleAfter, requestedAfter)
  ) {
    throw new FileChangedDuringReadError(filePath);
  }
}

async function copyFileToOpenHandle(
  source: string,
  destination: FileHandle,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const sourceFile = await openStableReadHandle(source);
  try {
    const destinationStats = await destination.stat({ bigint: true });
    assertOpenRegularFile(destinationStats, `file descriptor ${destination.fd}`);
    const destinationIdentity = {
      dev: destinationStats.dev,
      ino: destinationStats.ino,
    };
    await destination.truncate(0);
    const buffer = Buffer.allocUnsafe(FILE_HANDLE_READ_CHUNK_SIZE);
    let position = 0;
    while (true) {
      const bytesRead = await readOpenFileChunk(sourceFile.handle, buffer, position, signal);
      if (bytesRead === 0) break;
      await writeOpenFileChunk(destination, buffer, bytesRead, position, signal);
      position += bytesRead;
    }
    await assertStableReadHandle(source, sourceFile.handle, sourceFile.snapshot);
    const destinationAfter = await destination.stat({ bigint: true });
    if (
      !destinationAfter.isFile() ||
      destinationAfter.dev !== destinationIdentity.dev ||
      destinationAfter.ino !== destinationIdentity.ino
    ) {
      throw new Error("Authoritative destination file handle changed during copy");
    }
    await destination.utimes(
      Number(sourceFile.snapshot.atimeNs) / 1_000_000_000,
      Number(sourceFile.snapshot.mtimeNs) / 1_000_000_000,
    );
  } finally {
    await sourceFile.handle.close();
  }
}

async function hashOpenFileHandle(
  handle: FileHandle,
  descriptorPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const beforeStats = await handle.stat({ bigint: true });
  assertOpenRegularFile(beforeStats, descriptorPath);
  const before = snapshotOpenFile(beforeStats);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(FILE_HANDLE_READ_CHUNK_SIZE);
  let position = 0;
  while (true) {
    const bytesRead = await readOpenFileChunk(handle, buffer, position, signal);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  signal?.throwIfAborted();
  const after = snapshotOpenFile(await handle.stat({ bigint: true }));
  if (!sameOpenFileSnapshot(before, after)) {
    throw new FileChangedDuringReadError(descriptorPath);
  }
  return hash.digest("hex");
}

async function comparePathToOpenFileHandle(
  sourcePath: string,
  destination: FileHandle,
  descriptorPath: string,
  signal?: AbortSignal,
): Promise<ByteCompareResult> {
  signal?.throwIfAborted();
  const source = await openStableReadHandle(sourcePath);
  try {
    const destinationStats = await destination.stat({ bigint: true });
    assertOpenRegularFile(destinationStats, descriptorPath);
    const destinationBefore = snapshotOpenFile(destinationStats);
    const sameInode =
      source.snapshot.dev === destinationBefore.dev &&
      source.snapshot.ino === destinationBefore.ino;
    let bytesCompared = 0;
    let status: "match" | "mismatch" = "match";

    if (!sameInode) {
      const sourceBuffer = Buffer.allocUnsafe(FILE_HANDLE_READ_CHUNK_SIZE);
      const destinationBuffer = Buffer.allocUnsafe(FILE_HANDLE_READ_CHUNK_SIZE);
      let position = 0;
      while (true) {
        const sourceBytes = await readOpenFileChunk(source.handle, sourceBuffer, position, signal);
        const destinationBytes = await readOpenFileChunk(
          destination,
          destinationBuffer,
          position,
          signal,
        );
        const comparableBytes = Math.min(sourceBytes, destinationBytes);
        bytesCompared += comparableBytes;
        if (
          sourceBytes !== destinationBytes ||
          !sourceBuffer
            .subarray(0, comparableBytes)
            .equals(destinationBuffer.subarray(0, comparableBytes))
        ) {
          status = "mismatch";
          break;
        }
        if (sourceBytes === 0) break;
        position += sourceBytes;
      }
    }

    signal?.throwIfAborted();
    const [sourceAfter, sourceRequestedAfter, destinationAfter] = await Promise.all([
      source.handle.stat({ bigint: true }).then(snapshotOpenFile),
      requestedOpenFileSnapshot(sourcePath),
      destination.stat({ bigint: true }).then(snapshotOpenFile),
    ]);
    if (
      !sameOpenFileSnapshot(source.snapshot, sourceAfter) ||
      !sameOpenFileSnapshot(sourceAfter, sourceRequestedAfter) ||
      !sameOpenFileSnapshot(destinationBefore, destinationAfter)
    ) {
      return { status: "unstable", sameInode, bytesCompared };
    }
    return { status, sameInode, bytesCompared };
  } finally {
    await source.handle.close();
  }
}

/**
 * Returns the child-process descriptor path for an already-open file.
 *
 * Consumers must keep the FileHandle open for the complete use of this path.
 * Unsupported platforms fail closed instead of falling back to a pathname.
 */
export function getOpenFileDescriptorPath(handle: FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform === "darwin") return `/dev/fd/${handle.fd}`;
  throw new Error("Secure descriptor-backed file access is not supported on this platform");
}

/**
 * Creates tiered-verification dependencies bound to an authoritative open file.
 *
 * Every operation targeting `path` uses the supplied handle directly, so a
 * concurrent replacement of the staged pathname cannot redirect validation.
 */
export function createOpenFileVerificationTarget(handle: FileHandle): {
  readonly path: string;
  readonly dependencies: VerificationDependencies;
} {
  const descriptorPath = getOpenFileDescriptorPath(handle);
  const dependencies: VerificationDependencies = {
    async statFile(filePath: string): Promise<VerificationStat> {
      if (filePath !== descriptorPath) {
        const result = await lstat(filePath);
        return { size: result.size, mtimeMs: result.mtimeMs, isFile: result.isFile() };
      }
      const result = await handle.stat();
      return { size: result.size, mtimeMs: result.mtimeMs, isFile: result.isFile() };
    },
    async calculateHash(filePath: string, signal?: AbortSignal): Promise<string> {
      return filePath === descriptorPath
        ? hashOpenFileHandle(handle, descriptorPath, signal)
        : calculatePathHash(filePath, signal);
    },
    async compareFileBytes(
      sourcePath: string,
      destinationPath: string,
      signal?: AbortSignal,
    ): Promise<ByteCompareResult> {
      return destinationPath === descriptorPath
        ? comparePathToOpenFileHandle(sourcePath, handle, descriptorPath, signal)
        : comparePathBytes(sourcePath, destinationPath, signal);
    },
  };
  return { path: descriptorPath, dependencies };
}

/**
 * Copies a file or creates a hardlink.
 *
 * GOTCHA: Ensures parent directory exists before fs.link() as it requires
 * the target directory to exist.
 *
 * @param source - Path to the source file
 * @param dest - Path or authoritative open handle for the destination file
 * @param useHardlink - If true, attempt a path-based hardlink; handles support copying only
 * @param signal - Optional AbortSignal for cancellation
 * @returns 'hardlink' if a hardlink was created, 'copy' if file was copied
 * @throws Error if the operation fails or is aborted
 */
export async function copyOrLink(
  source: string,
  dest: string | FileHandle,
  useHardlink: boolean,
  signal?: AbortSignal,
): Promise<CopyMethod> {
  // Check if aborted before starting
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  if (typeof dest !== "string") {
    if (useHardlink) {
      throw new Error("Cannot create a hardlink through an already-open destination handle");
    }
    try {
      await copyFileToOpenHandle(source, dest, signal);
      logDebug(`Copied ${source} through authoritative file descriptor ${dest.fd}`);
      return "copy";
    } catch (err) {
      throw createActionableError(
        err as FileOperationError,
        `copy ${source} through an authoritative file descriptor`,
      );
    }
  }

  // Ensure parent directory exists before any operation
  const parentDir = dirname(dest);
  await ensureDir(parentDir);

  if (useHardlink) {
    try {
      // Check if aborted before hardlink attempt
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Check if hardlink is possible (same filesystem)
      const canLink = await canHardlink(source, parentDir);
      if (canLink) {
        await withRetry(async () => {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          await link(source, dest);
        });
        logDebug(`Created hardlink: ${source} -> ${dest}`);
        return "hardlink";
      }
      logDebug(`Cannot hardlink (different filesystem), falling back to copy: ${source}`);
    } catch (err) {
      const error = err as FileOperationError;
      // EXDEV means cross-device link - not retryable, just fall through to copy
      if (error.code !== "EXDEV") {
        throw new Error(createActionableMessage(error, `hardlink ${source} to ${dest}`));
      }
      logDebug(`Hardlink failed with EXDEV, using copy: ${source}`);
    }
  }

  // Check if aborted before copy
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  // Copy the file
  try {
    await withRetry(async () => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      await fse.copy(source, dest, { preserveTimestamps: true });
    });
    logDebug(`Copied: ${source} -> ${dest}`);
    return "copy";
  } catch (err) {
    const error = err as FileOperationError;
    throw new Error(createActionableMessage(error, `copy ${source} to ${dest}`));
  }
}

/**
 * Copies a file or creates a hardlink and returns the SHA-256 content hash.
 *
 * Plain copies hash the source stream while writing the destination, avoiding
 * a second full-file read. Hardlinks hash after link creation because no copy
 * stream exists.
 *
 * @param source - Path to the source file
 * @param dest - Path where the file should be copied or linked
 * @param useHardlink - Whether to attempt creating a hardlink before copying
 * @param signal - Optional abort signal for cancelling the operation
 * @returns The copy method, SHA-256 content hash, mtime, and size of the source file
 * @throws Error when the operation is aborted, the source cannot be read, or the destination cannot be written
 */
export async function copyOrLinkWithHash(
  source: string,
  dest: string,
  useHardlink: boolean,
  signal?: AbortSignal,
): Promise<{ method: CopyMethod; contentHash: string; mtime: number; size: number }> {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const destinationExisted = await pathExists(dest);
  const parentDir = dirname(dest);
  await ensureDir(parentDir);
  const sourceStat = await stat(source);

  if (useHardlink) {
    try {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const canLink = await canHardlink(source, parentDir);
      if (canLink) {
        await withRetry(async () => {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          await link(source, dest);
        });
        logDebug(`Created hardlink: ${source} -> ${dest}`);
        return {
          method: "hardlink",
          contentHash: await hashFile(dest, signal),
          mtime: sourceStat.mtimeMs,
          size: sourceStat.size,
        };
      }
      logDebug(`Cannot hardlink (different filesystem), falling back to copy: ${source}`);
    } catch (err) {
      const error = err as FileOperationError;
      if (error.code !== "EXDEV") {
        if (!destinationExisted) {
          await cleanupPartialFile(dest);
        }
        throw createActionableError(error, `hardlink ${source} to ${dest}`);
      }
      logDebug(`Hardlink failed with EXDEV, using copy: ${source}`);
    }
  }

  try {
    const contentHash = await withRetry(async () => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const hash = createHash("sha256");
      const hashTransform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(createReadStream(source), hashTransform, createWriteStream(dest), { signal });
      return hash.digest("hex");
    });
    await utimes(dest, sourceStat.atime, sourceStat.mtime);
    logDebug(`Copied: ${source} -> ${dest}`);
    return {
      method: "copy",
      contentHash,
      mtime: sourceStat.mtimeMs,
      size: sourceStat.size,
    };
  } catch (err) {
    const error = err as FileOperationError;
    if (!destinationExisted) {
      await cleanupPartialFile(dest);
    }
    throw createActionableError(error, `copy ${source} to ${dest}`);
  }
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(filePath);
  await pipeline(input, hash, { signal });
  return hash.digest("hex");
}

/**
 * Cleans up a partial file that was being copied when operation was interrupted.
 * Attempts to remove the file and logs a warning if removal fails.
 *
 * @param dest - Path to the partial file to clean up
 */
export async function cleanupPartialFile(dest: string): Promise<void> {
  try {
    const exists = await pathExists(dest);
    if (exists) {
      await fse.remove(dest);
      logDebug(`Cleaned up partial file: ${dest}`);
    }
  } catch (err) {
    const error = err as FileOperationError;
    // Log but don't throw - cleanup is best-effort
    logDebug(`Warning: Failed to cleanup partial file ${dest}: ${error.message}`);
  }
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Callbacks used to materialize and validate a private staged replacement.
 */
export interface ValidatedStageOptions {
  signal?: AbortSignal;
  /** Optional ordinary permission bits to apply immediately before publication. */
  publishMode?: number;
  /**
   * Preserve an existing destination's mode from the same snapshot used for
   * destination identity checks.
   */
  preserveDestinationMode?: boolean;
  /** Mode used when preserveDestinationMode is enabled and no destination exists. */
  missingDestinationMode?: number;
  /** Reject a destination that aliases this filesystem object at the stage boundary. */
  forbidDestinationIdentity?: FileIdentity;
  materialize: (stagedPath: string, signal: AbortSignal, stagedHandle: FileHandle) => Promise<void>;
  validate: (stagedPath: string, signal: AbortSignal, stagedHandle: FileHandle) => Promise<void>;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isContainedPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

interface DestinationSnapshot extends FileIdentity {
  mode: number;
}

async function readDestinationSnapshot(
  destinationPath: string,
): Promise<DestinationSnapshot | null> {
  try {
    const destinationStat = await lstat(destinationPath);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error(`Destination is not a regular file: ${destinationPath}`);
    }
    return {
      dev: destinationStat.dev,
      ino: destinationStat.ino,
      mode: destinationStat.mode & 0o777,
    };
  } catch (err) {
    const error = err as FileOperationError;
    if (error.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function validatedPublishMode(mode: number, optionName: string): number {
  if (!Number.isFinite(mode) || !Number.isInteger(mode) || mode < 0) {
    throw new RangeError(`${optionName} must be a finite nonnegative integer`);
  }
  return mode & 0o777;
}

function resolvePublishMode(
  options: ValidatedStageOptions,
  destinationSnapshot: DestinationSnapshot | null,
): number | undefined {
  if (options.publishMode !== undefined && options.preserveDestinationMode === true) {
    throw new RangeError("publishMode and preserveDestinationMode cannot be combined");
  }
  if (options.missingDestinationMode !== undefined && options.preserveDestinationMode !== true) {
    throw new RangeError("missingDestinationMode requires preserveDestinationMode");
  }
  if (options.publishMode !== undefined) {
    return validatedPublishMode(options.publishMode, "publishMode");
  }
  if (options.preserveDestinationMode !== true) {
    return undefined;
  }
  if (options.missingDestinationMode === undefined) {
    throw new RangeError("missingDestinationMode is required when preserving destination mode");
  }
  const missingDestinationMode = validatedPublishMode(
    options.missingDestinationMode,
    "missingDestinationMode",
  );
  return destinationSnapshot?.mode ?? missingDestinationMode;
}

async function unlinkStagedFile(stagedPath: string): Promise<void> {
  try {
    await unlink(stagedPath);
  } catch (err) {
    const error = err as FileOperationError;
    if (error.code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Materializes and validates a private sibling file before atomically replacing
 * the requested destination. The authoritative stage handle stays open through
 * validation and publication checks. Group- or world-writable parents are
 * rejected because pathname publication cannot otherwise be identity-bound
 * against an actor that may replace directory entries between the last check
 * and rename. The original destination is untouched until the final rename,
 * and the staged file is unlinked on every pre-commit failure.
 */
export async function replaceFileWithValidatedStage(
  destinationPath: string,
  options: ValidatedStageOptions,
): Promise<void> {
  const requestedDestination = resolve(destinationPath);
  const requestedParent = dirname(requestedDestination);
  const resolvedParent = await realpath(requestedParent);
  const resolvedDestination = join(resolvedParent, basename(requestedDestination));
  const signal = options.signal ?? new AbortController().signal;

  if (!isContainedPath(resolvedParent, resolvedDestination)) {
    throw new Error(`Destination escapes its parent directory: ${destinationPath}`);
  }

  const parentStat = await stat(resolvedParent);
  if (!parentStat.isDirectory()) {
    throw new Error(`Destination parent is not a directory: ${requestedParent}`);
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error(
      `Destination parent is group- or world-writable and cannot safely publish a validated stage: ${resolvedParent}`,
    );
  }

  const parentIdentity: FileIdentity = { dev: parentStat.dev, ino: parentStat.ino };
  const destinationSnapshot = await readDestinationSnapshot(resolvedDestination);
  if (
    destinationSnapshot !== null &&
    options.forbidDestinationIdentity !== undefined &&
    sameFileIdentity(destinationSnapshot, options.forbidDestinationIdentity)
  ) {
    throw new Error(`Destination aliases the protected source file: ${resolvedDestination}`);
  }
  const publishMode = resolvePublishMode(options, destinationSnapshot);
  const stagedPath = join(
    resolvedParent,
    `.${basename(resolvedDestination)}.rfmedia-stage-${randomUUID()}.tmp`,
  );
  let staged = false;
  let committed = false;

  try {
    signal.throwIfAborted();

    const stagedHandle = await open(stagedPath, "wx+", STAGE_PRIVATE_MODE);
    staged = true;
    try {
      // MANDATORY: open(2) masks its mode argument with the process umask, so a
      // restrictive umask (0277) would otherwise leave this stage at 0o400 — and
      // on the no-publish-mode path that is exactly what `rename` publishes.
      // fchmod on the held descriptor is not umask-masked and cannot be
      // redirected by a pathname swap; never weaken this to a path chmod.
      await stagedHandle.chmod(STAGE_PRIVATE_MODE);
      const stagedStat = await stagedHandle.stat();
      const stagedIdentity: FileIdentity = { dev: stagedStat.dev, ino: stagedStat.ino };
      await options.materialize(stagedPath, signal, stagedHandle);
      signal.throwIfAborted();

      const materializedStat = await stagedHandle.stat();
      if (
        !materializedStat.isFile() ||
        !sameFileIdentity(stagedIdentity, {
          dev: materializedStat.dev,
          ino: materializedStat.ino,
        })
      ) {
        throw new Error(`Staged artifact changed during materialization: ${stagedPath}`);
      }
      await stagedHandle.sync();
      await options.validate(stagedPath, signal, stagedHandle);
      signal.throwIfAborted();

      const validatedStat = await stagedHandle.stat();
      if (
        !validatedStat.isFile() ||
        !sameFileIdentity(stagedIdentity, {
          dev: validatedStat.dev,
          ino: validatedStat.ino,
        })
      ) {
        throw new Error(`Staged artifact changed during validation: ${stagedPath}`);
      }
      await stagedHandle.sync();

      const currentParent = await realpath(requestedParent);
      const currentParentStat = await stat(currentParent);
      if (
        currentParent !== resolvedParent ||
        !currentParentStat.isDirectory() ||
        !sameFileIdentity(parentIdentity, {
          dev: currentParentStat.dev,
          ino: currentParentStat.ino,
        })
      ) {
        throw new Error(`Destination parent changed before commit: ${requestedParent}`);
      }

      const currentStagedPath = await realpath(stagedPath);
      const currentStagedStat = await lstat(stagedPath);
      if (
        currentStagedPath !== stagedPath ||
        !isContainedPath(resolvedParent, currentStagedPath) ||
        !currentStagedStat.isFile() ||
        currentStagedStat.isSymbolicLink() ||
        !sameFileIdentity(stagedIdentity, {
          dev: currentStagedStat.dev,
          ino: currentStagedStat.ino,
        })
      ) {
        throw new Error(`Staged artifact changed before commit: ${stagedPath}`);
      }

      const currentDestinationSnapshot = await readDestinationSnapshot(resolvedDestination);
      if (
        (destinationSnapshot === null && currentDestinationSnapshot !== null) ||
        (destinationSnapshot !== null &&
          (currentDestinationSnapshot === null ||
            !sameFileIdentity(destinationSnapshot, currentDestinationSnapshot)))
      ) {
        throw new Error(`Destination changed before commit: ${resolvedDestination}`);
      }

      if (publishMode !== undefined) {
        const publishStat = await stagedHandle.stat();
        if (
          !publishStat.isFile() ||
          !sameFileIdentity(stagedIdentity, {
            dev: publishStat.dev,
            ino: publishStat.ino,
          })
        ) {
          throw new Error(`Staged artifact changed before mode application: ${stagedPath}`);
        }
        await stagedHandle.chmod(publishMode);
        await stagedHandle.sync();

        signal.throwIfAborted();
        const modeAppliedStat = await lstat(stagedPath);
        if (
          !modeAppliedStat.isFile() ||
          modeAppliedStat.isSymbolicLink() ||
          !sameFileIdentity(stagedIdentity, {
            dev: modeAppliedStat.dev,
            ino: modeAppliedStat.ino,
          })
        ) {
          throw new Error(`Staged artifact changed after mode application: ${stagedPath}`);
        }

        const modeAppliedDestinationSnapshot = await readDestinationSnapshot(resolvedDestination);
        if (
          (destinationSnapshot === null && modeAppliedDestinationSnapshot !== null) ||
          (destinationSnapshot !== null &&
            (modeAppliedDestinationSnapshot === null ||
              !sameFileIdentity(destinationSnapshot, modeAppliedDestinationSnapshot)))
        ) {
          throw new Error(`Destination changed before commit: ${resolvedDestination}`);
        }
      }

      signal.throwIfAborted();
      await rename(stagedPath, resolvedDestination);
      committed = true;
    } finally {
      await stagedHandle.close();
    }
  } finally {
    if (staged && !committed) {
      await unlinkStagedFile(stagedPath);
    }
  }
}

/**
 * Copies an entire directory to a destination.
 *
 * @param source - Path to the source directory
 * @param dest - Path for the destination directory
 * @param options - Copy options
 * @param options.hardlink - If true, create hardlinks for files; otherwise, copy
 * @throws Error if the operation fails
 */
export async function copyDirectory(
  source: string,
  dest: string,
  options: { hardlink: boolean },
): Promise<void> {
  const { hardlink } = options;

  // Ensure destination directory exists
  await ensureDir(dest);

  // Read source directory contents
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (err) {
    const error = err as FileOperationError;
    throw new Error(createActionableMessage(error, `read directory ${source}`));
  }

  // Process each entry
  for (const entry of entries) {
    const sourcePath = `${source}/${entry.name}`;
    const destPath = `${dest}/${entry.name}`;

    if (entry.isDirectory()) {
      // Recursively copy subdirectory
      await copyDirectory(sourcePath, destPath, options);
    } else if (entry.isFile()) {
      // Copy or link file
      await copyOrLink(sourcePath, destPath, hardlink);
    }
    // Skip symlinks and other special files
  }

  logDebug(`Copied directory: ${source} -> ${dest}`);
}

/**
 * Ensures a directory exists, creating it if necessary.
 * Wrapper around fs-extra's ensureDir for consistency.
 *
 * @param path - Directory path to ensure exists
 * @throws Error if directory cannot be created
 */
export async function ensureDir(path: string): Promise<void> {
  try {
    await fse.ensureDir(path);
  } catch (err) {
    const error = err as FileOperationError;
    throw new Error(createActionableMessage(error, `create directory ${path}`));
  }
}

/**
 * Checks if a path exists (file or directory).
 *
 * @param path - Path to check
 * @returns true if the path exists, false otherwise
 */
export async function pathExists(path: string): Promise<boolean> {
  return await fse.pathExists(path);
}

/**
 * Normalizes a path by removing trailing slashes and resolving symlinks.
 *
 * @param path - Path to normalize
 * @returns Normalized path without trailing slashes, with symlinks resolved
 */
export function normalizePath(inputPath: string): string {
  // Remove trailing slashes (but keep root '/')
  let normalized = inputPath;

  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Normalizes a path and resolves symlinks asynchronously.
 * Use this when you need to resolve symlinks as well as normalize.
 *
 * @param path - Path to normalize and resolve
 * @returns Normalized path with symlinks resolved
 * @throws Error if path doesn't exist or can't be resolved
 */
export async function normalizePathResolved(inputPath: string): Promise<string> {
  // First normalize trailing slashes
  const normalized = normalizePath(inputPath);

  try {
    // Resolve symlinks
    const resolved = await realpath(normalized);
    return resolved;
  } catch (err) {
    const error = err as FileOperationError;
    // If the path doesn't exist, return the normalized version
    if (error.code === "ENOENT") {
      return normalized;
    }
    throw new Error(createActionableMessage(error, `resolve path ${inputPath}`));
  }
}

/**
 * Removes a file or directory.
 *
 * @param path - Path to remove
 * @throws Error if removal fails
 */
export async function remove(path: string): Promise<void> {
  try {
    await fse.remove(path);
    logDebug(`Removed: ${path}`);
  } catch (err) {
    const error = err as FileOperationError;
    throw new Error(createActionableMessage(error, `remove ${path}`));
  }
}

/**
 * Moves a file or directory to the system trash/recycle bin.
 *
 * @param path - Path to move to trash
 * @throws Error if operation fails
 */
export async function moveToTrash(path: string): Promise<void> {
  try {
    await trash(path);
    logDebug(`Moved to trash: ${path}`);
  } catch (err) {
    const error = err as FileOperationError;
    throw new Error(createActionableMessage(error, `move to trash ${path}`));
  }
}

/**
 * Gets file/directory stats.
 *
 * @param path - Path to stat
 * @returns Stats object
 * @throws Error if stat fails
 */
export async function getStats(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(path);
  } catch (err) {
    const error = err as FileOperationError;
    throw new Error(createActionableMessage(error, `stat ${path}`));
  }
}

/**
 * Gets file size in bytes.
 *
 * @param filePath - Path to the file
 * @returns File size in bytes
 * @throws Error if file cannot be accessed
 */
export async function getFileSize(filePath: string): Promise<number> {
  const stats = await getStats(filePath);
  // stats.size can be bigint on some systems, convert to number
  return Number(stats.size);
}

/**
 * Directory statistics for progress tracking.
 */
export interface DirectoryStats {
  /** Total number of files */
  fileCount: number;
  /** Total size in bytes */
  totalBytes: number;
}

/**
 * Scans a directory to get total file count and size.
 *
 * @param dirPath - Path to the directory
 * @param filterFn - Optional function to filter files (receives filename, returns true to include)
 * @returns Object with fileCount and totalBytes
 */
export async function scanDirectoryStats(
  dirPath: string,
  filterFn?: (filename: string) => boolean,
): Promise<DirectoryStats> {
  let fileCount = 0;
  let totalBytes = 0;

  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = `${dirPath}/${entry.name}`;

    if (entry.isDirectory()) {
      // Recursively scan subdirectories
      const subStats = await scanDirectoryStats(entryPath, filterFn);
      fileCount += subStats.fileCount;
      totalBytes += subStats.totalBytes;
    } else if (entry.isFile()) {
      // Apply filter if provided
      if (filterFn && !filterFn(entry.name)) {
        continue;
      }

      const stats = await stat(entryPath);
      fileCount++;
      totalBytes += Number(stats.size);
    }
  }

  return { fileCount, totalBytes };
}

/**
 * Gets statistics for a list of files.
 *
 * @param filePaths - Array of file paths
 * @returns Object with fileCount and totalBytes
 */
export async function getFilesStats(filePaths: string[]): Promise<DirectoryStats> {
  let totalBytes = 0;

  for (const filePath of filePaths) {
    try {
      const stats = await stat(filePath);
      totalBytes += Number(stats.size);
    } catch {
      // Skip files that can't be accessed
    }
  }

  return {
    fileCount: filePaths.length,
    totalBytes,
  };
}
