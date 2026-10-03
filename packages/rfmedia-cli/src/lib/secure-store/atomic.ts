/**
 * Atomic owner-only file publication for the secure store.
 *
 * Both writers stage into a sibling temporary file in the **same directory** —
 * never `os.tmpdir()`, because `link`/`rename` across filesystems fails
 * `EXDEV` — and publish with a single atomic syscall. The temporary file's
 * `0o600` inode is what becomes visible, so a pre-existing world-readable target
 * is replaced by a private one rather than being chmod-ed in place.
 *
 * A staging file is a SECOND NAME FOR THE SAME SECRET BYTES, so no writer here
 * may return or throw while one still exists: both publish inside `try`/
 * `finally` and drop the stage on every path. A crash (`SIGKILL`, power loss)
 * can still strand one, which is what {@link removeOrphanedTemporaryFiles}
 * exists to clear.
 *
 * The writer discipline originated in Lidarr preset persistence before that
 * module migrated onto this shared surface.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { link, open, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hasErrorCode, rethrowAsSecureStoreError, secureStoreError } from "./errors.js";
import {
  assertOpenedFileIdentity,
  assertSafeParentUnchanged,
  prepareSafeParent,
  PRIVATE_FILE_MODE,
  sameIdentity,
} from "./paths.js";
import type { FileIdentity, FinalParentPolicy, SafeParent } from "./paths.js";

/** Shared inputs for the atomic writers. */
export interface AtomicWriteInput {
  /** Absolute path of the file to publish. */
  readonly path: string;
  /** UTF-8 payload. */
  readonly text: string;
  /** Short human name of the protected document. */
  readonly subject: string;
  /** Caller-stable discriminator embedded in the temporary file name. */
  readonly temporaryId: string;
  /** Test seam for the temporary-file suffix. Defaults to `crypto.randomUUID`. */
  readonly randomUUID?: () => string;
  /** Final-directory policy. Defaults to strict validate-only behavior. */
  readonly finalParentPolicy?: FinalParentPolicy;
}

/** Inputs for {@link replacePrivateFileAtomically}. */
export interface AtomicReplaceInput extends AtomicWriteInput {
  /**
   * Identity of the file being replaced, captured under the lock. The rename is
   * refused when the target no longer has this identity — the syscall axis of
   * the compare-and-swap.
   */
  readonly expectedIdentity: FileIdentity;
}

/**
 * Subject attached to failures raised by {@link syncDirectory}, which takes a
 * bare path so its callers' signatures stay unchanged and has no document
 * subject to forward. Every message stays a fixed local literal either way.
 */
const DIRECTORY_SYNC_SUBJECT = "Secure store directory";

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
}

/**
 * Flushes a directory entry so a `link`/`rename` survives a power loss.
 *
 * `O_DIRECTORY` is mandatory: without it a regular-file path is silently fsynced
 * instead of erroring. `lidarr/plan-engine.ts:3919-3938` already carries this
 * hardening, so adopting the weaker form anywhere would be a downgrade.
 * `constants.O_DIRECTORY` is `undefined` on win32, so the platform guard is not
 * optional.
 *
 * @param path - Directory to fsync. A no-op on win32.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when `path` is not a
 *   directory or is a symlink, `SECURE_STORE_PERMISSIONS` when it cannot be
 *   opened. Every other `errno` is rethrown unchanged.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    rethrowAsSecureStoreError(error, DIRECTORY_SYNC_SUBJECT, path);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Flushes the exact parent directory captured before publication.
 *
 * The descriptor is identity-checked before syncing and the pathname is
 * checked both before and after. If the parent is renamed or replaced after
 * the descriptor opens, the original directory is still the one fsynced and
 * the post-sync pathname check prevents a false success.
 */
async function syncSafeParentDirectory(parent: SafeParent, subject: string): Promise<void> {
  if (process.platform === "win32") {
    await assertSafeParentUnchanged(parent, subject);
    return;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      parent.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(parent.identity, opened)) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, parent.path);
    }
    await assertSafeParentUnchanged(parent, subject);
    await handle.sync();
    await assertSafeParentUnchanged(parent, subject);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, parent.path, error);
    }
    rethrowAsSecureStoreError(error, subject, parent.path);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function stageTemporaryFile(
  temporaryPath: string,
  text: string,
  parent: SafeParent,
  subject: string,
): Promise<FileIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    // MANDATORY: the `mode` argument is ignored for an existing file and a
    // restrictive umask (0277) would otherwise yield 0400.
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    const info = await handle.stat();
    await assertOpenedFileIdentity(temporaryPath, info, subject);
    await assertSafeParentUnchanged(parent, subject);
    return { dev: info.dev, ino: info.ino };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Trailing marker every staging file carries. */
const TEMPORARY_FILE_SUFFIX = ".tmp";

/**
 * The one naming rule for staging files, shared by the writers and by
 * {@link removeOrphanedTemporaryFiles} so the producer and the matcher cannot
 * drift apart.
 */
function temporaryNamePrefix(temporaryId: string): string {
  return `.${temporaryId}.`;
}

function buildTemporaryPath(input: AtomicWriteInput): string {
  const suffix = (input.randomUUID ?? nodeRandomUUID)();
  return join(
    dirname(input.path),
    `${temporaryNamePrefix(input.temporaryId)}${suffix}${TEMPORARY_FILE_SUFFIX}`,
  );
}

