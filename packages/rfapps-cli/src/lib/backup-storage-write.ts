import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { BackupManifest } from "../types/backup.js";
import { MAX_BACKUP_MANIFEST_BYTES, validateBackupManifest } from "./backup-schema.js";
import {
  assertRegularFileHandleIdentity,
  BackupStorageError,
  hasCode,
  normalizePath,
  pinDirectory,
  revalidatePinnedDirectory,
  storageError,
  syncPinnedDirectory,
  type BackupArtifactFile,
  type PinnedDirectory,
  type ReservedBackupBundle,
  type ValidatedBackupDestination,
} from "./backup-storage-shared.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PATH_BYTES = 4_096;
const ARTIFACT_PATH_PATTERN = /^artifacts\/[^/]+\.tar\.gz$/u;
const BUNDLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface BackupReservationDependencies {
  mkdir(path: string, options: { readonly mode: number }): Promise<void>;
}

const DEFAULT_RESERVATION_DEPENDENCIES: BackupReservationDependencies = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
};

export async function validateBackupDestination(
  inputPath: string,
): Promise<ValidatedBackupDestination> {
  const resolvedPath = normalizePath(inputPath);
  const inspected = await pinDirectory(resolvedPath);
  try {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && inspected.uid !== currentUid) {
      throw storageError(
        "BACKUP_DESTINATION_NOT_OWNED",
        "Backup destination must be owned by the current user",
        resolvedPath,
      );
    }
    if ((inspected.mode & 0o200) === 0) {
      throw storageError(
        "BACKUP_DESTINATION_NOT_WRITABLE",
        "Backup destination must be writable by its owner",
        resolvedPath,
      );
    }
    await access(resolvedPath, constants.W_OK);
    const canonicalPath = await realpath(resolvedPath);
    await revalidatePinnedDirectory(inspected);
    if (canonicalPath !== resolvedPath) {
      throw storageError(
        "BACKUP_PATH_UNSAFE",
        "Backup destination did not resolve to its inspected path",
        resolvedPath,
      );
    }
    return {
      path: canonicalPath,
      device: inspected.device,
      inode: inspected.inode,
    };
  } catch (error: unknown) {
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_DESTINATION_NOT_WRITABLE",
      "Backup destination could not be validated safely",
      resolvedPath,
      error,
    );
  } finally {
    await inspected.handle.close().catch(() => undefined);
  }
}

function validateBundleName(bundleName: string): string {
  if (
    !BUNDLE_NAME_PATTERN.test(bundleName) ||
    Buffer.byteLength(bundleName, "utf8") > MAX_PATH_BYTES ||
    bundleName === "." ||
    bundleName === ".."
  ) {
    throw storageError("BACKUP_PATH_INVALID", "Backup bundle name is invalid");
  }
  return bundleName;
}

async function pinValidatedDestination(
  destination: ValidatedBackupDestination,
): Promise<PinnedDirectory> {
  const pinned = await pinDirectory(destination.path, destination);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((currentUid !== undefined && pinned.uid !== currentUid) || (pinned.mode & 0o200) === 0) {
    await pinned.handle.close().catch(() => undefined);
    throw storageError(
      "BACKUP_PATH_UNSAFE",
      "Backup destination permissions changed after validation",
      destination.path,
    );
  }
  return pinned;
}

