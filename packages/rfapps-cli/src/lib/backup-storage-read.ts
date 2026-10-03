import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { BackupManifest } from "../types/backup.js";
import {
  BackupSchemaError,
  MAX_BACKUP_MANIFEST_ENTRIES,
  MAX_BACKUP_MANIFEST_BYTES,
  parseBackupManifestJson,
} from "./backup-schema.js";
import {
  assertNoSymlinkComponents,
  assertRegularFileHandleIdentity,
  BackupStorageError,
  hasCode,
  normalizePath,
  pinDirectory,
  revalidatePinnedDirectory,
  storageError,
  type OpenBackupRegularFile,
  type PinnedDirectory,
} from "./backup-storage-shared.js";

export async function openBackupRegularFile(
  inputPath: string,
  maximumBytes?: number,
): Promise<OpenBackupRegularFile> {
  const path = normalizePath(inputPath);
  await assertNoSymlinkComponents(path);
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      throw storageError("BACKUP_PATH_NOT_FOUND", "Backup file does not exist", path);
    }
    throw storageError("BACKUP_PATH_UNSAFE", "Backup file could not be inspected", path, error);
  }
  if (!pathStat.isFile()) {
    throw storageError("BACKUP_FILE_NOT_REGULAR", "Backup file must be a regular file", path);
  }
  if (maximumBytes !== undefined && pathStat.size > maximumBytes) {
    throw storageError("BACKUP_FILE_TOO_LARGE", "Backup file exceeds the size limit", path);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup file changed while it was being opened",
        path,
      );
    }
    if (maximumBytes !== undefined && openedStat.size > maximumBytes) {
      throw storageError("BACKUP_FILE_TOO_LARGE", "Backup file exceeds the size limit", path);
    }
    return { path, handle, size: openedStat.size };
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BackupStorageError) throw error;
    throw storageError("BACKUP_PATH_UNSAFE", "Backup file could not be opened safely", path, error);
  }
}

export async function revalidateBackupRegularFile(opened: OpenBackupRegularFile): Promise<void> {
  try {
    await assertNoSymlinkComponents(opened.path);
    const pathStat = await lstat(opened.path);
    const openedStat = await opened.handle.stat();
    if (
      !pathStat.isFile() ||
      !openedStat.isFile() ||
      pathStat.dev !== openedStat.dev ||
      pathStat.ino !== openedStat.ino ||
      openedStat.size !== opened.size
    ) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup file changed while it was being read",
        opened.path,
      );
    }
  } catch (error: unknown) {
    if (error instanceof BackupStorageError) {
      if (error.code !== "BACKUP_PATH_NOT_FOUND") throw error;
    } else if (!hasCode(error, "ENOENT")) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup file could not be revalidated safely",
        opened.path,
        error,
      );
    }
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup file changed while it was being read",
      opened.path,
    );
  }
}

export async function listBackupRegularArtifacts(bundlePath: string): Promise<string[]> {
  const artifactsPath = join(normalizePath(bundlePath), "artifacts");
  try {
    const pinned = await pinDirectory(artifactsPath);
    try {
      await countArtifactDirectoryEntries(pinned);
      const artifacts: string[] = [];
      const directory = await opendir(artifactsPath);
      let count = 0;
      try {
        for await (const entry of directory) {
          count += 1;
          if (count > MAX_BACKUP_MANIFEST_ENTRIES) {
            throw storageError(
              "BACKUP_DIRECTORY_LIMIT_EXCEEDED",
              "Backup artifacts directory exceeds the entry limit",
              artifactsPath,
            );
          }
          await revalidatePinnedDirectory(pinned);
          const candidatePath = join(artifactsPath, entry.name);
          if (await isNofollowRegularFile(candidatePath)) {
            artifacts.push(`artifacts/${entry.name}`);
          }
          await revalidatePinnedDirectory(pinned);
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      await revalidatePinnedDirectory(pinned);
      return artifacts.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    } finally {
      await pinned.handle.close().catch(() => undefined);
    }
  } catch (error: unknown) {
    if (error instanceof BackupStorageError && error.code === "BACKUP_PATH_NOT_FOUND") return [];
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup artifacts directory could not be listed safely",
      artifactsPath,
      error,
    );
  }
}

async function countArtifactDirectoryEntries(directory: PinnedDirectory): Promise<void> {
  await revalidatePinnedDirectory(directory);
  const entries = await opendir(directory.path);
  let count = 0;
  try {
    for await (const _entry of entries) {
      count += 1;
      if (count > MAX_BACKUP_MANIFEST_ENTRIES) {
        throw storageError(
          "BACKUP_DIRECTORY_LIMIT_EXCEEDED",
          "Backup artifacts directory exceeds the entry limit",
          directory.path,
        );
      }
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
  await revalidatePinnedDirectory(directory);
}

async function isNofollowRegularFile(path: string): Promise<boolean> {
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error: unknown) {
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup artifact candidate changed during discovery",
      path,
      error,
    );
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) return false;

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup artifact candidate changed while it was being opened",
        path,
      );
    }
    await assertRegularFileHandleIdentity(
      path,
      handle,
      "Backup artifact candidate changed during discovery",
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup artifact candidate could not be opened safely",
      path,
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBackupManifest(
  manifestPath: string,
): Promise<{ readonly manifest: BackupManifest; readonly manifestPath: string }> {
  let opened: OpenBackupRegularFile;
  try {
    opened = await openBackupRegularFile(manifestPath, MAX_BACKUP_MANIFEST_BYTES);
  } catch (error: unknown) {
    if (error instanceof BackupStorageError && error.code === "BACKUP_FILE_TOO_LARGE") {
      throw new BackupSchemaError(
        "BACKUP_SCHEMA_TOO_LARGE",
        "Backup manifest exceeds the size limit",
      );
    }
    throw error;
  }
  try {
    const bytes = Buffer.alloc(MAX_BACKUP_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await opened.handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_BACKUP_MANIFEST_BYTES) {
      throw new BackupSchemaError(
        "BACKUP_SCHEMA_TOO_LARGE",
        "Backup manifest exceeds the size limit",
      );
    }
    await revalidateBackupRegularFile(opened);
    return {
      manifest: parseBackupManifestJson(bytes.subarray(0, offset)),
      manifestPath: opened.path,
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
