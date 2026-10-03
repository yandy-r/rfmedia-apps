import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { getDefaultDatabasePath } from "./db.js";

const LOCK_DIRECTORY_NAME = "locks";
const LOCK_SCHEMA_VERSION = 1;
const MAX_CONTEXT_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_METADATA_BYTES = 8192;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type LifecycleLockErrorCode =
  | "LOCK_HELD"
  | "LOCK_STALE"
  | "LOCK_METADATA_INVALID"
  | "LOCK_PATH_UNSAFE"
  | "LOCK_IO_ERROR";

export interface LifecycleLockOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly projectPath: string;
  readonly dockerContext: string;
}

interface LifecycleLockMetadata extends LifecycleLockOwner {
  readonly schemaVersion: typeof LOCK_SCHEMA_VERSION;
  readonly ownerToken: string;
}

export class LifecycleLockError extends Error {
  override readonly name = "LifecycleLockError";

  constructor(
    message: string,
    readonly code: LifecycleLockErrorCode,
    readonly lockPath?: string,
    readonly owner?: LifecycleLockOwner,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AcquireLifecycleLockOptions {
  readonly projectPath: string;
  readonly dockerContext: string;
  /** Effective Compose project name, when the lifecycle is project-scoped. */
  readonly composeProjectName?: string;
  /** Parent state directory. Locks are stored in its private `locks` child. */
  readonly stateDir?: string;
  /** Test seam for the lock owner PID. */
  readonly pid?: number;
  /** Test seam for deterministic owner timestamps. */
  readonly now?: () => Date;
  /** Test seam for determining whether an existing lock owner is still running. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface LifecycleLock {
  readonly path: string;
  readonly owner: LifecycleLockOwner;
  release(): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function ioError(
  message: string,
  lockPath: string | undefined,
  cause: unknown,
): LifecycleLockError {
  return new LifecycleLockError(message, "LOCK_IO_ERROR", lockPath, undefined, { cause });
}

function unsafePath(message: string, lockPath?: string, cause?: unknown): LifecycleLockError {
  return new LifecycleLockError(message, "LOCK_PATH_UNSAFE", lockPath, undefined, { cause });
}

function validateInputPath(path: string, field: string): void {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes("\0")) {
    throw unsafePath(`${field} must be a non-empty, bounded filesystem path`);
  }
}

function validateDockerContext(dockerContext: string): void {
  if (
    dockerContext.length === 0 ||
    dockerContext.length > MAX_CONTEXT_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(dockerContext)
  ) {
    throw new LifecycleLockError(
      "Docker context must be non-empty, bounded, and contain no control characters",
      "LOCK_METADATA_INVALID",
    );
  }
}

function validateComposeProjectName(projectName: string | undefined): void {
  if (projectName !== undefined && !/^[a-z0-9][a-z0-9_-]*$/u.test(projectName)) {
    throw new LifecycleLockError("Compose project name is invalid", "LOCK_METADATA_INVALID");
  }
}

async function canonicalizeProjectPath(projectPath: string): Promise<string> {
  validateInputPath(projectPath, "Project path");

  try {
    const canonicalPath = await realpath(projectPath);
    const projectStat = await stat(canonicalPath);
    if (!projectStat.isDirectory()) {
      throw unsafePath("Project path must resolve to a directory");
    }
    if (canonicalPath.length > MAX_PATH_LENGTH) {
      throw unsafePath("Canonical project path exceeds the supported length");
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof LifecycleLockError) {
      throw error;
    }
    throw unsafePath("Project path cannot be resolved safely", undefined, error);
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components: string[] = [];
  let cursor = absolutePath;

  while (cursor !== root) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.push(root);

  for (const component of components.reverse()) {
    try {
      const componentStat = await lstat(component);
      if (componentStat.isSymbolicLink()) {
        throw unsafePath(`Lifecycle lock state path contains a symbolic link: ${component}`);
      }
    } catch (error) {
      if (error instanceof LifecycleLockError) {
        throw error;
      }
      if (!hasCode(error, "ENOENT")) {
        throw unsafePath(
          `Lifecycle lock state path cannot be inspected: ${component}`,
          undefined,
          error,
        );
      }
    }
  }
}

async function ensurePrivateLockDirectory(stateDir: string): Promise<string> {
  validateInputPath(stateDir, "State directory");
  const absoluteStateDir = resolve(stateDir);
  const lockDir = join(absoluteStateDir, LOCK_DIRECTORY_NAME);

  await assertNoSymlinkComponents(lockDir);
  try {
    await mkdir(lockDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    throw ioError("Unable to create the lifecycle lock directory", lockDir, error);
  }
  await assertNoSymlinkComponents(lockDir);

  let lockDirStat;
  try {
    lockDirStat = await lstat(lockDir);
  } catch (error) {
    throw ioError("Unable to inspect the lifecycle lock directory", lockDir, error);
  }

  if (!lockDirStat.isDirectory() || lockDirStat.isSymbolicLink()) {
    throw unsafePath("Lifecycle lock path is not a real directory", lockDir);
  }
  if ((lockDirStat.mode & 0o077) !== 0) {
    throw unsafePath(
      "Lifecycle lock directory must not be accessible by group or other users",
      lockDir,
    );
  }
  if (typeof process.getuid === "function" && lockDirStat.uid !== process.getuid()) {
    throw unsafePath("Lifecycle lock directory must be owned by the current user", lockDir);
  }

  return lockDir;
}

function lockFileName(
  projectPath: string,
  dockerContext: string,
  composeProjectName: string | undefined,
): string {
  const key = createHash("sha256")
    .update(projectPath)
    .update("\0")
    .update(dockerContext)
    .update("\0")
    .update(composeProjectName ?? "")
    .digest("hex");
  return `lifecycle-${key}.lock`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(
  content: string,
  expectedProjectPath: string,
  expectedDockerContext: string,
): LifecycleLockMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const expectedKeys = [
    "dockerContext",
    "ownerToken",
    "pid",
    "projectPath",
    "schemaVersion",
    "startedAt",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    return undefined;
  }

  const { schemaVersion, pid, startedAt, projectPath, dockerContext, ownerToken } = value;
  if (
    schemaVersion !== LOCK_SCHEMA_VERSION ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof startedAt !== "string" ||
    startedAt.length > 40 ||
    !Number.isFinite(Date.parse(startedAt)) ||
    typeof projectPath !== "string" ||
    projectPath.length === 0 ||
    projectPath.length > MAX_PATH_LENGTH ||
    projectPath !== expectedProjectPath ||
    typeof dockerContext !== "string" ||
    dockerContext.length === 0 ||
    dockerContext.length > MAX_CONTEXT_LENGTH ||
    dockerContext !== expectedDockerContext ||
    typeof ownerToken !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(ownerToken)
  ) {
    return undefined;
  }

  return {
    schemaVersion,
    pid,
    startedAt,
    projectPath,
    dockerContext,
    ownerToken,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function readExistingLock(
  lockPath: string,
  expectedProjectPath: string,
  expectedDockerContext: string,
): Promise<LifecycleLockMetadata> {
  let handle: FileHandle | undefined;
  try {
    const lockStat = await lstat(lockPath);
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
      throw unsafePath(
        "Lifecycle lock path must be a regular file and not a symbolic link",
        lockPath,
      );
    }
    if ((lockStat.mode & 0o077) !== 0) {
      throw unsafePath(
        "Lifecycle lock file must not be accessible by group or other users",
        lockPath,
      );
    }
    if (lockStat.size > MAX_METADATA_BYTES) {
      throw new LifecycleLockError(
        "Lifecycle lock metadata exceeds the supported size; refusing automatic takeover",
        "LOCK_METADATA_INVALID",
        lockPath,
      );
    }

    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const content = await handle.readFile("utf-8");
    if (Buffer.byteLength(content, "utf-8") > MAX_METADATA_BYTES) {
      throw new LifecycleLockError(
        "Lifecycle lock metadata exceeds the supported size; refusing automatic takeover",
        "LOCK_METADATA_INVALID",
        lockPath,
      );
    }

    const metadata = parseMetadata(content, expectedProjectPath, expectedDockerContext);
    if (metadata === undefined) {
      throw new LifecycleLockError(
        "Lifecycle lock metadata is invalid; refusing automatic takeover",
        "LOCK_METADATA_INVALID",
        lockPath,
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof LifecycleLockError) {
      throw error;
    }
    if (hasCode(error, "ELOOP")) {
      throw unsafePath("Lifecycle lock path resolves through a symbolic link", lockPath, error);
    }
    throw ioError("Unable to inspect the existing lifecycle lock", lockPath, error);
  } finally {
    await handle?.close();
  }
}

async function removeOwnedLock(lockPath: string, handle: FileHandle): Promise<void> {
  const ownedStat = await handle.stat();
  try {
    const pathStat = await lstat(lockPath);
    if (pathStat.dev !== ownedStat.dev || pathStat.ino !== ownedStat.ino) {
      throw unsafePath("Lifecycle lock path changed ownership before release", lockPath);
    }
    await unlink(lockPath);
  } catch (error) {
    if (error instanceof LifecycleLockError) {
      throw error;
    }
    if (!hasCode(error, "ENOENT")) {
      throw ioError("Unable to release the lifecycle lock", lockPath, error);
    }
  }
}

async function contentionError(
  lockPath: string,
  projectPath: string,
  dockerContext: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<LifecycleLockError> {
  const metadata = await readExistingLock(lockPath, projectPath, dockerContext);
  const owner: LifecycleLockOwner = {
    pid: metadata.pid,
    startedAt: metadata.startedAt,
    projectPath: metadata.projectPath,
    dockerContext: metadata.dockerContext,
  };

  if (isProcessAlive(metadata.pid)) {
    return new LifecycleLockError(
      `Lifecycle lock is held by PID ${metadata.pid} since ${metadata.startedAt}`,
      "LOCK_HELD",
      lockPath,
      owner,
    );
  }

  return new LifecycleLockError(
    `Lifecycle lock appears stale for PID ${metadata.pid}; refusing automatic takeover. ` +
      `Remove ${lockPath} only after verifying that no lifecycle operation is active.`,
    "LOCK_STALE",
    lockPath,
    owner,
  );
}

export async function acquireLifecycleLock(
  options: AcquireLifecycleLockOptions,
): Promise<LifecycleLock> {
  validateDockerContext(options.dockerContext);
  validateComposeProjectName(options.composeProjectName);
  const projectPath = await canonicalizeProjectPath(options.projectPath);
  const defaultStateDir = dirname(getDefaultDatabasePath());
  const stateDir = options.stateDir ?? defaultStateDir;
  const lockDir = await ensurePrivateLockDirectory(stateDir);
  const lockPath = join(
    lockDir,
    lockFileName(projectPath, options.dockerContext, options.composeProjectName),
  );
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new LifecycleLockError("Lifecycle lock owner PID is invalid", "LOCK_METADATA_INVALID");
  }

  const startedAt = now().toISOString();
  const metadata: LifecycleLockMetadata = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid,
    startedAt,
    projectPath,
    dockerContext: options.dockerContext,
    ownerToken: randomUUID(),
  };
  const content = `${JSON.stringify(metadata)}\n`;
  if (Buffer.byteLength(content, "utf-8") > MAX_METADATA_BYTES) {
    throw new LifecycleLockError(
      "Lifecycle lock metadata exceeds the supported size",
      "LOCK_METADATA_INVALID",
      lockPath,
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw await contentionError(lockPath, projectPath, options.dockerContext, isProcessAlive);
    }
    if (hasCode(error, "ELOOP")) {
      throw unsafePath("Lifecycle lock path resolves through a symbolic link", lockPath, error);
    }
    throw ioError("Unable to acquire the lifecycle lock", lockPath, error);
  }

  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } catch (error) {
    try {
      await removeOwnedLock(lockPath, handle);
    } finally {
      await handle.close();
    }
    throw ioError("Unable to write lifecycle lock metadata", lockPath, error);
  }

  const owner: LifecycleLockOwner = {
    pid,
    startedAt,
    projectPath,
    dockerContext: options.dockerContext,
  };
  let releasePromise: Promise<void> | undefined;

  return {
    path: lockPath,
    owner,
    release(): Promise<void> {
      releasePromise ??= (async () => {
        try {
          await removeOwnedLock(lockPath, handle);
        } finally {
          await handle.close();
        }
      })();
      return releasePromise;
    },
  };
}

export async function withLifecycleLock<T>(
  options: AcquireLifecycleLockOptions,
  operation: (lock: LifecycleLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireLifecycleLock(options);
  try {
    return await operation(lock);
  } finally {
    await lock.release();
  }
}
