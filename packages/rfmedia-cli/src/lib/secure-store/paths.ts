/**
 * Safe-path machinery for the secure store: strict-default directory
 * preparation, opt-in final-parent hardening, TOCTOU-resistant identity
 * assertions, a policy-aware asynchronous read, and a bounded owner-only
 * synchronous read.
 *
 * The asynchronous primitives originated in Lidarr preset persistence before
 * that module migrated onto this shared surface. The synchronous counterparts
 * remain necessary because `createMediaServerAdapter` is synchronous.
 *
 * **No implicit repair.** The default parent policy only validates. The one
 * permission-changing path is the descriptive `harden-private` opt-in, which
 * changes only a descriptor-validated final parent.
 */

import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  containsTerminalControl,
  hasErrorCode,
  rethrowAsSecureStoreError,
  secureStoreError,
} from "./errors.js";

/** Mode applied to every directory the secure store creates. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/** Mode applied to every file the secure store creates. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Longest filesystem path the secure store will operate on.
 *
 * Exported because `plan.ts`, `lidarr/plan-engine.ts` and
 * `lidarr/profile-preset-persistence.ts` each declare this same ceiling at the
 * same value. The `SECURE_STORE_` prefix follows the convention already set by
 * `SECURE_STORE_LOCK_MAX_AGE_MS` for names too generic to sit unqualified on a
 * shared barrel; `PRIVATE_FILE_MODE` and `PRIVATE_DIRECTORY_MODE` stay
 * unprefixed because they are already distinctive.
 */
export const SECURE_STORE_MAX_PATH_LENGTH = 4_096;

/** Group/other write bits: a directory carrying either is hijackable. */
const FOREIGN_WRITE_BITS = 0o022;

/** Group/other read/write/execute bits: a private file must carry none. */
const FOREIGN_ACCESS_BITS = 0o077;

/** Group/other write/execute bits: foreign read access is the only allowed relaxation. */
const FOREIGN_WRITE_EXECUTE_BITS = 0o033;

/** No-follow, nonblocking descriptor flags shared by async and sync bounded reads. */
const BOUNDED_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** Fill a bounded buffer despite legal short reads, stopping only at EOF or capacity. */
async function readToEndOrCapacity(handle: FileHandle, buffer: Buffer): Promise<number> {
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      totalBytesRead,
    );
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
  }
  return totalBytesRead;
}

/** Synchronous counterpart of {@link readToEndOrCapacity}. */
function readToEndOrCapacitySync(descriptor: number, buffer: Buffer): number {
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      totalBytesRead,
    );
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
  }
  return totalBytesRead;
}

/** Inode coordinates used to prove a path still refers to the same object. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** A directory that passed every safety check, with its captured identity. */
export interface SafeParent {
  /** Absolute directory path. */
  readonly path: string;
  /** Identity captured at check time; re-asserted after every I/O step. */
  readonly identity: FileIdentity;
}

/** Result of {@link readBoundedPrivateFile} and {@link readBoundedPrivateFileSync}. */
export interface BoundedPrivateRead {
  /** UTF-8 decoded file contents. */
  readonly text: string;
  /** Identity of the file that was actually read. */
  readonly identity: FileIdentity;
  /** File mode as reported by `fstat`, for callers that report it. */
  readonly mode: number;
}

/**
 * File-mode validation policy for {@link readBoundedPrivateFile}.
 *
 * `owner-only` rejects group/other access bits. `allow-foreign-read` accepts
 * group/other read bits while still rejecting their write and execute bits.
 */
export type BoundedPrivateFileModePolicy = "owner-only" | "allow-foreign-read";

/**
 * Validation policy for the final directory prepared by {@link prepareSafeParent}.
 *
 * `validate` preserves the directory mode and rejects group/other write bits.
 * `harden-private` safely restricts only the final directory to `0o700`.
 */
export type FinalParentPolicy = "validate" | "harden-private";

/**
 * Final-parent policy available only to non-mutating bounded reads.
 *
 * `read-compatible` keeps component type/symlink and final-parent identity
 * checks, but does not require the final directory to be private or user-owned.
 */
export type ReadParentPolicy = "validate" | "read-compatible";

/** Every final-parent policy understood internally by the shared path walker. */
type SafeParentPolicy = FinalParentPolicy | ReadParentPolicy;

/**
 * Reports whether two identities refer to the same filesystem object.
 *
 * @param left - First identity.
 * @param right - Second identity.
 * @returns `true` when both `dev` and `ino` match.
 */
