import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { logDebug } from "./logger.js";

const READ_CHUNK_SIZE = 64 * 1024;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const READ_ONLY_NOFOLLOW_FLAGS = constants.O_RDONLY | NOFOLLOW_FLAG;

type IntegrityReadRole = "file" | "source" | "destination";

interface FileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface IntegrityReadEvent {
  readonly operation: "hash" | "compare";
  readonly role: IntegrityReadRole;
  readonly bytesRead: number;
  readonly totalBytesRead: number;
}

interface IntegrityCloseEvent {
  readonly operation: "hash" | "compare";
  readonly role: IntegrityReadRole;
}

/**
 * Internal deterministic seams for real-file tests.
 *
 * This type is exported only from this module and is intentionally absent from
 * the package type barrel and command result contracts.
 *
 * @internal
 */
export interface IntegrityTestHooks {
  readonly maxReadBytes?: number;
  readonly afterRead?: (event: IntegrityReadEvent) => void | Promise<void>;
  readonly afterClose?: (event: IntegrityCloseEvent) => void | Promise<void>;
}

interface ByteCompareEvidence {
  readonly sameInode: boolean;
  readonly bytesCompared: number;
}

export type ByteCompareResult =
  | ({ readonly status: "match" } & ByteCompareEvidence)
  | ({ readonly status: "mismatch" } & ByteCompareEvidence)
  | ({ readonly status: "unstable" } & ByteCompareEvidence);

export class FileChangedDuringReadError extends Error {
  override readonly name = "FileChangedDuringReadError";

