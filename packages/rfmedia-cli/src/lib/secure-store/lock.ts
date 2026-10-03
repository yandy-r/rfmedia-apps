/**
 * Waiting inter-process exclusive lock for the secure store.
 *
 * `link()` is the exclusive-create primitive: it is atomic and refuses to
 * clobber, so exactly one process publishes the lock file. Everything above it
 * is new code — `src/lib/lidarr/profile-preset-persistence.ts` (the read-only
 * reference model for the file primitives) fails immediately on contention and
 * has no backoff loop, no deadline and no `AbortSignal`. A waiting lock is
 * required here because the losing process must survive long enough to adopt the
 * winner's credential instead of burning one of the ten nonces plex.tv allows
 * per five minutes.
 *
 * **Documented limitation:** `link()` semantics over NFS/SMB can lie. The store
 * must live on a local filesystem; callers surface {@link SecureStoreLock.path}
 * so an operator can see where it is.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { hostname as nodeHostname } from "node:os";
import { basename } from "node:path";

import { createPrivateFileAtomically, syncDirectory } from "./atomic.js";
import {
  hasErrorCode,
  rethrowAsSecureStoreError,
  SecureStoreError,
  secureStoreError,
} from "./errors.js";
import {
  assertOpenedFileIdentity,
  assertSafeParentUnchanged,
  prepareSafeParent,
  readBoundedPrivateFile,
  resolveSecurePath,
  sameIdentity,
} from "./paths.js";
import type { BoundedPrivateFileModePolicy, FileIdentity, SafeParent } from "./paths.js";

/**
 * A lock whose record is older than this is stale regardless of host or pid and
 * is stolen exactly once.
 *
 * Pid liveness alone is not enough: a reused pid or an `EPERM` from
 * `process.kill(pid, 0)` would otherwise wedge the lock forever.
 */
export const SECURE_STORE_LOCK_MAX_AGE_MS = 120_000;

/** Hard ceiling on a lock record, which is a single small JSON object. */
const LOCK_MAX_BYTES = 4_096;

/** First backoff step; each subsequent wait doubles it. */
const LOCK_BACKOFF_BASE_MS = 50;

/** Longest single backoff wait. */
const LOCK_BACKOFF_CAP_MS = 2_000;

/** Uniform jitter added to every backoff wait to break lockstep retries. */
const LOCK_BACKOFF_JITTER_MS = 50;

/** Largest exponent applied to the backoff base. */
const LOCK_BACKOFF_MAX_EXPONENT = 8;

/**
 * Cap on retries taken without sleeping (after a steal, or after observing the
 * lock vanish). Bounds the loop even when a caller injects a frozen clock.
 */
const LOCK_MAX_IMMEDIATE_RETRIES = 8;

/**
 * UUIDv4 shape of the ownership token.
 *
 * Exported so Lidarr adapters can validate UUID-bearing metadata before shared
 * secure-store I/O.
 */
export const SECURE_STORE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Ownership record published inside the lock file. */
export interface SecureStoreLockRecord {
  /** Hostname of the owning process. Cross-host pid liveness is meaningless. */
  readonly host: string;
  /** Pid of the owning process. */
  readonly pid: number;
  /** ISO-8601 acquisition timestamp, used by the age-based staleness rule. */
  readonly createdAt: string;
  /** UUIDv4 proving that a release unlinks only the caller's own lock. */
  readonly ownershipToken: string;
  /**
   * Opaque caller-supplied binding, re-asserted on read. Absent when the caller
   * supplied none, so a record written without one is byte-identical to a
   * pre-#288 record.
   */
  readonly binding?: string;
}