export async function reserveBackupBundle(
  destination: ValidatedBackupDestination,
  bundleName: string,
  dependencies: BackupReservationDependencies = DEFAULT_RESERVATION_DEPENDENCIES,
): Promise<ReservedBackupBundle> {
  const bundlePath = join(destination.path, validateBundleName(bundleName));
  const artifactsPath = join(bundlePath, "artifacts");
  const destinationDirectory = await pinValidatedDestination(destination);
  let bundleCreated = false;
  let bundleDirectory: PinnedDirectory | undefined;
  let artifactsDirectory: PinnedDirectory | undefined;
  try {
    await revalidatePinnedDirectory(destinationDirectory);
    // Node has no mkdirat. Keep the validated destination handle open, open
    // each new directory with O_NOFOLLOW before fchmod, and immediately verify
    // every path against its pinned handle on both sides of the next mutation.
    await dependencies.mkdir(bundlePath, { mode: PRIVATE_DIRECTORY_MODE });
    bundleCreated = true;
    bundleDirectory = await pinDirectory(bundlePath);
    await bundleDirectory.handle.chmod(PRIVATE_DIRECTORY_MODE);
    await revalidatePinnedDirectory(destinationDirectory);
    await revalidatePinnedDirectory(bundleDirectory);
    await dependencies.mkdir(artifactsPath, { mode: PRIVATE_DIRECTORY_MODE });
    artifactsDirectory = await pinDirectory(artifactsPath);
    await artifactsDirectory.handle.chmod(PRIVATE_DIRECTORY_MODE);
    await revalidatePinnedDirectory(destinationDirectory);
    await revalidatePinnedDirectory(bundleDirectory);
    await revalidatePinnedDirectory(artifactsDirectory);
    await syncPinnedDirectory(artifactsDirectory);
    await syncPinnedDirectory(bundleDirectory);
    await syncPinnedDirectory(destinationDirectory);
    return {
      destinationPath: destination.path,
      destinationDevice: destinationDirectory.device,
      destinationInode: destinationDirectory.inode,
      bundlePath,
      artifactsPath,
      manifestPath: join(bundlePath, "manifest.json"),
      device: bundleDirectory.device,
      inode: bundleDirectory.inode,
      artifactsDevice: artifactsDirectory.device,
      artifactsInode: artifactsDirectory.inode,
    };
  } catch (error: unknown) {
    // Node has no descriptor-relative recursive deletion primitive. Retain any
    // private manifest-less reservation instead of deleting a substituted path.
    if (!bundleCreated && hasCode(error, "EEXIST")) {
      throw storageError("BACKUP_BUNDLE_EXISTS", "Backup bundle already exists", bundlePath);
    }
    const retainedReservation = bundleCreated
      ? ({ bundlePath, stagingDisposition: "retained-incomplete" } as const)
      : undefined;
    if (error instanceof BackupStorageError) {
      throw storageError(error.code, error.message, error.path, error, retainedReservation);
    }
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup bundle could not be reserved",
      bundlePath,
      error,
      retainedReservation,
    );
  } finally {
    await artifactsDirectory?.handle.close().catch(() => undefined);
    await bundleDirectory?.handle.close().catch(() => undefined);
    await destinationDirectory.handle.close().catch(() => undefined);
  }
}

async function pinBundleRoot(bundle: ReservedBackupBundle): Promise<PinnedDirectory> {
  return pinDirectory(bundle.bundlePath, {
    device: bundle.device,
    inode: bundle.inode,
  });
}

async function pinBundleDestination(bundle: ReservedBackupBundle): Promise<PinnedDirectory> {
  return pinDirectory(bundle.destinationPath, {
    device: bundle.destinationDevice,
    inode: bundle.destinationInode,
  });
}

async function pinBundleDirectories(
  bundle: ReservedBackupBundle,
): Promise<{ readonly root: PinnedDirectory; readonly artifacts: PinnedDirectory }> {
  const root = await pinBundleRoot(bundle);
  try {
    const artifacts = await pinDirectory(bundle.artifactsPath, {
      device: bundle.artifactsDevice,
      inode: bundle.artifactsInode,
    });
    await revalidatePinnedDirectory(root);
    return { root, artifacts };
  } catch (error: unknown) {
    await root.handle.close().catch(() => undefined);
    throw error;
  }
}

function validateArtifactPath(relativePath: string): string {
  if (
    isAbsolute(relativePath) ||
    !ARTIFACT_PATH_PATTERN.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw storageError("BACKUP_PATH_INVALID", "Backup artifact path is invalid");
  }
  return relativePath;
}

