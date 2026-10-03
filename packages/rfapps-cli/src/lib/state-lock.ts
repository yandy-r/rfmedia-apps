import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { getDefaultDatabasePath } from "./db.js";

const MAX_METADATA_BYTES = 8192;
const MAX_VALUE_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const STATE_LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

export type StateLockErrorCode =
  | "LOCK_HELD"
  | "LOCK_STALE"
  | "LOCK_METADATA_INVALID"
  | "LOCK_PATH_UNSAFE"
  | "LOCK_CHANGED"
  | "LOCK_IO_ERROR";

export interface StateLockMetadata {
  readonly operation: string;
  readonly who: string;
  readonly when: string;
  readonly lockId: string;
}

interface StateLockIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface StateLockEntryInspection {
  readonly name: string;
  readonly identity: StateLockIdentity;
  readonly fingerprint: string;
}

export type StateLockInspection =
  | {
      readonly status: "missing";
      readonly path: string;
    }
  | {
      readonly status: "active" | "stale";
      readonly path: string;
      readonly metadata: StateLockMetadata;
      readonly identity: StateLockIdentity;
      readonly entry: StateLockEntryInspection;
    }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly identity: StateLockIdentity;
      readonly entries: readonly StateLockEntryInspection[];
      readonly reason: string;
    };

export class StateLockError extends Error {
  override readonly name = "StateLockError";

  constructor(
    message: string,
    readonly code: StateLockErrorCode,
    readonly lockPath: string,
    readonly metadata?: StateLockMetadata,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AcquireStateLockOptions {
  readonly operation: string;
  readonly lockPath?: string;
  readonly who?: string;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  /** Test-only coordination hook used to exercise publication races deterministically. */
  readonly onTokenWritten?: () => Promise<void>;
}

export interface InspectStateLockOptions {
  readonly lockPath?: string;
  readonly now?: () => Date;
}

export interface StateLock {
  readonly path: string;
  readonly metadata: StateLockMetadata;
  release(): Promise<void>;
}

interface OpenedEntry {
  readonly handle: FileHandle;
  readonly identity: StateLockIdentity;
  readonly fingerprint: string;
  readonly content?: string;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function ioError(message: string, lockPath: string, cause: unknown): StateLockError {
  return new StateLockError(message, "LOCK_IO_ERROR", lockPath, undefined, { cause });
}

function unsafePath(message: string, lockPath: string, cause?: unknown): StateLockError {
  return new StateLockError(message, "LOCK_PATH_UNSAFE", lockPath, undefined, { cause });
}

function changedLock(message: string, lockPath: string): StateLockError {
  return new StateLockError(message, "LOCK_CHANGED", lockPath);
}

function validatePath(path: string): string {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes("\0")) {
    throw unsafePath("State lock path must be non-empty, bounded, and contain no NUL bytes", path);
  }
  return resolve(path);
}

function validateMetadataValue(value: string, field: string, lockPath: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_VALUE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new StateLockError(
      `State lock ${field} must be non-empty, bounded, and contain no control characters`,
      "LOCK_METADATA_INVALID",
      lockPath,
    );
  }
}

function defaultWho(): string {
  let username = process.env["USER"] ?? "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Keep the bounded environment fallback when the OS user database is unavailable.
  }
  return `${username}@${hostname()}`;
}

export function getDefaultStateLockPath(): string {
  return join(dirname(getDefaultDatabasePath()), "lock");
}

function identityOf(stat: Stats): StateLockIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: StateLockIdentity, right: StateLockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertNoSymlinkComponents(path: string, lockPath: string): Promise<void> {
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
      if ((await lstat(component)).isSymbolicLink()) {
        throw unsafePath(`State lock path contains a symbolic link: ${component}`, lockPath);
      }
    } catch (error) {
      if (error instanceof StateLockError) {
        throw error;
      }
      if (!hasCode(error, "ENOENT")) {
        throw unsafePath(`State lock path cannot be inspected: ${component}`, lockPath, error);
      }
    }
  }
}