  constructor(readonly filePath: string) {
    super(`File changed while it was being read: ${filePath}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function snapshotFile(stats: BigIntStats): FileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function snapshotsMatch(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertRegularFile(stats: BigIntStats, filePath: string): void {
  if (!stats.isFile()) {
    throw new TypeError(`Integrity reads require a regular file: ${filePath}`);
  }
}

function assertRequestedRegularFile(stats: BigIntStats, filePath: string): void {
  if (stats.isSymbolicLink()) {
    throw new TypeError(`Integrity reads reject symbolic links: ${filePath}`);
  }
  assertRegularFile(stats, filePath);
}

async function snapshotRequestedFile(filePath: string): Promise<FileSnapshot> {
  const stats = await lstat(filePath, { bigint: true });
  assertRequestedRegularFile(stats, filePath);
  return snapshotFile(stats);
}

function assertPathBoundToHandle(
  filePath: string,
  requestedBefore: FileSnapshot,
  requestedAfterOpen: FileSnapshot,
  handleBefore: FileSnapshot,
): void {
  if (
    !snapshotsMatch(requestedBefore, requestedAfterOpen) ||
    !snapshotsMatch(requestedAfterOpen, handleBefore)
  ) {
    throw new FileChangedDuringReadError(filePath);
  }
}

function maxReadLength(hooks?: IntegrityTestHooks): number {
  const requested = hooks?.maxReadBytes;
  if (requested === undefined) {
    return READ_CHUNK_SIZE;
  }
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError("maxReadBytes must be a positive safe integer");
  }
  return Math.min(requested, READ_CHUNK_SIZE);
}

async function readFilledChunk(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  operation: "hash" | "compare",
  role: IntegrityReadRole,
  signal?: AbortSignal,
  hooks?: IntegrityTestHooks,
): Promise<number> {
  const readLimit = maxReadLength(hooks);
  let filled = 0;

  while (filled < buffer.length) {
    throwIfAborted(signal);
    const length = Math.min(buffer.length - filled, readLimit);
    const { bytesRead } = await handle.read(buffer, filled, length, position + filled);
    throwIfAborted(signal);

    if (bytesRead === 0) {
      break;
    }

    filled += bytesRead;
    await hooks?.afterRead?.({
      operation,
      role,
      bytesRead,
      totalBytesRead: position + filled,
    });
    throwIfAborted(signal);
  }

  return filled;
}

async function closeHandle(
  handle: FileHandle,
  operation: "hash" | "compare",
  role: IntegrityReadRole,
  hooks?: IntegrityTestHooks,
): Promise<void> {
  await handle.close();
  await hooks?.afterClose?.({ operation, role });
}

/**
 * Calculates the SHA-256 hash of a stable regular file.
 *
 * @param filePath - Path to the file
 * @param signal - Optional cancellation signal checked between bounded reads
 * @param testHooks - Internal deterministic test seams
 * @returns Hex string of the SHA-256 hash
 * @throws FileChangedDuringReadError when the opened file changes during hashing
 */
export async function calculateHash(
  filePath: string,
  signal?: AbortSignal,
  testHooks?: IntegrityTestHooks,
): Promise<string> {
  throwIfAborted(signal);
  const requestedBefore = await snapshotRequestedFile(filePath);
  throwIfAborted(signal);
  const handle = await open(filePath, READ_ONLY_NOFOLLOW_FLAGS);

  try {
    const beforeStats = await handle.stat({ bigint: true });
    assertRegularFile(beforeStats, filePath);
    const before = snapshotFile(beforeStats);
    const requestedAfterOpen = await snapshotRequestedFile(filePath);
    assertPathBoundToHandle(filePath, requestedBefore, requestedAfterOpen, before);
    throwIfAborted(signal);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    let position = 0;

    while (true) {
      const bytesRead = await readFilledChunk(
        handle,
        buffer,
        position,
        "hash",
        "file",
        signal,
        testHooks,
      );
      if (bytesRead === 0) {
        break;
      }

      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    throwIfAborted(signal);
    const [after, requestedAfterRead] = await Promise.all([
      handle.stat({ bigint: true }).then(snapshotFile),
      snapshotRequestedFile(filePath),
    ]);
    if (!snapshotsMatch(before, after) || !snapshotsMatch(after, requestedAfterRead)) {
      throw new FileChangedDuringReadError(filePath);
    }

    return hash.digest("hex");
  } finally {
    await closeHandle(handle, "hash", "file", testHooks);
  }
}

/**
 * Compares two stable regular files with fixed-size buffers.
 *
 * The result contains only comparison evidence, never file digests. Same-inode
 * inputs are identified without a redundant byte read so the caller can mark
 * that comparison as not applicable independent evidence.
 */
export async function compareFileBytes(
  sourcePath: string,
  destinationPath: string,
  signal?: AbortSignal,
  testHooks?: IntegrityTestHooks,
): Promise<ByteCompareResult> {
  throwIfAborted(signal);
  const [sourceRequestedBefore, destinationRequestedBefore] = await Promise.all([
    snapshotRequestedFile(sourcePath),
    snapshotRequestedFile(destinationPath),
  ]);
  throwIfAborted(signal);
  const sourceHandle = await open(sourcePath, READ_ONLY_NOFOLLOW_FLAGS);
  let destinationHandle: FileHandle | undefined;

  try {
    destinationHandle = await open(destinationPath, READ_ONLY_NOFOLLOW_FLAGS);
    const [
      sourceBeforeStats,
      destinationBeforeStats,
      sourceRequestedAfterOpen,
      destinationRequestedAfterOpen,
    ] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      destinationHandle.stat({ bigint: true }),
      snapshotRequestedFile(sourcePath),
      snapshotRequestedFile(destinationPath),
    ]);
    assertRegularFile(sourceBeforeStats, sourcePath);
    assertRegularFile(destinationBeforeStats, destinationPath);
    const sourceBefore = snapshotFile(sourceBeforeStats);
    const destinationBefore = snapshotFile(destinationBeforeStats);
    assertPathBoundToHandle(
      sourcePath,
      sourceRequestedBefore,
      sourceRequestedAfterOpen,
      sourceBefore,
    );
    assertPathBoundToHandle(
      destinationPath,
      destinationRequestedBefore,
      destinationRequestedAfterOpen,
      destinationBefore,
    );
    throwIfAborted(signal);
    const sameInode =
      sourceBefore.dev === destinationBefore.dev && sourceBefore.ino === destinationBefore.ino;
    let bytesCompared = 0;
    let status: "match" | "mismatch" = "match";

    if (!sameInode) {
      const sourceBuffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
      const destinationBuffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
      let position = 0;

      while (true) {
        const sourceBytes = await readFilledChunk(
          sourceHandle,
          sourceBuffer,
          position,
          "compare",
          "source",
          signal,
          testHooks,
        );
        const destinationBytes = await readFilledChunk(
          destinationHandle,
          destinationBuffer,
          position,
          "compare",
          "destination",
          signal,
          testHooks,
        );
        const comparableBytes = Math.min(sourceBytes, destinationBytes);
        bytesCompared += comparableBytes;

        if (
          !sourceBuffer
            .subarray(0, comparableBytes)
            .equals(destinationBuffer.subarray(0, comparableBytes)) ||
          sourceBytes !== destinationBytes
        ) {
          status = "mismatch";
          break;
        }
        if (sourceBytes === 0) {
          break;
        }

        position += sourceBytes;
      }
    }

    throwIfAborted(signal);
    const [sourceAfter, destinationAfter, sourceRequestedAfterRead, destinationRequestedAfterRead] =
      await Promise.all([
        sourceHandle.stat({ bigint: true }).then(snapshotFile),
        destinationHandle.stat({ bigint: true }).then(snapshotFile),
        snapshotRequestedFile(sourcePath),
        snapshotRequestedFile(destinationPath),
      ]);
    if (
      !snapshotsMatch(sourceBefore, sourceAfter) ||
      !snapshotsMatch(destinationBefore, destinationAfter) ||
      !snapshotsMatch(sourceAfter, sourceRequestedAfterRead) ||
      !snapshotsMatch(destinationAfter, destinationRequestedAfterRead)
    ) {
      return { status: "unstable", sameInode, bytesCompared };
    }

    return { status, sameInode, bytesCompared };
  } finally {
    try {
      if (destinationHandle) {
        await closeHandle(destinationHandle, "compare", "destination", testHooks);
      }
    } finally {
      await closeHandle(sourceHandle, "compare", "source", testHooks);
    }
  }
}

/**
 * Verifies file integrity by comparing SHA-256 hashes.
 *
 * @param sourcePath - Path to the source file
 * @param destPath - Path to the destination file
 * @returns True if hashes match, false otherwise
 */
export async function verifyFileIntegrity(sourcePath: string, destPath: string): Promise<boolean> {
  logDebug(`Verifying integrity: ${sourcePath} -> ${destPath}`);

  try {
    const [sourceHash, destHash] = await Promise.all([
      calculateHash(sourcePath),
      calculateHash(destPath),
    ]);
    const match = sourceHash === destHash;

    logDebug(match ? "Integrity check passed" : "Integrity check failed");
    return match;
  } catch (error: unknown) {
    logDebug(`Integrity check error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