export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Validates and absolutizes a secure-store path.
 *
 * @param inputPath - Caller-supplied path.
 * @param subject - Short human name of the protected document.
 * @returns The resolved absolute path.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when the path is empty,
 *   longer than 4096 characters, or contains a control or bidi character.
 */
export function resolveSecurePath(inputPath: string, subject: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.length > SECURE_STORE_MAX_PATH_LENGTH ||
    containsTerminalControl(inputPath)
  ) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, inputPath);
  }
  return resolve(inputPath);
}

function assertOwnedDirectory(info: Stats, directory: string, subject: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
  }
}

function assertSafeDirectory(
  info: Stats,
  directory: string,
  subject: string,
  checkOwnership: boolean,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
  }
  if (!checkOwnership) return;
  assertOwnedDirectory(info, directory, subject);
  if ((info.mode & FOREIGN_WRITE_BITS) !== 0) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
  }
}

function directoryComponents(directory: string): readonly string[] {
  const root = parse(directory).root;
  return relative(root, directory).split(sep).filter(Boolean);
}

async function hardenPrivateFinalParent(
  directory: string,
  initial: Stats,
  subject: string,
): Promise<SafeParent> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    assertOwnedDirectory(before, directory, subject);
    if (!sameIdentity(initial, before)) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
    }

    const namedBefore = await lstat(directory);
    assertOwnedDirectory(namedBefore, directory, subject);
    if (!sameIdentity(before, namedBefore)) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
    }

    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    const after = await handle.stat();
    assertSafeDirectory(after, directory, subject, true);
    if (!sameIdentity(before, after) || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
    }

    const namedAfter = await lstat(directory);
    assertSafeDirectory(namedAfter, directory, subject, true);
    if (!sameIdentity(after, namedAfter) || (namedAfter.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
    }
    return { path: directory, identity: { dev: after.dev, ino: after.ino } };
  } catch (error) {
    return rethrowAsSecureStoreError(error, subject, directory);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Walks every component of a file's parent directory, rejecting symlinks and
 * non-directories. The default requires the final directory to be owned by the
 * current user with no group/other write bit.
 *
 * @param filePath - Path of the file whose parent is being prepared.
 * @param createMissing - Create missing components with mode `0o700`.
 * @param subject - Short human name of the protected document.
 * @param finalParentPolicy - Final-directory policy. Defaults to validate-only;
 *   `harden-private` safely restricts only the final directory to `0o700`.
 * @returns The verified parent directory and its captured identity.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when any component fails
 *   a check.
 */
export async function prepareSafeParent(
  filePath: string,
  createMissing: boolean,
  subject: string,
  finalParentPolicy: FinalParentPolicy = "validate",
): Promise<SafeParent> {
  return prepareParent(filePath, createMissing, subject, finalParentPolicy);
}

async function prepareParent(
  filePath: string,
  createMissing: boolean,
  subject: string,
  finalParentPolicy: SafeParentPolicy,
): Promise<SafeParent> {
  const path = resolveSecurePath(filePath, subject);
  const directory = dirname(path);
  if (finalParentPolicy === "harden-private" && directory === parse(directory).root) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, directory);
  }
  const components = directoryComponents(directory);
  let current = parse(directory).root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let created = false;
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!createMissing || !hasErrorCode(error, "ENOENT")) {
        rethrowAsSecureStoreError(error, subject, current);
      }
      try {
        await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
        created = true;
      } catch (mkdirError) {
        if (!hasErrorCode(mkdirError, "EEXIST")) {
          rethrowAsSecureStoreError(mkdirError, subject, current);
        }
      }
      info = await lstat(current);
    }
    const isFinalParent = index === components.length - 1;
    if (isFinalParent && finalParentPolicy === "harden-private") {
      assertOwnedDirectory(info, current, subject);
    } else if (isFinalParent && finalParentPolicy === "read-compatible") {
      assertSafeDirectory(info, current, subject, false);
    } else {
      assertSafeDirectory(info, current, subject, isFinalParent);
    }
    if (created) await chmod(current, PRIVATE_DIRECTORY_MODE);
  }
  const info = await lstat(directory);
  if (finalParentPolicy === "harden-private") {
    assertOwnedDirectory(info, directory, subject);
    return hardenPrivateFinalParent(directory, info, subject);
  }
  assertSafeDirectory(info, directory, subject, finalParentPolicy !== "read-compatible");
  return { path: directory, identity: { dev: info.dev, ino: info.ino } };
}

