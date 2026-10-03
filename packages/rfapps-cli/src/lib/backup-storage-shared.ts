import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

const MAX_PATH_BYTES = 4_096;

export type BackupStorageErrorCode =
  | "BACKUP_PATH_INVALID"
  | "BACKUP_PATH_UNSAFE"
  | "BACKUP_PATH_NOT_FOUND"
  | "BACKUP_DESTINATION_UNSAFE"
  | "BACKUP_DESTINATION_NOT_OWNED"
  | "BACKUP_DESTINATION_NOT_WRITABLE"
  | "BACKUP_BUNDLE_EXISTS"
  | "BACKUP_BUNDLE_COMPLETE"
  | "BACKUP_FILE_EXISTS"
  | "BACKUP_FILE_NOT_REGULAR"
  | "BACKUP_FILE_TOO_LARGE"
  | "BACKUP_DIRECTORY_LIMIT_EXCEEDED"
  | "BACKUP_MANIFEST_EXISTS"
  | "BACKUP_STORAGE_IO";

export interface RetainedBackupReservation {
  readonly bundlePath: string;
  readonly stagingDisposition: "retained-incomplete";
}

export class BackupStorageError extends Error {
  override readonly name = "BackupStorageError";

  constructor(
    readonly code: BackupStorageErrorCode,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
    readonly retainedReservation?: RetainedBackupReservation,
  ) {
    super(message.slice(0, 4_096), options);
  }
}

export interface ValidatedBackupDestination {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface ReservedBackupBundle {
  readonly destinationPath: string;
  readonly destinationDevice: number;
  readonly destinationInode: number;
  readonly bundlePath: string;
  readonly artifactsPath: string;
  readonly manifestPath: string;
  readonly device: number;
  readonly inode: number;
  readonly artifactsDevice: number;
  readonly artifactsInode: number;
}

export interface BackupArtifactFile {
  readonly relativePath: string;
  readonly path: string;
  readonly handle: FileHandle;
  readonly parentPath: string;
  readonly parentDevice: number;
  readonly parentInode: number;
}

export interface OpenBackupRegularFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly size: number;
}

export interface PinnedDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
  readonly uid: number;
  readonly mode: number;
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function storageError(
  code: BackupStorageErrorCode,
  message: string,
  path?: string,
  cause?: unknown,
  retainedReservation?: RetainedBackupReservation,
): BackupStorageError {
  return new BackupStorageError(
    code,
    message,
    path,
    cause === undefined ? undefined : { cause },
    retainedReservation,
  );
}

export function normalizePath(inputPath: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.includes("\0") ||
    Buffer.byteLength(inputPath, "utf8") > MAX_PATH_BYTES
  ) {
    throw storageError("BACKUP_PATH_INVALID", "Backup path must be a bounded non-empty path");
  }
  return resolve(inputPath);
}

function pathComponents(inputPath: string): string[] {
  const absolutePath = normalizePath(inputPath);
  const root = parse(absolutePath).root;
  const components: string[] = [];
  let cursor = absolutePath;
  while (cursor !== root) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.push(root);
  return components.reverse();
}

export async function assertNoSymlinkComponents(inputPath: string): Promise<void> {
  const absolutePath = normalizePath(inputPath);
  for (const component of pathComponents(absolutePath)) {
    try {
      const pathStat = await lstat(component);
      if (pathStat.isSymbolicLink()) {
        throw storageError(
          "BACKUP_PATH_UNSAFE",
          "Backup path contains a symbolic-link component",
          absolutePath,
        );
      }
    } catch (error: unknown) {
      if (error instanceof BackupStorageError) throw error;
      if (hasCode(error, "ENOENT")) {
        throw storageError("BACKUP_PATH_NOT_FOUND", "Backup path does not exist", absolutePath);
      }
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup path could not be inspected safely",
        absolutePath,
        error,
      );
    }
  }
}

async function openDirectory(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      throw storageError("BACKUP_PATH_NOT_FOUND", "Backup directory does not exist", path);
    }
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup directory could not be opened safely",
      path,
      error,
    );
  }
}

export async function pinDirectory(
  path: string,
  expected?: { readonly device: number; readonly inode: number },
): Promise<PinnedDirectory> {
  await assertNoSymlinkComponents(path);
  const pathStat = await lstat(path);
  if (!pathStat.isDirectory()) {
    throw storageError(
      "BACKUP_DESTINATION_UNSAFE",
      "Backup destination must be an existing real directory",
      path,
    );
  }
  const handle = await openDirectory(path);
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      (expected !== undefined &&
        (openedStat.dev !== expected.device || openedStat.ino !== expected.inode))
    ) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup directory changed while it was being opened",
        path,
      );
    }
    return {
      path,
      handle,
      device: openedStat.dev,
      inode: openedStat.ino,
      uid: openedStat.uid,
      mode: openedStat.mode,
    };
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function revalidatePinnedDirectory(directory: PinnedDirectory): Promise<void> {
  try {
    await assertNoSymlinkComponents(directory.path);
    const pathStat = await lstat(directory.path);
    const openedStat = await directory.handle.stat();
    if (
      !pathStat.isDirectory() ||
      !openedStat.isDirectory() ||
      pathStat.dev !== directory.device ||
      pathStat.ino !== directory.inode ||
      openedStat.dev !== directory.device ||
      openedStat.ino !== directory.inode
    ) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup directory changed during a storage operation",
        directory.path,
      );
    }
  } catch (error: unknown) {
    if (error instanceof BackupStorageError) {
      if (error.code !== "BACKUP_PATH_NOT_FOUND") throw error;
    } else if (!hasCode(error, "ENOENT")) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup directory could not be revalidated safely",
        directory.path,
        error,
      );
    }
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup directory changed during a storage operation",
      directory.path,
    );
  }
}

export async function syncPinnedDirectory(directory: PinnedDirectory): Promise<void> {
  await revalidatePinnedDirectory(directory);
  try {
    await directory.handle.sync();
  } catch (error: unknown) {
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup directory could not be synced",
      directory.path,
      error,
    );
  }
  await revalidatePinnedDirectory(directory);
}

export async function assertRegularFileHandleIdentity(
  path: string,
  handle: FileHandle,
  message: string,
): Promise<void> {
  const pathStat = await lstat(path);
  const openedStat = await handle.stat();
  if (
    !pathStat.isFile() ||
    !openedStat.isFile() ||
    pathStat.dev !== openedStat.dev ||
    pathStat.ino !== openedStat.ino
  ) {
    throw storageError("BACKUP_PATH_UNSAFE", message, path);
  }
}