/**
 * Creates a new owner-only file, failing when one already exists.
 *
 * Publication uses `link`, which is atomic and refuses to clobber, so two racing
 * enrollments cannot both believe they created the store.
 *
 * `link` does not consume the stage, so the second name is removed immediately
 * after publication and before the rename-sensitive durability window. The
 * `finally` remains as fallback cleanup for every earlier failure.
 *
 * @param input - Path, payload, subject and temporary-file discriminator.
 * @param onPublished - Non-throwing observer called immediately after `link`,
 *   before staging-name removal, post-publication verification, and durability checks.
 * @returns The identity of the published file.
 * @throws {SecureStoreError} `SECURE_STORE_VERSION_CONFLICT` when the target
 *   already exists, `SECURE_STORE_UNSAFE_PATH` for a symlink or hostile parent.
 */
export async function createPrivateFileAtomically(
  input: AtomicWriteInput,
  onPublished?: (identity: FileIdentity) => void,
): Promise<FileIdentity> {
  const parent = await prepareSafeParent(input.path, true, input.subject, input.finalParentPolicy);
  const temporaryPath = buildTemporaryPath(input);
  try {
    const identity = await stageTemporaryFile(temporaryPath, input.text, parent, input.subject);
    try {
      await link(temporaryPath, input.path);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw secureStoreError("SECURE_STORE_VERSION_CONFLICT", input.subject, input.path, error);
      }
      throw error;
    }
    onPublished?.(identity);
    await unlink(temporaryPath);
    await assertOpenedFileIdentity(input.path, identity, input.subject);
    await syncSafeParentDirectory(parent, input.subject);
    return identity;
  } catch (error) {
    rethrowAsSecureStoreError(error, input.subject, input.path);
  } finally {
    // Swallowed deliberately: by here the document is either published or the
    // real failure is already in flight, and neither may be masked by the
    // cleanup. A stage that survives this is handled by
    // `removeOrphanedTemporaryFiles`.
    await removeIfPresent(temporaryPath).catch(() => undefined);
  }
}

/**
 * Replaces an existing owner-only file with a new `0o600` inode.
 *
 * The rename is guarded on the syscall axis by `expectedIdentity`; callers layer
 * a monotonic version compare-and-swap on top of it, because inode identity
 * alone cannot detect an in-place same-inode rewrite by a non-conforming writer.
 *
 * @param input - Path, payload, subject, temporary-file discriminator and the
 *   identity captured under the lock.
 * @returns The identity of the newly published file.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when the target changed
 *   identity before the rename, or the parent directory moved.
 */
export async function replacePrivateFileAtomically(
  input: AtomicReplaceInput,
): Promise<FileIdentity> {
  const parent = await prepareSafeParent(input.path, false, input.subject, input.finalParentPolicy);
  const temporaryPath = buildTemporaryPath(input);
  try {
    const identity = await stageTemporaryFile(temporaryPath, input.text, parent, input.subject);
    await assertOpenedFileIdentity(input.path, input.expectedIdentity, input.subject);
    await rename(temporaryPath, input.path);
    await assertOpenedFileIdentity(input.path, identity, input.subject);
    await syncSafeParentDirectory(parent, input.subject);
    return identity;
  } catch (error) {
    rethrowAsSecureStoreError(error, input.subject, input.path);
  } finally {
    // A successful `rename` consumed the stage, so this is an `ENOENT` no-op on
    // the happy path and the cleanup on every other one.
    await removeIfPresent(temporaryPath).catch(() => undefined);
  }
}

/** Inputs for {@link removeOrphanedTemporaryFiles}. */
export interface OrphanedTemporarySweepInput {
  /** Absolute path of the published document whose stages are swept. */
  readonly path: string;
  /** The discriminator the writers were given as {@link AtomicWriteInput.temporaryId}. */
  readonly temporaryId: string;
  /** Short human name of the protected document. */
  readonly subject: string;
}

/**
 * Removes staging files stranded beside a document by a crash mid-publication.
 *
 * A staging file holds the whole payload at `0o600`, so for a credential
 * document it is a second copy of the secret. Only entries in the document's
 * OWN directory whose names match this module's staging rule for
 * `temporaryId` are considered — never a recursive walk, never a wider glob —
 * and only regular files: `readdir` reports each entry's own type, so a symlink
 * planted under a staging name is skipped rather than followed.
 *
 * A live stage is indistinguishable from an orphan here, so callers MUST hold
 * the document's exclusive lock: under it, no conforming writer can have one
 * open.
 *
 * @param input - Document path, staging discriminator and subject.
 * @returns Absolute paths of the staging files removed.
 * @throws {SecureStoreError} `SECURE_STORE_PERMISSIONS` or
 *   `SECURE_STORE_UNSAFE_PATH` when the directory or an orphan cannot be
 *   removed; a stage that survives is key material left on disk, never a
 *   silent partial success.
 */
export async function removeOrphanedTemporaryFiles(
  input: OrphanedTemporarySweepInput,
): Promise<readonly string[]> {
  const directory = dirname(input.path);
  const prefix = temporaryNamePrefix(input.temporaryId);
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    rethrowAsSecureStoreError(error, input.subject, directory);
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(TEMPORARY_FILE_SUFFIX)) continue;
    const orphan = join(directory, entry.name);
    try {
      await removeIfPresent(orphan);
    } catch (error) {
      rethrowAsSecureStoreError(error, input.subject, orphan);
    }
    removed.push(orphan);
  }
  return removed;
}