export async function createBackupArtifact(
  bundle: ReservedBackupBundle,
  relativePath: string,
): Promise<BackupArtifactFile> {
  const safeRelativePath = validateArtifactPath(relativePath);
  const artifactPath = join(bundle.bundlePath, safeRelativePath);
  if (dirname(artifactPath) !== bundle.artifactsPath) {
    throw storageError("BACKUP_PATH_UNSAFE", "Backup artifact escaped its directory", artifactPath);
  }
  const directories = await pinBundleDirectories(bundle);
  let handle: FileHandle | undefined;
  try {
    await revalidatePinnedDirectory(directories.root);
    await revalidatePinnedDirectory(directories.artifacts);
    handle = await open(
      artifactPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.chmod(PRIVATE_FILE_MODE);
    await assertRegularFileHandleIdentity(
      artifactPath,
      handle,
      "Backup artifact changed while it was being created",
    );
    await revalidatePinnedDirectory(directories.root);
    await revalidatePinnedDirectory(directories.artifacts);
    return {
      relativePath: safeRelativePath,
      path: artifactPath,
      handle,
      parentPath: directories.artifacts.path,
      parentDevice: directories.artifacts.device,
      parentInode: directories.artifacts.inode,
    };
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (hasCode(error, "EEXIST")) {
      throw storageError("BACKUP_FILE_EXISTS", "Backup artifact already exists", artifactPath);
    }
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup artifact could not be created",
      artifactPath,
      error,
    );
  } finally {
    await directories.artifacts.handle.close().catch(() => undefined);
    await directories.root.handle.close().catch(() => undefined);
  }
}