/** A held exclusive lock. */
export interface SecureStoreLock {
  /** Absolute path of the lock file, safe to surface to an operator. */
  readonly path: string;
  /** UUIDv4 identifying this acquisition. */
  readonly ownershipToken: string;
  /** The binding this acquisition was made under, when one was supplied. */
  readonly binding?: string;
  /**
   * Re-reads the record and proves `ownershipToken`, `host`, `pid`,
   * `createdAt`, `binding` and `{dev,ino}` all still match.
   *
   * @throws {SecureStoreError} `SECURE_STORE_LOCK_BUSY` when the record no
   *   longer matches, while {@link SecureStoreLock.release} is running, or after
   *   release has succeeded,
   *   `SECURE_STORE_CORRUPT` when the record on disk is unparseable.
   */
  assertOwned(): Promise<void>;
  /**
   * Unlinks the lock, but only while this acquisition still owns it.
   * Idempotent: a second call is a no-op.
   */
  release(): Promise<void>;
}

/** Inputs for {@link acquireExclusiveLock}. */
export interface SecureStoreLockOptions {
  /** Epoch milliseconds after which waiting stops with `SECURE_STORE_LOCK_BUSY`. */
  readonly deadlineEpochMs: number;
  /** Short human name of the protected document. */
  readonly subject: string;
  /** Aborts the wait with `SECURE_STORE_CANCELLED`. */
  readonly signal?: AbortSignal;
  /** Epoch-millisecond clock. Injected for deterministic tests. */
  readonly now?: () => number;
  /** Hostname source. Injected for deterministic tests. */
  readonly hostname?: () => string;
  /** Pid recorded in the lock record. Injected for deterministic tests. */
  readonly pid?: number;
  /** Liveness probe for a peer pid on the same host. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Ownership-token UUIDv4 source. Injected for deterministic tests. */
  readonly randomUUID?: () => string;
  /** Temporary-file UUID source. Defaults to the ownership UUID source. */
  readonly temporaryUUID?: () => string;
  /** Reject lock records carrying keys outside the expected exact shape. */
  readonly strictRecordShape?: boolean;
  /**
   * Age after which a lock is stolen on ANY host, regardless of liveness.
   * `null` disables the age rule entirely — required by call sites whose
   * critical section legitimately outlives the default and that document "a
   * live owner is never forcibly replaced". Defaults to
   * {@link SECURE_STORE_LOCK_MAX_AGE_MS}.
   */
  readonly maxAgeMs?: number | null;
  /**
   * Opaque caller-supplied binding written into the record and re-asserted on
   * every read during acquisition. A record carrying a different binding is
   * treated as unparseable, so acquisition fails `SECURE_STORE_CORRUPT`. A
   * pre-#288 record carrying the same value under `originDigest` instead
   * satisfies the expectation — see {@link satisfiesBinding}.
   */
  readonly binding?: string;
}

interface ExistingLock {
  readonly record: SecureStoreLockRecord;
  readonly identity: FileIdentity;
}

/**
 * Default liveness probe.
 *
 * `EPERM` means the pid exists but belongs to another user, so the peer is
 * treated as **alive**. That is intentional: refusing to steal a lock we cannot
 * prove is dead is the safe direction, and the age rule
 * ({@link SECURE_STORE_LOCK_MAX_AGE_MS}) prevents a permanent wedge.
 *
 * @param pid - Process id to probe.
 * @returns `true` when the process is believed to be running.
 */
export function isProcessAliveByDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Key under which a pre-#288 `lidarr/profile-preset-persistence.ts` wrote the
 * binding it now supplies as {@link SecureStoreLockOptions.binding}.
 */
const LEGACY_BINDING_KEY = "originDigest";

const LOCK_RECORD_KEYS = ["host", "pid", "createdAt", "ownershipToken"] as const;