/**
 * Synchronous counterpart of {@link prepareSafeParent} that never creates a
 * directory. Used on the adapter-construction read path, which must stay
 * synchronous.
 *
 * @param filePath - Path of the file whose parent is being checked.
 * @param subject - Short human name of the protected document.
 * @returns The verified parent directory and its captured identity.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when a component fails a
 *   check.
 * @throws The raw `ENOENT` error when a component does not exist, so the caller
 *   can decide whether absence is a failure.
 */
export function prepareSafeParentSync(filePath: string, subject: string): SafeParent {
  const path = resolveSecurePath(filePath, subject);
  const directory = dirname(path);
  const components = directoryComponents(directory);
  let current = parse(directory).root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let info: Stats;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) throw error;
      rethrowAsSecureStoreError(error, subject, current);
    }
    assertSafeDirectory(info, current, subject, index === components.length - 1);
  }
  const info = lstatSync(directory);
  assertSafeDirectory(info, directory, subject, true);
  return { path: directory, identity: { dev: info.dev, ino: info.ino } };
}

/**
 * Re-checks a previously verified parent directory and proves it is still the
 * same inode.
 *
 * @param parent - Parent captured by {@link prepareSafeParent}.
 * @param subject - Short human name of the protected document.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when the directory
 *   changed or no longer passes its checks.
 */
export async function assertSafeParentUnchanged(
  parent: SafeParent,
  subject: string,
): Promise<void> {
  return assertParentUnchanged(parent, subject, "validate");
}

async function assertParentUnchanged(
  parent: SafeParent,
  subject: string,
  finalParentPolicy: SafeParentPolicy,
): Promise<void> {
  const current = await lstat(parent.path);
  assertSafeDirectory(current, parent.path, subject, finalParentPolicy !== "read-compatible");
  if (!sameIdentity(parent.identity, current)) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, parent.path);
  }
}

/**
 * Synchronous counterpart of {@link assertSafeParentUnchanged}.
 *
 * @param parent - Parent captured by {@link prepareSafeParentSync}.
 * @param subject - Short human name of the protected document.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when the directory
 *   changed or no longer passes its checks.
 */
export function assertSafeParentUnchangedSync(parent: SafeParent, subject: string): void {
  const current = lstatSync(parent.path);
  assertSafeDirectory(current, parent.path, subject, true);
  if (!sameIdentity(parent.identity, current)) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, parent.path);
  }
}

/**
 * Proves that `path` still names the regular file whose identity was captured
 * while it was open.
 *
 * @param path - Path to re-check.
 * @param opened - Identity captured from the open handle.
 * @param subject - Short human name of the protected document.
 * @returns The fresh `lstat` result.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when the path became a
 *   symlink, stopped being a regular file, or now refers to a different inode.
 */
export async function assertOpenedFileIdentity(
  path: string,
  opened: FileIdentity,
  subject: string,
): Promise<Stats> {
  const current = await lstat(path);
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(opened, current)) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
  }
  return current;
}

/**
 * Synchronous counterpart of {@link assertOpenedFileIdentity}.
 *
 * @param path - Path to re-check.
 * @param opened - Identity captured from the open descriptor.
 * @param subject - Short human name of the protected document.
 * @returns The fresh `lstat` result.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when the path no longer
 *   refers to the same regular file.
 */
export function assertOpenedFileIdentitySync(
  path: string,
  opened: FileIdentity,
  subject: string,
): Stats {
  const current = lstatSync(path);
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(opened, current)) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
  }
  return current;
}

/**
 * Reads a file with a hard byte ceiling, without blocking the event loop.
 *
 * Opens with `O_NONBLOCK` and `O_NOFOLLOW` so a special file cannot block and a
 * symlink is rejected by the kernel, then refuses non-files before reading. The
 * read is bounded and both the file identity and parent directory are
 * re-asserted afterwards. The default `owner-only` policy refuses any file
 * carrying a group or other permission bit.
 * `allow-foreign-read` accepts only group/other read bits; write and execute
 * bits remain forbidden. Nothing is repaired.
 *
 * Exported from the barrel for parity with {@link readBoundedPrivateFileSync},
 * which `adapters/plex/credential-store.ts:277` and `:386` already consume.
 *
 * @param filePath - File to read.
 * @param maximumBytes - Hard ceiling on the number of bytes read.
 * @param subject - Short human name of the protected document.
 * @param fileModePolicy - File-mode validation policy. Defaults to `owner-only`;
 *   `allow-foreign-read` retains every path, type, size, identity, and parent
 *   check while accepting group/other read bits.
 * @param parentPolicy - Final-parent read policy. `read-compatible` permits a
 *   non-private or differently owned final directory without changing it while
 *   retaining component, no-follow, and identity checks.
 * @returns The decoded contents and identity, or `undefined` when the file (or
 *   one of its parent directories) does not exist.
 * @throws {SecureStoreError} `SECURE_STORE_PERMISSIONS` for group/other access
 *   under `owner-only` or group/other write/execute access under
 *   `allow-foreign-read`, `SECURE_STORE_TOO_LARGE` past the ceiling, and
 *   `SECURE_STORE_UNSAFE_PATH` for a symlink, non-file, or mid-read swap.
 */