async function ensurePrivateParent(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  await assertNoSymlinkComponents(directory, lockPath);
  try {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertNoSymlinkComponents(directory, lockPath);
    let directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw unsafePath("State lock parent must be a real directory", lockPath);
    }
    if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
      throw unsafePath("State lock parent must be owned by the current user", lockPath);
    }
    if ((directoryStat.mode & 0o077) !== 0) {
      await chmod(directory, PRIVATE_DIRECTORY_MODE);
      directoryStat = await lstat(directory);
      if ((directoryStat.mode & 0o077) !== 0) {
        throw unsafePath("State lock parent must be private to the current user", lockPath);
      }
    }
  } catch (error) {
    if (error instanceof StateLockError) {
      throw error;
    }
    throw ioError("Unable to prepare the state lock parent", lockPath, error);
  }
}

function assertPrivateOwnedDirectory(stat: Stats, lockPath: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw unsafePath("State lock path must be a real directory", lockPath);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw unsafePath("State lock directory must be private to the current user", lockPath);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw unsafePath("State lock directory must be owned by the current user", lockPath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(content: string): StateLockMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const expectedKeys = ["lockId", "operation", "when", "who"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    return undefined;
  }

  const { operation, who, when, lockId } = value;
  if (
    typeof operation !== "string" ||
    operation.length === 0 ||
    operation.length > MAX_VALUE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(operation) ||
    typeof who !== "string" ||
    who.length === 0 ||
    who.length > MAX_VALUE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(who) ||
    typeof when !== "string" ||
    when.length > 40 ||
    !Number.isFinite(Date.parse(when)) ||
    typeof lockId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(lockId)
  ) {
    return undefined;
  }

  return { operation, who, when, lockId };
}

async function openEntryForRead(entryPath: string, lockPath: string): Promise<OpenedEntry> {
  let handle: FileHandle | undefined;
  try {
    const pathStat = await lstat(entryPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw unsafePath("State lock token must be a regular file", lockPath);
    }
    if ((pathStat.mode & 0o077) !== 0) {
      throw unsafePath("State lock token must be private to the current user", lockPath);
    }
    if (typeof process.getuid === "function" && pathStat.uid !== process.getuid()) {
      throw unsafePath("State lock token must be owned by the current user", lockPath);
    }

    handle = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStat = await handle.stat();
    if (handleStat.size > MAX_METADATA_BYTES) {
      return {
        handle,
        identity: identityOf(handleStat),
        fingerprint: fingerprint(`${handleStat.size}:${handleStat.mtimeMs}:${handleStat.ctimeMs}`),
      };
    }
    const content = await handle.readFile("utf-8");
    return {
      handle,
      identity: identityOf(handleStat),
      fingerprint: fingerprint(content),
      content: Buffer.byteLength(content, "utf-8") <= MAX_METADATA_BYTES ? content : undefined,
    };
  } catch (error) {
    await handle?.close();
    if (error instanceof StateLockError) {
      throw error;
    }
    if (hasCode(error, "ENOENT")) {
      throw error;
    }
    if (hasCode(error, "ELOOP")) {
      throw unsafePath("State lock token resolves through a symbolic link", lockPath, error);
    }
    throw ioError("Unable to inspect the state lock token", lockPath, error);
  }
}

async function inspectEntry(
  lockPath: string,
  name: string,
): Promise<{ inspection: StateLockEntryInspection; content?: string }> {
  const opened = await openEntryForRead(join(lockPath, name), lockPath);
  try {
    return {
      inspection: {
        name,
        identity: opened.identity,
        fingerprint: opened.fingerprint,
      },
      content: opened.content,
    };
  } finally {
    await opened.handle.close();
  }
}

async function inspectExistingLock(
  lockPath: string,
  now: () => Date,
): Promise<Exclude<StateLockInspection, { status: "missing" }>> {
  const directoryStat = await lstat(lockPath);
  assertPrivateOwnedDirectory(directoryStat, lockPath);
  const directoryIdentity = identityOf(directoryStat);
  const names = (await readdir(lockPath)).sort();

  if (names.length === 0) {
    return {
      status: "invalid",
      path: lockPath,
      identity: directoryIdentity,
      entries: [],
      reason: "State lock owner token is missing",
    };
  }

  const entries = await Promise.all(names.map(async (name) => inspectEntry(lockPath, name)));
  if (entries.length !== 1) {
    return {
      status: "invalid",
      path: lockPath,
      identity: directoryIdentity,
      entries: entries.map((entry) => entry.inspection),
      reason: "State lock must contain exactly one owner token",
    };
  }

  const [entry] = entries;
  if (entry === undefined || entry.content === undefined) {
    return {
      status: "invalid",
      path: lockPath,
      identity: directoryIdentity,
      entries: entries.map((item) => item.inspection),
      reason: "State lock metadata exceeds the supported size",
    };
  }

  const metadata = parseMetadata(entry.content);
  if (metadata === undefined || entry.inspection.name !== metadata.lockId) {
    return {
      status: "invalid",
      path: lockPath,
      identity: directoryIdentity,
      entries: [entry.inspection],
      reason: "State lock metadata is invalid",
    };
  }

  const ageMs = now().getTime() - Date.parse(metadata.when);
  return {
    status: ageMs > STATE_LOCK_STALE_AFTER_MS ? "stale" : "active",
    path: lockPath,
    metadata,
    identity: directoryIdentity,
    entry: entry.inspection,
  };
}

export async function inspectStateLock(
  options: InspectStateLockOptions = {},
): Promise<StateLockInspection> {
  const lockPath = validatePath(options.lockPath ?? getDefaultStateLockPath());
  const now = options.now ?? (() => new Date());
  await assertNoSymlinkComponents(dirname(lockPath), lockPath);

  try {
    return await inspectExistingLock(lockPath, now);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { status: "missing", path: lockPath };
    }
    throw error;
  }
}