async function pinArtifactParent(artifact: BackupArtifactFile): Promise<PinnedDirectory> {
  try {
    return await pinDirectory(artifact.parentPath, {
      device: artifact.parentDevice,
      inode: artifact.parentInode,
    });
  } catch (error: unknown) {
    await artifact.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function finalizeBackupArtifact(artifact: BackupArtifactFile): Promise<void> {
  const parent = await pinArtifactParent(artifact);
  try {
    await revalidatePinnedDirectory(parent);
    await assertRegularFileHandleIdentity(
      artifact.path,
      artifact.handle,
      "Backup artifact changed before finalization",
    );
    await artifact.handle.chmod(PRIVATE_FILE_MODE);
    await artifact.handle.sync();
    await assertRegularFileHandleIdentity(
      artifact.path,
      artifact.handle,
      "Backup artifact changed during finalization",
    );
    await syncPinnedDirectory(parent);
    await artifact.handle.close();
  } catch (error: unknown) {
    await artifact.handle.close().catch(() => undefined);
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup artifact could not be finalized",
      artifact.path,
      error,
    );
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

export async function discardBackupArtifact(artifact: BackupArtifactFile): Promise<void> {
  const parent = await pinArtifactParent(artifact);
  try {
    await revalidatePinnedDirectory(parent);
    await assertRegularFileHandleIdentity(
      artifact.path,
      artifact.handle,
      "Backup artifact changed before it could be discarded",
    );
    // Node exposes no unlinkat. Keep the trusted parent and file handles open,
    // recheck both immediately before the narrow path-based unlink, then sync
    // the pinned parent handle.
    await revalidatePinnedDirectory(parent);
    await assertRegularFileHandleIdentity(
      artifact.path,
      artifact.handle,
      "Backup artifact changed before it could be discarded",
    );
    await unlink(artifact.path);
    await parent.handle.sync();
    await revalidatePinnedDirectory(parent);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return;
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup artifact could not be discarded",
      artifact.path,
      error,
    );
  } finally {
    await artifact.handle.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
}

export async function publishBackupManifest(
  bundle: ReservedBackupBundle,
  manifest: BackupManifest,
): Promise<string> {
  const validated = validateBackupManifest(manifest);
  const content = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
  if (content.byteLength > MAX_BACKUP_MANIFEST_BYTES) {
    throw storageError(
      "BACKUP_FILE_TOO_LARGE",
      "Backup manifest exceeds the supported size",
      bundle.manifestPath,
    );
  }
  const temporaryPath = join(bundle.bundlePath, `.manifest.${randomUUID()}.tmp`);
  const destination = await pinBundleDestination(bundle);
  const directories = await pinBundleDirectories(bundle).catch(async (error: unknown) => {
    await destination.handle.close().catch(() => undefined);
    throw error;
  });
  let handle: FileHandle | undefined;
  let published = false;
  try {
    await revalidatePinnedDirectory(destination);
    await revalidatePinnedDirectory(directories.root);
    await revalidatePinnedDirectory(directories.artifacts);
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await assertRegularFileHandleIdentity(
      temporaryPath,
      handle,
      "Temporary backup manifest changed before publication",
    );
    await syncPinnedDirectory(directories.artifacts);
    await revalidatePinnedDirectory(destination);
    await revalidatePinnedDirectory(directories.root);
    // Node has no linkat. Trusted directory handles remain open and every
    // path/handle identity is checked immediately before and after this link.
    await link(temporaryPath, bundle.manifestPath);
    published = true;
    await assertRegularFileHandleIdentity(
      bundle.manifestPath,
      handle,
      "Published backup manifest did not match its trusted file handle",
    );
    await revalidatePinnedDirectory(destination);
    await revalidatePinnedDirectory(directories.root);
    await revalidatePinnedDirectory(directories.artifacts);
    await assertRegularFileHandleIdentity(
      temporaryPath,
      handle,
      "Temporary backup manifest changed during publication",
    );
    await unlink(temporaryPath);
    await assertRegularFileHandleIdentity(
      bundle.manifestPath,
      handle,
      "Published backup manifest changed during publication",
    );
    await syncPinnedDirectory(directories.root);
    await syncPinnedDirectory(destination);
    return bundle.manifestPath;
  } catch (error: unknown) {
    if (handle !== undefined) {
      await unlinkPathOnlyIfMatchingHandle(temporaryPath, handle);
    }
    if (published) {
      if (handle !== undefined) {
        await unlinkPathOnlyIfMatchingHandle(bundle.manifestPath, handle);
      }
      await directories.root.handle.sync().catch(() => undefined);
    }
    if (hasCode(error, "EEXIST")) {
      throw storageError(
        "BACKUP_MANIFEST_EXISTS",
        "Backup manifest already exists",
        bundle.manifestPath,
      );
    }
    if (error instanceof BackupStorageError) throw error;
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup manifest could not be published",
      bundle.manifestPath,
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await directories.artifacts.handle.close().catch(() => undefined);
    await directories.root.handle.close().catch(() => undefined);
    await destination.handle.close().catch(() => undefined);
  }
}

async function unlinkPathOnlyIfMatchingHandle(path: string, handle: FileHandle): Promise<void> {
  try {
    await assertRegularFileHandleIdentity(
      path,
      handle,
      "Backup publication path changed before cleanup",
    );
    await unlink(path);
  } catch {
    // Fail closed: never unlink a path that no longer names the trusted inode.
  }
}

async function manifestExists(bundle: ReservedBackupBundle): Promise<boolean> {
  try {
    await lstat(bundle.manifestPath);
    return true;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return false;
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Backup manifest state could not be inspected",
      bundle.manifestPath,
      error,
    );
  }
}

async function pinIncompleteBundle(bundle: ReservedBackupBundle): Promise<PinnedDirectory> {
  const root = await pinBundleRoot(bundle);
  try {
    await revalidatePinnedDirectory(root);
    if (await manifestExists(bundle)) {
      throw storageError(
        "BACKUP_BUNDLE_COMPLETE",
        "A published backup bundle cannot be treated as incomplete",
        bundle.bundlePath,
      );
    }
    await revalidatePinnedDirectory(root);
    return root;
  } catch (error: unknown) {
    await root.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function removeIncompleteBackupBundle(bundle: ReservedBackupBundle): Promise<void> {
  let root: PinnedDirectory;
  try {
    root = await pinIncompleteBundle(bundle);
  } catch (error: unknown) {
    if (error instanceof BackupStorageError && error.code === "BACKUP_PATH_NOT_FOUND") return;
    throw error;
  }
  try {
    await revalidatePinnedDirectory(root);
    throw storageError(
      "BACKUP_STORAGE_IO",
      "Incomplete backup bundle was retained because safe automatic removal is unavailable",
      bundle.bundlePath,
    );
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

export async function retainIncompleteBackupBundle(bundle: ReservedBackupBundle): Promise<string> {
  const root = await pinIncompleteBundle(bundle);
  try {
    await revalidatePinnedDirectory(root);
    return bundle.bundlePath;
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}