export async function readBoundedPrivateFile(
  filePath: string,
  maximumBytes: number,
  subject: string,
  fileModePolicy: BoundedPrivateFileModePolicy = "owner-only",
  parentPolicy: ReadParentPolicy = "validate",
): Promise<BoundedPrivateRead | undefined> {
  const path = resolveSecurePath(filePath, subject);
  let parent: SafeParent;
  try {
    parent = await prepareParent(path, false, subject, parentPolicy);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let handle: FileHandle;
  try {
    handle = await open(path, BOUNDED_READ_FLAGS);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    rethrowAsSecureStoreError(error, subject, path);
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
    }
    const forbiddenModeBits =
      fileModePolicy === "owner-only" ? FOREIGN_ACCESS_BITS : FOREIGN_WRITE_EXECUTE_BITS;
    if ((before.mode & forbiddenModeBits) !== 0) {
      throw secureStoreError("SECURE_STORE_PERMISSIONS", subject, path);
    }
    if (before.size > maximumBytes) {
      throw secureStoreError("SECURE_STORE_TOO_LARGE", subject, path);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const bytesRead = await readToEndOrCapacity(handle, buffer);
    const after = await handle.stat();
    if (bytesRead > maximumBytes || after.size > maximumBytes) {
      throw secureStoreError("SECURE_STORE_TOO_LARGE", subject, path);
    }
    if (!sameIdentity(before, after)) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
    }
    const identity: FileIdentity = { dev: after.dev, ino: after.ino };
    try {
      await assertOpenedFileIdentity(path, identity, subject);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      await assertParentUnchanged(parent, subject, parentPolicy);
      return undefined;
    }
    await assertParentUnchanged(parent, subject, parentPolicy);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      identity,
      mode: after.mode,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Synchronous counterpart of {@link readBoundedPrivateFile}, for the
 * adapter-construction read path that must stay synchronous.
 *
 * Opens with `O_NONBLOCK` and `O_NOFOLLOW` so a special file cannot block and a
 * symlink is rejected by the kernel, then refuses non-files before reading. It
 * refuses any file carrying a group or other permission bit, bounds the read,
 * and re-asserts both the file identity and the parent directory afterwards.
 * Nothing is repaired: a `0o640` file is reported with a `chmod 600` remedy,
 * never fixed.
 *
 * @param filePath - File to read.
 * @param maximumBytes - Hard ceiling on the number of bytes read.
 * @param subject - Short human name of the protected document.
 * @returns The decoded contents and identity, or `undefined` when the file (or
 *   one of its parent directories) does not exist.
 * @throws {SecureStoreError} `SECURE_STORE_PERMISSIONS` for a group/other
 *   readable file, `SECURE_STORE_TOO_LARGE` past the ceiling, and
 *   `SECURE_STORE_UNSAFE_PATH` for a symlink, non-file, or mid-read swap.
 */
export function readBoundedPrivateFileSync(
  filePath: string,
  maximumBytes: number,
  subject: string,
): BoundedPrivateRead | undefined {
  const path = resolveSecurePath(filePath, subject);
  let parent: SafeParent;
  try {
    parent = prepareSafeParentSync(path, subject);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let descriptor: number;
  try {
    descriptor = openSync(path, BOUNDED_READ_FLAGS);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    rethrowAsSecureStoreError(error, subject, path);
  }

  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
    }
    if ((before.mode & FOREIGN_ACCESS_BITS) !== 0) {
      throw secureStoreError("SECURE_STORE_PERMISSIONS", subject, path);
    }
    if (before.size > maximumBytes) {
      throw secureStoreError("SECURE_STORE_TOO_LARGE", subject, path);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const bytesRead = readToEndOrCapacitySync(descriptor, buffer);
    const after = fstatSync(descriptor);
    if (bytesRead > maximumBytes || after.size > maximumBytes) {
      throw secureStoreError("SECURE_STORE_TOO_LARGE", subject, path);
    }
    if (!sameIdentity(before, after)) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
    }
    const identity: FileIdentity = { dev: after.dev, ino: after.ino };
    assertOpenedFileIdentitySync(path, identity, subject);
    assertSafeParentUnchangedSync(parent, subject);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      identity,
      mode: after.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}