function hasExpectedRecordShape(
  value: Record<string, unknown>,
  expectedBinding: string | undefined,
): boolean {
  const keys = Object.keys(value);
  if (!LOCK_RECORD_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  if (expectedBinding === undefined) return keys.length === LOCK_RECORD_KEYS.length;

  const hasBinding = Object.hasOwn(value, "binding");
  const hasLegacyBinding = Object.hasOwn(value, LEGACY_BINDING_KEY);
  return keys.length === LOCK_RECORD_KEYS.length + 1 && hasBinding !== hasLegacyBinding;
}

/**
 * Whether an on-disk record carries the binding the caller expects.
 *
 * A record written by the shipped build carries the binding under
 * {@link LEGACY_BINDING_KEY} and has no `binding` key at all. Accepting it keeps
 * the same-host-dead-pid steal in {@link isStale} reachable: classifying it as
 * unparseable instead would make a lock stranded by the shipped build
 * permanently unrecoverable, because callers that pass `maxAgeMs: null` have no
 * second steal rule and the corrupt classification fires first.
 *
 * The legacy shape only ever *satisfies* an expectation, never relaxes one: a
 * record carrying a `binding` that differs is still rejected, whatever
 * `originDigest` says.
 */
function satisfiesBinding(
  value: Record<string, unknown>,
  binding: string | undefined,
  expectedBinding: string | undefined,
): boolean {
  if (expectedBinding === undefined || binding === expectedBinding) return true;
  return binding === undefined && value[LEGACY_BINDING_KEY] === expectedBinding;
}

function parseLockRecord(
  value: unknown,
  expectedBinding: string | undefined,
  strictRecordShape: boolean,
): SecureStoreLockRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (strictRecordShape && !hasExpectedRecordShape(value, expectedBinding)) return undefined;
  const host = value["host"];
  const pid = value["pid"];
  const createdAt = value["createdAt"];
  const ownershipToken = value["ownershipToken"];
  const binding = value["binding"];
  if (binding !== undefined && typeof binding !== "string") return undefined;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof createdAt !== "string" ||
    !Number.isSafeInteger(Date.parse(createdAt)) ||
    typeof ownershipToken !== "string" ||
    !SECURE_STORE_UUID_PATTERN.test(ownershipToken)
  ) {
    return undefined;
  }
  if (!satisfiesBinding(value, binding, expectedBinding)) return undefined;
  // `binding` is deliberately NOT synthesized from the legacy key: the record
  // returned here is the one `unlinkLockIfOwned` re-reads (with no expectation)
  // and compares field-for-field, and a synthesized value would never match.
  return {
    host,
    pid,
    createdAt,
    ownershipToken,
    ...(binding === undefined ? {} : { binding }),
  };
}