function contentionError(
  inspection: Exclude<StateLockInspection, { status: "missing" }>,
): StateLockError {
  if (inspection.status === "invalid") {
    return new StateLockError(
      `${inspection.reason}; refusing automatic takeover. ` +
        "Run `rfapps force-unlock` only after verifying no mutation is active.",
      "LOCK_METADATA_INVALID",
      inspection.path,
    );
  }

  const detail =
    `${inspection.metadata.operation} by ${inspection.metadata.who} ` +
    `since ${inspection.metadata.when}`;
  if (inspection.status === "stale") {
    return new StateLockError(
      `State lock appears stale (${detail}); refusing automatic takeover. ` +
        "Run `rfapps force-unlock` only after verifying no mutation is active.",
      "LOCK_STALE",
      inspection.path,
      inspection.metadata,
    );
  }
  return new StateLockError(
    `State lock is held for ${detail}`,
    "LOCK_HELD",
    inspection.path,
    inspection.metadata,
  );
}

async function verifyDirectory(
  lockPath: string,
  expectedIdentity: StateLockIdentity,
): Promise<void> {
  let currentStat: Stats;
  try {
    currentStat = await lstat(lockPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw changedLock("State lock directory disappeared", lockPath);
    }
    throw ioError("Unable to verify the state lock directory", lockPath, error);
  }
  assertPrivateOwnedDirectory(currentStat, lockPath);
  if (!sameIdentity(identityOf(currentStat), expectedIdentity)) {
    throw changedLock("State lock directory changed", lockPath);
  }
}

async function verifyEntry(lockPath: string, expected: StateLockEntryInspection): Promise<void> {
  let current: Awaited<ReturnType<typeof inspectEntry>>;
  try {
    current = await inspectEntry(lockPath, expected.name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw changedLock("State lock owner token disappeared", lockPath);
    }
    throw error;
  }
  if (
    !sameIdentity(current.inspection.identity, expected.identity) ||
    current.inspection.fingerprint !== expected.fingerprint
  ) {
    throw changedLock("State lock owner token changed", lockPath);
  }
}

async function removeInspectedLock(
  inspection: Exclude<StateLockInspection, { status: "missing" }>,
  missingIsSuccess: boolean,
): Promise<boolean> {
  try {
    await verifyDirectory(inspection.path, inspection.identity);
  } catch (error) {
    if (missingIsSuccess && error instanceof StateLockError && error.code === "LOCK_CHANGED") {
      try {
        await lstat(inspection.path);
      } catch (statError) {
        if (hasCode(statError, "ENOENT")) {
          return false;
        }
      }
    }
    throw error;
  }

  const entries = inspection.status === "invalid" ? inspection.entries : [inspection.entry];
  for (const entry of entries) {
    await verifyEntry(inspection.path, entry);
    try {
      await unlink(join(inspection.path, entry.name));
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw changedLock("State lock owner token disappeared before removal", inspection.path);
      }
      throw ioError("Unable to remove the state lock owner token", inspection.path, error);
    }
  }

  try {
    await rmdir(inspection.path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return missingIsSuccess ? false : true;
    }
    if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) {
      throw changedLock("State lock directory changed before removal", inspection.path);
    }
    throw ioError("Unable to remove the state lock directory", inspection.path, error);
  }
}

