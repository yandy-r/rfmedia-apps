/**
 * Descriptor-anchored Linux MP3 rating publication.
 *
 * This module owns the trust validation, descriptor pinning, metadata
 * preservation, and atomic replacement boundary for pathname-based MP3 writes.
 */

import NodeID3 from "node-id3";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { logDebug } from "../logger.js";

interface Mp3RatingWriteOptions {
  readonly popmEmail?: string;
  readonly popmCounter?: number;
  readonly preserveTags?: boolean;
  readonly signal?: AbortSignal;
}

interface Mp3RatingWriteResult {
  readonly success: boolean;
  readonly message: string;
  readonly format: "mp3";
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const DEFAULT_POPM_EMAIL = "no@email";
const METADATA_CHILD_TIMEOUT_MS = 30_000;
const METADATA_CHILD_KILL_GRACE_MS = 1_000;
const READ_ONLY_NOFOLLOW_FLAGS =
  constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const DIRECTORY_NOFOLLOW_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const LINUX_CP_PATH = "/bin/cp";
const LINUX_CHILD_SOURCE_FD = 3;
const LINUX_CHILD_STAGE_FD = 4;

/**
 * Mode the rewritten stage is CREATED with, so a partially written MP3 is
 * unobservable to other users during the open-to-publish window. The stage
 * does NOT keep this mode: `preserveLinuxMp3Metadata` restores the source's
 * mode, ownership and xattrs via `cp --preserve=mode,ownership,xattr`, and
 * the pre-rename guard rejects any stage whose `mode & 0o7777` no longer
 * equals the source's. Deliberately NOT secure-store's PRIVATE_FILE_MODE,
 * which names a permanent property of a credential document; this stage
 * intentionally discards the mode it is created with.
 */
const STAGE_PRIVATE_MODE = 0o600;

/**
 * node-id3 synchronously holds the source and rewritten MP3 buffers. Keeping
 * inputs at or below 32 MiB bounds pathname and isolated conversion writes.
 */
export const MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES = 32 * 1024 * 1024;

export function encodePopmRating(rating: number): number {
  return rating <= 0 ? 0 : Math.round(rating * 254) + 1;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMp3SourceSnapshot(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    sameFileIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameMp3StageSnapshot(left: Stats, right: Stats): boolean {
  return (
    right.nlink === 1 &&
    sameMp3SourceSnapshot(left, right) &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    (left.mode & 0o7777) === (right.mode & 0o7777)
  );
}

function validMp3Source(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink >= 1;
}

function validPrivateMp3Stage(stats: Stats): boolean {
  return validMp3Source(stats) && stats.nlink === 1;
}

function trustedMp3Source(stats: Stats, effectiveUserId: number): boolean {
  const trustedOwner = stats.uid === effectiveUserId || stats.uid === 0;
  // POSIX exposes an access ACL's effective mask through the group mode bits.
  return trustedOwner && (stats.mode & 0o022) === 0;
}

function safeMp3SourceSize(stats: Stats): boolean {
  return (
    Number.isSafeInteger(stats.size) &&
    stats.size >= 0 &&
    stats.size <= MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES
  );
}

function mp3Failure(message: string): Mp3RatingWriteResult {
  return { success: false, message, format: "mp3" };
}

function trustedMp3Directory(stats: Stats, effectiveUserId: number): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  if (stats.uid !== effectiveUserId && stats.uid !== 0) return false;
  const foreignWritable = (stats.mode & 0o022) !== 0;
  const sticky = (stats.mode & 0o1000) !== 0;
  return !foreignWritable || sticky;
}

async function validateTrustedMp3ParentChain(
  parentPath: string,
  effectiveUserId: number,
): Promise<Stats | undefined> {
  const chain: string[] = [];
  let currentPath = parentPath;
  while (true) {
    chain.push(currentPath);
    const nextPath = dirname(currentPath);
    if (nextPath === currentPath) break;
    currentPath = nextPath;
  }

  let parentStats: Stats | undefined;
  for (const directoryPath of chain.reverse()) {
    const stats = await lstat(directoryPath);
    if (!trustedMp3Directory(stats, effectiveUserId)) return undefined;
    parentStats = stats;
  }
  return parentStats;
}

async function cleanupPrivateMp3Stage(
  stagePath: string | undefined,
  expectedStageStats: Stats | undefined,
): Promise<void> {
  if (stagePath === undefined || expectedStageStats === undefined) return;
  try {
    const stageEntryStats = await lstat(stagePath);
    if (!sameMp3StageSnapshot(expectedStageStats, stageEntryStats)) return;
    await unlink(stagePath);
  } catch {
    // The stage was either published or is already unavailable.
  }
}

function descriptorPath(fileDescriptor: number): string {
  // Linux resolves children below this path from the held descriptor, so a
  // rename/replacement of the directory's original pathname cannot retarget
  // any later source, stage, publication, or cleanup operation.
  return `/proc/self/fd/${fileDescriptor}`;
}

async function preserveLinuxMp3Metadata(
  sourceHandle: FileHandle,
  stageHandle: FileHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  let child: ChildProcess;
  try {
    // Explicit GNU cp preservation copies ownership, mode/ACL, and xattrs
    // between inherited descriptors without reopening either user pathname.
    child = spawn(
      LINUX_CP_PATH,
      [
        "--attributes-only",
        "--preserve=mode,ownership,xattr",
        descriptorPath(LINUX_CHILD_SOURCE_FD),
        descriptorPath(LINUX_CHILD_STAGE_FD),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", sourceHandle.fd, stageHandle.fd],
      },
    );
  } catch {
    return false;
  }

  return new Promise<boolean>((resolveResult, rejectResult) => {
    let settled = false;
    let pending:
      | { readonly ok: true; readonly success: boolean }
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
    const settle = (
      outcome:
        | { readonly ok: true; readonly success: boolean }
        | { readonly ok: false; readonly error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome.ok) resolveResult(outcome.success);
      else rejectResult(outcome.error);
    };
    const settlePending = (): void => {
      if (pending !== undefined) settle(pending);
    };
    const terminateWith = (outcome: NonNullable<typeof pending>): void => {
      if (settled || pending !== undefined) return;
      pending = outcome;
      child.kill("SIGTERM");
      if (settled) return;
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
      terminateWith({ ok: true, success: false });
    }, METADATA_CHILD_TIMEOUT_MS);
    timeoutTimer.unref();

    abortHandler = (): void => {
      terminateWith({ ok: false, error: signal?.reason });
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.once("error", () => settle({ ok: true, success: false }));
    child.once("exit", (code) => {
      if (pending !== undefined) {
        settlePending();
        return;
      }
      settle({ ok: true, success: code === 0 });
    });

    if (signal?.aborted) abortHandler();
  });
}

/** Writes one normalized rating through an anchored, metadata-preserving replacement. */
export async function writeMp3Rating(
  filePath: string,
  rating: number,
  options: Mp3RatingWriteOptions,
): Promise<Mp3RatingWriteResult> {
  const {
    popmEmail: sourcePopmEmail = DEFAULT_POPM_EMAIL,
    popmCounter = 0,
    preserveTags = true,
  } = options;
  const popmEmail = sourcePopmEmail.trim().length > 0 ? sourcePopmEmail : DEFAULT_POPM_EMAIL;
  const popmValue = encodePopmRating(rating);
  const tags = {
    popularimeter: {
      email: popmEmail,
      rating: popmValue,
      counter: popmCounter,
    },
  };

  const resolvedPath = resolve(filePath);
  const parentPath = dirname(resolvedPath);
  const targetName = basename(resolvedPath);
  let parentHandle: FileHandle | undefined;
  let sourceHandle: FileHandle | undefined;
  let stageHandle: FileHandle | undefined;
  let stagePath: string | undefined;
  let cleanupStageStats: Stats | undefined;
  let published = false;

  try {
    if (process.platform !== "linux") {
      return mp3Failure("Safe MP3 rating writes are unsupported on this platform");
    }

    options.signal?.throwIfAborted();
    const effectiveUserId = process.geteuid?.();
    if (effectiveUserId === undefined) {
      return mp3Failure("MP3 rating-write parent ancestry is not trusted");
    }
    const parentStats = await validateTrustedMp3ParentChain(parentPath, effectiveUserId);
    if (parentStats === undefined) {
      return mp3Failure("MP3 rating-write parent ancestry is not trusted");
    }
    parentHandle = await open(parentPath, DIRECTORY_NOFOLLOW_FLAGS);
    const openedParentStats = await parentHandle.stat();
    if (!openedParentStats.isDirectory() || !sameFileIdentity(parentStats, openedParentStats)) {
      return mp3Failure("MP3 rating-write parent changed during validation");
    }

    const anchoredParentPath = descriptorPath(parentHandle.fd);
    const anchoredTargetPath = join(anchoredParentPath, targetName);
    const fileStats = await lstat(anchoredTargetPath);
    if (!validMp3Source(fileStats)) {
      return mp3Failure("MP3 rating writes require a regular file");
    }
    if (!trustedMp3Source(fileStats, effectiveUserId)) {
      return mp3Failure("MP3 rating writes require a trusted, non-foreign-writable regular file");
    }
    if (!safeMp3SourceSize(fileStats)) {
      return mp3Failure("MP3 exceeds the safe synchronous rating-write size limit");
    }

    sourceHandle = await open(anchoredTargetPath, READ_ONLY_NOFOLLOW_FLAGS);
    const openedStats = await sourceHandle.stat();
    if (
      !sameMp3SourceSnapshot(fileStats, openedStats) ||
      !trustedMp3Source(openedStats, effectiveUserId)
    ) {
      return mp3Failure("MP3 rating-write target changed during validation");
    }

    if (openedStats.nlink > 1) {
      options.signal?.throwIfAborted();
      let directWriteResult: true | Buffer | Error;
      try {
        const method = preserveTags ? NodeID3.update : NodeID3.write;
        directWriteResult = method(tags, descriptorPath(sourceHandle.fd));
      } catch {
        return mp3Failure("node-id3 write failed");
      }
      if (directWriteResult !== true) {
        return mp3Failure("node-id3 write failed");
      }
      const [afterWriteStats, afterWriteTargetStats] = await Promise.all([
        sourceHandle.stat(),
        lstat(anchoredTargetPath),
      ]);
      if (
        !validMp3Source(afterWriteStats) ||
        !validMp3Source(afterWriteTargetStats) ||
        !sameFileIdentity(openedStats, afterWriteStats) ||
        !sameFileIdentity(openedStats, afterWriteTargetStats) ||
        openedStats.nlink !== afterWriteStats.nlink ||
        openedStats.nlink !== afterWriteTargetStats.nlink ||
        !trustedMp3Source(afterWriteStats, effectiveUserId) ||
        !trustedMp3Source(afterWriteTargetStats, effectiveUserId)
      ) {
        return mp3Failure("MP3 rating-write target changed during linked publication");
      }
      logDebug(`Wrote POPM rating ${popmValue} to ${resolvedPath}`);
      return { success: true, message: "Rating written", format: "mp3" };
    }

    const source = await sourceHandle.readFile();
    const afterReadStats = await sourceHandle.stat();
    if (
      source.byteLength !== openedStats.size ||
      !sameMp3SourceSnapshot(openedStats, afterReadStats) ||
      !trustedMp3Source(afterReadStats, effectiveUserId)
    ) {
      return mp3Failure("MP3 rating-write target changed while it was read");
    }

    let rewritten: Buffer;
    try {
      const transformed = preserveTags ? NodeID3.update(tags, source) : NodeID3.write(tags, source);
      if (!Buffer.isBuffer(transformed)) {
        return mp3Failure("node-id3 write failed");
      }
      rewritten = transformed;
    } catch {
      return mp3Failure("node-id3 write failed");
    }

    stagePath = join(anchoredParentPath, `.${targetName}.rfmedia-rating-${randomUUID()}.tmp`);
    stageHandle = await open(stagePath, "wx+", STAGE_PRIVATE_MODE);
    const createdStageStats = await stageHandle.stat();
    if (!validPrivateMp3Stage(createdStageStats)) {
      return mp3Failure("MP3 rating-write stage could not be validated");
    }
    await stageHandle.writeFile(rewritten);
    await stageHandle.sync();
    if (!(await preserveLinuxMp3Metadata(sourceHandle, stageHandle, options.signal))) {
      return mp3Failure("MP3 rating-write metadata could not be retained");
    }
    await stageHandle.sync();
    const stagedContentStats = await stageHandle.stat();
    if (
      !sameFileIdentity(createdStageStats, stagedContentStats) ||
      !validPrivateMp3Stage(stagedContentStats) ||
      stagedContentStats.size !== rewritten.byteLength
    ) {
      return mp3Failure("MP3 rating-write stage changed while it was prepared");
    }

    const [currentSourceStats, currentTargetStats, currentParentStats, currentStageStats] =
      await Promise.all([
        sourceHandle.stat(),
        lstat(anchoredTargetPath),
        parentHandle.stat(),
        stageHandle.stat(),
      ]);
    if (
      !sameMp3SourceSnapshot(openedStats, currentSourceStats) ||
      !sameMp3SourceSnapshot(openedStats, currentTargetStats) ||
      !trustedMp3Source(currentSourceStats, effectiveUserId) ||
      !trustedMp3Source(currentTargetStats, effectiveUserId)
    ) {
      return mp3Failure("MP3 rating-write target changed before publication");
    }
    if (
      !trustedMp3Directory(currentParentStats, effectiveUserId) ||
      !sameFileIdentity(openedParentStats, currentParentStats)
    ) {
      return mp3Failure("MP3 rating-write parent changed before publication");
    }
    if (!sameMp3StageSnapshot(stagedContentStats, currentStageStats)) {
      return mp3Failure("MP3 rating-write stage changed before publication");
    }
    if (
      currentStageStats.uid !== openedStats.uid ||
      currentStageStats.gid !== openedStats.gid ||
      (currentStageStats.mode & 0o7777) !== (openedStats.mode & 0o7777)
    ) {
      return mp3Failure("MP3 rating-write ownership or mode could not be retained");
    }

    options.signal?.throwIfAborted();
    const currentStageEntryStats = await lstat(stagePath);
    if (!sameMp3StageSnapshot(stagedContentStats, currentStageEntryStats)) {
      return mp3Failure("MP3 rating-write stage changed before publication");
    }
    const [publicationSourceStats, publicationTargetStats] = await Promise.all([
      sourceHandle.stat(),
      lstat(anchoredTargetPath),
    ]);
    if (
      !sameMp3SourceSnapshot(openedStats, publicationSourceStats) ||
      !sameMp3SourceSnapshot(openedStats, publicationTargetStats) ||
      !trustedMp3Source(publicationSourceStats, effectiveUserId) ||
      !trustedMp3Source(publicationTargetStats, effectiveUserId)
    ) {
      return mp3Failure("MP3 rating-write target changed before publication");
    }
    options.signal?.throwIfAborted();
    await rename(stagePath, anchoredTargetPath);
    published = true;
    logDebug(`Wrote POPM rating ${popmValue} to ${resolvedPath}`);
    return { success: true, message: "Rating written", format: "mp3" };
  } catch (error: unknown) {
    if (options.signal?.aborted && error === options.signal.reason) throw error;
    return mp3Failure("MP3 rating write could not be published safely");
  } finally {
    if (!published) {
      try {
        cleanupStageStats = await stageHandle?.stat();
      } catch {
        // Cleanup will not unlink an entry without an authoritative descriptor snapshot.
      }
    }
    try {
      await stageHandle?.close();
    } catch {
      // The bounded failure result remains authoritative.
    }
    try {
      await sourceHandle?.close();
    } catch {
      // The bounded failure result remains authoritative.
    }
    if (!published) await cleanupPrivateMp3Stage(stagePath, cleanupStageStats);
    try {
      await parentHandle?.close();
    } catch {
      // The bounded failure result remains authoritative.
    }
  }
}