async function readExistingLock(
  lockPath: string,
  subject: string,
  expectedBinding: string | undefined,
  strictRecordShape: boolean,
  fileModePolicy: BoundedPrivateFileModePolicy = "owner-only",
): Promise<ExistingLock | undefined> {
  const read = await readBoundedPrivateFile(lockPath, LOCK_MAX_BYTES, subject, fileModePolicy);
  if (read === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch (error) {
    throw secureStoreError("SECURE_STORE_CORRUPT", subject, lockPath, error);
  }
  const record = parseLockRecord(parsed, expectedBinding, strictRecordShape);
  if (record === undefined) {
    throw secureStoreError("SECURE_STORE_CORRUPT", subject, lockPath);
  }
  return { record, identity: read.identity };
}

/**
 * Whole-record equality, the ownership predicate shared by
 * {@link SecureStoreLock.assertOwned} and {@link unlinkLockIfOwned}.
 *
 * The `{dev,ino}` axis alone is NOT sufficient and the two checks must not
 * drift: ext4 hands a freed inode number straight back, so a plain
 * unlink-then-create republishes a foreign record at the identical `{dev,ino}`.
 * A displacement that copies our `ownershipToken` but changes `pid` is then
 * invisible on both of those axes, and an unlink here would delete a lock its
 * live owner still believes it holds.
 */
function isSameRecord(current: SecureStoreLockRecord, expected: SecureStoreLockRecord): boolean {
  return (
    current.ownershipToken === expected.ownershipToken &&
    current.host === expected.host &&
    current.pid === expected.pid &&
    current.createdAt === expected.createdAt &&
    current.binding === expected.binding
  );
}

async function unlinkLockIfOwned(
  lockPath: string,
  expected: SecureStoreLockRecord,
  identity: FileIdentity,
  parent: SafeParent,
  subject: string,
  expectedBinding: string | undefined,
  strictRecordShape: boolean,
  fileModePolicy: BoundedPrivateFileModePolicy = "owner-only",
): Promise<boolean> {
  const current = await readExistingLock(
    lockPath,
    subject,
    expectedBinding,
    strictRecordShape,
    fileModePolicy,
  );
  if (
    current === undefined ||
    !isSameRecord(current.record, expected) ||
    !sameIdentity(current.identity, identity)
  ) {
    return false;
  }
  await assertOpenedFileIdentity(lockPath, identity, subject);
  await unlink(lockPath).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
  await assertSafeParentUnchanged(parent, subject);
  // Best-effort: the unlink has already happened, and every production lock
  // consumer invokes release() from inside a `finally`. A durability hint must
  // never mask the real failure that is already in flight.
  await syncDirectory(parent.path).catch(() => undefined);
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined, subject: string, path: string): void {
  if (signal?.aborted === true) {
    throw secureStoreError("SECURE_STORE_CANCELLED", subject, path);
  }
}

function computeBackoffMs(attempt: number): number {
  const exponent = Math.min(attempt, LOCK_BACKOFF_MAX_EXPONENT);
  const base = LOCK_BACKOFF_BASE_MS * 2 ** exponent + Math.random() * LOCK_BACKOFF_JITTER_MS;
  return Math.min(base, LOCK_BACKOFF_CAP_MS);
}

function waitAbortable(
  milliseconds: number,
  signal: AbortSignal | undefined,
  subject: string,
  path: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(secureStoreError("SECURE_STORE_CANCELLED", subject, path));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isStale(
  record: SecureStoreLockRecord,
  host: string,
  nowEpochMs: number,
  isProcessAlive: (pid: number) => boolean,
  maxAgeMs: number | null,
): boolean {
  if (record.host === host && !isProcessAlive(record.pid)) return true;
  if (maxAgeMs === null) return false;
  return nowEpochMs - Date.parse(record.createdAt) > maxAgeMs;
}

/**
 * Acquires the exclusive inter-process lock at `lockPath`, waiting with jittered
 * backoff until the deadline.
 *
 * A contended lock is stolen **exactly once** per acquisition when its owner is
 * a dead pid on this host, or when its record is older than
 * {@link SECURE_STORE_LOCK_MAX_AGE_MS} regardless of host.
 *
 * Passing `maxAgeMs: null` disables the age rule entirely, leaving the
 * same-host-dead-pid rule as the only steal. Passing a `binding` makes an
 * existing record carrying a different one unparseable, so acquisition fails
 * `SECURE_STORE_CORRUPT` rather than waiting behind a foreign owner; a pre-#288
 * record carrying the expected value under `originDigest` is accepted so that
 * the steal rules still apply to it.
 *
 * Anything else waits:
 * `min(50 * 2^n + rand(0,50), 2000) ms` up to `deadlineEpochMs`, then
 * `SECURE_STORE_LOCK_BUSY`. A corrupt lock record fails immediately with
 * `SECURE_STORE_CORRUPT` rather than wedging the caller behind an unreadable
 * owner.
 *
 * @param lockPath - Absolute path of the lock file.
 * @param options - Deadline, subject and injectable clock/host/pid seams.
 * @returns The held lock.
 * @throws {SecureStoreError} `SECURE_STORE_LOCK_BUSY` at the deadline,
 *   `SECURE_STORE_CANCELLED` when the signal aborts, `SECURE_STORE_CORRUPT` for
 *   an unparseable record, `SECURE_STORE_UNSAFE_PATH` for a hostile path.
 */
export async function acquireExclusiveLock(
  lockPath: string,
  options: SecureStoreLockOptions,
): Promise<SecureStoreLock> {
  const subject = options.subject;
  const path = resolveSecurePath(lockPath, subject);
  const parent = await prepareSafeParent(path, true, subject);
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const temporaryUUID = options.temporaryUUID ?? randomUUID;
  const host = options.hostname?.() ?? nodeHostname();
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? isProcessAliveByDefault;
  const binding = options.binding;
  const strictRecordShape = options.strictRecordShape ?? false;
  const maxAgeMs = options.maxAgeMs === undefined ? SECURE_STORE_LOCK_MAX_AGE_MS : options.maxAgeMs;

  if (host.length === 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    throw secureStoreError("SECURE_STORE_CORRUPT", subject, path);
  }

  const temporaryId = basename(path);
  let attempt = 0;
  let immediateRetries = 0;
  let hasStolen = false;

  for (;;) {
    throwIfAborted(options.signal, subject, path);
    const ownershipToken = randomUUID();
    if (!SECURE_STORE_UUID_PATTERN.test(ownershipToken)) {
      throw secureStoreError("SECURE_STORE_CORRUPT", subject, path);
    }
    const record: SecureStoreLockRecord = {
      host,
      pid,
      createdAt: new Date(now()).toISOString(),
      ownershipToken,
      ...(binding === undefined ? {} : { binding }),
    };

    let identity: FileIdentity | undefined;
    let publishedIdentity: FileIdentity | undefined;
    try {
      identity = await createPrivateFileAtomically(
        {
          path,
          text: JSON.stringify(record),
          subject,
          temporaryId,
          randomUUID: temporaryUUID,
        },
        (published): void => {
          publishedIdentity = published;
        },
      );
    } catch (error) {
      if (!(error instanceof SecureStoreError) || error.code !== "SECURE_STORE_VERSION_CONFLICT") {
        if (publishedIdentity !== undefined) {
          await unlinkLockIfOwned(
            path,
            record,
            publishedIdentity,
            parent,
            subject,
            strictRecordShape ? binding : undefined,
            strictRecordShape,
          ).catch(() => undefined);
        }
        rethrowAsSecureStoreError(error, subject, path);
      }
    }

    if (identity !== undefined) {
      const held = identity;
      let released = false;
      let releaseInFlight: Promise<void> | undefined;
      const lock: SecureStoreLock = {
        path,
        ownershipToken,
        ...(binding === undefined ? {} : { binding }),
        assertOwned: async (): Promise<void> => {
          if (released || releaseInFlight !== undefined) {
            throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
          }
          const current = await readExistingLock(
            path,
            subject,
            strictRecordShape ? binding : undefined,
            strictRecordShape,
          );
          if (released || releaseInFlight !== undefined) {
            throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
          }
          if (
            current === undefined ||
            !isSameRecord(current.record, record) ||
            !sameIdentity(current.identity, held)
          ) {
            throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
          }
        },
        release: (): Promise<void> => {
          if (released) return Promise.resolve();
          if (releaseInFlight !== undefined) return releaseInFlight;
          releaseInFlight = unlinkLockIfOwned(
            path,
            record,
            held,
            parent,
            subject,
            strictRecordShape ? binding : undefined,
            strictRecordShape,
            "allow-foreign-read",
          )
            .then(() => {
              released = true;
            })
            .catch((error: unknown) => {
              releaseInFlight = undefined;
              throw error;
            });
          return releaseInFlight;
        },
      };
      return Object.freeze(lock);
    }

    const existing = await readExistingLock(path, subject, binding, strictRecordShape);
    let retryImmediately = existing === undefined;
    if (
      existing !== undefined &&
      !hasStolen &&
      isStale(existing.record, host, now(), isProcessAlive, maxAgeMs)
    ) {
      hasStolen = true;
      await unlinkLockIfOwned(
        path,
        existing.record,
        existing.identity,
        parent,
        subject,
        strictRecordShape ? binding : undefined,
        strictRecordShape,
      );
      retryImmediately = true;
    }

    if (retryImmediately && immediateRetries < LOCK_MAX_IMMEDIATE_RETRIES) {
      immediateRetries += 1;
      continue;
    }

    const remainingMs = options.deadlineEpochMs - now();
    if (remainingMs <= 0) {
      throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
    }
    await waitAbortable(
      Math.min(computeBackoffMs(attempt), remainingMs),
      options.signal,
      subject,
      path,
    );
    attempt += 1;
  }
}