async function cleanupFailedAcquisition(
  lockPath: string,
  directoryIdentity: StateLockIdentity | undefined,
  entry: StateLockEntryInspection | undefined,
): Promise<void> {
  if (directoryIdentity === undefined) {
    return;
  }
  try {
    await verifyDirectory(lockPath, directoryIdentity);
    if (entry !== undefined) {
      await verifyEntry(lockPath, entry);
      await unlink(join(lockPath, entry.name));
    }
    await rmdir(lockPath);
  } catch {
    // A partial, populated, or replaced directory must remain visible and fail closed.
  }
}

export async function acquireStateLock(options: AcquireStateLockOptions): Promise<StateLock> {
  const lockPath = validatePath(options.lockPath ?? getDefaultStateLockPath());
  validateMetadataValue(options.operation, "operation", lockPath);
  const who = options.who ?? defaultWho();
  validateMetadataValue(who, "owner", lockPath);
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const metadata: StateLockMetadata = {
    operation: options.operation,
    who,
    when: now().toISOString(),
    lockId: randomId(),
  };
  const content = `${JSON.stringify(metadata)}\n`;
  if (parseMetadata(content) === undefined || Buffer.byteLength(content) > MAX_METADATA_BYTES) {
    throw new StateLockError("State lock metadata is invalid", "LOCK_METADATA_INVALID", lockPath);
  }

  await ensurePrivateParent(lockPath);
  try {
    await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw contentionError(await inspectExistingLock(lockPath, now));
    }
    throw ioError("Unable to acquire the state lock directory", lockPath, error);
  }

  const tokenPath = join(lockPath, metadata.lockId);
  let handle: FileHandle | undefined;
  let directoryIdentity: StateLockIdentity | undefined;
  let entry: StateLockEntryInspection | undefined;
  try {
    const directoryStat = await lstat(lockPath);
    assertPrivateOwnedDirectory(directoryStat, lockPath);
    directoryIdentity = identityOf(directoryStat);

    handle = await open(
      tokenPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    const tokenIdentity = identityOf(await handle.stat());
    await handle.close();
    handle = undefined;
    await options.onTokenWritten?.();

    entry = {
      name: metadata.lockId,
      identity: tokenIdentity,
      fingerprint: fingerprint(content),
    };
    await verifyDirectory(lockPath, directoryIdentity);
    await verifyEntry(lockPath, entry);

    const inspection: Exclude<StateLockInspection, { status: "missing" }> = {
      status: "active",
      path: lockPath,
      metadata,
      identity: directoryIdentity,
      entry,
    };
    let releasePromise: Promise<void> | undefined;
    return {
      path: lockPath,
      metadata,
      release(): Promise<void> {
        releasePromise ??= removeInspectedLock(inspection, true).then(() => undefined);
        return releasePromise;
      },
    };
  } catch (error) {
    await handle?.close();
    await cleanupFailedAcquisition(lockPath, directoryIdentity, entry);
    if (error instanceof StateLockError) {
      throw error;
    }
    throw ioError("Unable to publish state lock metadata", lockPath, error);
  }
}

export async function forceUnlockStateLock(inspection: StateLockInspection): Promise<boolean> {
  if (inspection.status === "missing") {
    return false;
  }
  return removeInspectedLock(inspection, false);
}

export async function withStateLock<T>(
  operation: string,
  callback: (lock: StateLock) => Promise<T>,
  options: Omit<AcquireStateLockOptions, "operation"> = {},
): Promise<T> {
  const lock = await acquireStateLock({ ...options, operation });
  try {
    return await callback(lock);
  } finally {
    await lock.release();
  }
}
