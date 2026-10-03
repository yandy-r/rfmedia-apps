/**
 * Owner-only, atomically-replaced, version-stamped Plex credential store
 * (issue #251).
 *
 * ONE DOCUMENT, ONE LOCK, ONE VERSION. Signing key and credential live in the
 * *same* file: two files would open a cross-file consistency window (key
 * rotated, credential stale) that no single atomic operation can close. The
 * layout lives in `credential-store-document.ts`; this module owns custody.
 *
 * SECRET CUSTODY. The private key and the credential are stripped into a
 * module-private `WeakMap` keyed by the returned {@link PlexAuthStoreHandle} at
 * parse time, so a handle is absent from reflection, spread, `util.inspect` and
 * `JSON.stringify` by construction. Read them with
 * {@link readStoredCredential} and {@link readStoredSigningKey}.
 *
 * FILESYSTEM CUSTODY. Every path walk, permission check, atomic publication and
 * inter-process lock is delegated to `src/lib/secure-store/`; nothing is
 * reimplemented here and nothing is silently repaired. `SecureStoreError` is
 * mapped onto {@link PlexAuthError} here, so upper layers see one error type.
 *
 * ADOPTION, NOT OVERWRITE. `mutate` receives the state RE-READ under the lock,
 * so a peer that refreshed between a caller's first read and lock acquisition is
 * observed rather than clobbered. Callers take the lock BEFORE any network call,
 * which serializes the refresh itself across processes.
 */

import { lstatSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  acquireExclusiveLock,
  createPrivateFileAtomically,
  hasErrorCode,
  readBoundedPrivateFileSync,
  replacePrivateFileAtomically,
  sameIdentity,
  SecureStoreError,
  syncDirectory,
} from "../../secure-store/index.js";
import type { FileIdentity, SecureStoreErrorCode } from "../../secure-store/index.js";

import {
  applyPlexStoreMutations,
  containsDestroyMutation,
  parsePlexAuthStoreDocument,
  serializePlexAuthStoreDocument,
} from "./credential-store-document.js";
import type {
  PlexAuthorizedOrigin,
  PlexAuthStoreDocument,
  PlexStoreMutation,
  PlexStoreMutationOutcome,
} from "./credential-store-document.js";
import { PlexAuthError } from "./errors.js";
import type { PlexAuthErrorCode } from "./errors.js";

export { PLEX_AUTH_STORE_SCHEMA } from "./credential-store-document.js";
export type {
  PlexAuthorizedOrigin,
  PlexStoreMutation,
  PlexStoreMutationOutcome,
} from "./credential-store-document.js";

/** Proactive refresh margin used when a caller supplies none. */
export const PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS = 300;

/**
 * Grace applied before a credential is called expired: a deadline that has only
 * just passed reads `refresh-soon`, so a mildly skewed clock costs one extra
 * refresh instead of a re-enrollment loop.
 */
export const PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS = 60;

/** Environment seam used by tests and ops, mirroring `RFMEDIA_PLAN_DIR`. */
const PLEX_AUTH_STORE_DIR_ENV = "RFMEDIA_PLEX_AUTH_DIR";

const PLEX_AUTH_STORE_FILE_NAME = "store.json";
const PLEX_AUTH_STORE_SUBJECT = "Plex credential store";
const PLEX_AUTH_STORE_TEMPORARY_ID = "plex-auth-store";

/** Hard ceiling on the store document; it is a single small JSON object. */
const PLEX_AUTH_STORE_MAX_BYTES = 8 * 1024;

/**
 * `SecureStoreErrorCode` to {@link PlexAuthErrorCode}, total by construction.
 *
 * `SECURE_STORE_LOCK_BUSY` becomes `PLEX_AUTH_REFRESH_BUSY`, whose remediation
 * names the lock path. `SECURE_STORE_TOO_LARGE` collapses onto
 * `PLEX_AUTH_STORE_CORRUPT`: a store past 8 KiB is not one this build wrote.
 */
const SECURE_STORE_CODE_MAP: Readonly<Record<SecureStoreErrorCode, PlexAuthErrorCode>> =
  Object.freeze({
    SECURE_STORE_UNSAFE_PATH: "PLEX_AUTH_STORE_UNSAFE_PATH",
    SECURE_STORE_PERMISSIONS: "PLEX_AUTH_STORE_PERMISSIONS",
    SECURE_STORE_CORRUPT: "PLEX_AUTH_STORE_CORRUPT",
    SECURE_STORE_VERSION_CONFLICT: "PLEX_AUTH_STORE_VERSION_CONFLICT",
    SECURE_STORE_LOCK_BUSY: "PLEX_AUTH_REFRESH_BUSY",
    SECURE_STORE_CANCELLED: "PLEX_AUTH_CANCELLED",
    SECURE_STORE_TOO_LARGE: "PLEX_AUTH_STORE_CORRUPT",
  } as const);

/**
 * Freshness of the stored credential, computed against an injected clock.
 *
 * There is deliberately no `absent` variant: a {@link PlexAuthStoreHandle} only
 * exists once a document parsed successfully, and a document without a
 * credential never reaches disk.
 */
export type PlexCredentialState =
  | ({ readonly kind: "fresh" } & PlexCredentialTiming)
  | ({ readonly kind: "refresh-soon" } & PlexCredentialTiming)
  | ({ readonly kind: "expired" } & PlexCredentialTiming);

/** Timing fields carried by every {@link PlexCredentialState} variant. */
export interface PlexCredentialTiming {
  /** `issuedAt + lifetimeSeconds`, never a decoded JWT claim. */
  readonly expiresAtEpochSeconds: number;
  /** Negative once the deadline has passed. */
  readonly secondsRemaining: number;
}

/** Secret-free projection of the store. */
export interface PlexAuthStoreHandle {
  /** Absolute path of the store document. */
  readonly path: string;
  /** Absolute path of the inter-process lock file, reported by `plex auth status`. */
  readonly lockPath: string;
  /** Monotonic compare-and-swap discriminator. */
  readonly version: number;
  readonly clientIdentifier: string;
  readonly deviceName: string;
  /** RFC 7638 thumbprint of the signing key. Public, not a secret. */
  readonly kid: string;
  readonly credentialState: PlexCredentialState;
  /** True when the credential's lifetime was assumed rather than declared (U2). */
  readonly lifetimeAssumed: boolean;
  /** Cooperative, cross-process rate-limit backoff. `0` when none is active. */
  readonly refreshNotBeforeEpochSeconds: number;
  /** Last skew observed on a successful response, or `null` if never observed. */
  readonly lastObservedSkewSeconds: number | null;
  readonly authorizedOrigins: readonly PlexAuthorizedOrigin[];
  /** Permission bits of the store file, for `plex auth status`. */
  readonly fileMode: number;
}

/** Injectable seams for the credential store. */
export interface PlexAuthStoreDependencies {
  /** Store path override, already tilde-expanded by the config validator. */
  readonly storePath?: string;
  /** Epoch milliseconds. Injected for deterministic tests. */
  readonly now?: () => number;
  /** Hostname source for the lock record. Injected for deterministic tests. */
  readonly hostname?: () => string;
  /** Pid recorded in the lock record. Injected for deterministic tests. */
  readonly pid?: number;
  /** Liveness probe for a peer pid on the same host. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Proactive refresh margin; defaults to {@link PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS}. */
  readonly refreshMarginSeconds?: number;
}

/** Wait budget for {@link withPlexAuthStoreLock}. */
export interface PlexAuthStoreLockBudget {
  /** Epoch milliseconds after which waiting stops with `PLEX_AUTH_REFRESH_BUSY`. */
  readonly deadlineEpochMs: number;
  /** Aborts the wait with `PLEX_AUTH_CANCELLED`. */
  readonly signal?: AbortSignal;
}

interface PlexAuthStoreSnapshot {
  readonly document: PlexAuthStoreDocument;
  readonly identity: FileIdentity;
  readonly handle: PlexAuthStoreHandle;
}

interface PlexAuthStoreSecrets {
  readonly credential: string;
  readonly privateKeyPkcs8Pem: string;
}

const storeSecrets = new WeakMap<PlexAuthStoreHandle, PlexAuthStoreSecrets>();

/**
 * Resolves the credential-store path.
 *
 * `RFMEDIA_PLEX_AUTH_DIR` (a directory, mirroring `RFMEDIA_PLAN_DIR`) wins, then
 * an explicit `plex.auth.storePath`, then the XDG-style default. There is no
 * legacy `~/.rfmedia` fallback.
 *
 * @param dependencies - Optional store-path override.
 * @returns Absolute path of the store document.
 */
export function resolvePlexAuthStorePath(dependencies?: PlexAuthStoreDependencies): string {
  const directory = process.env[PLEX_AUTH_STORE_DIR_ENV];
  if (directory !== undefined && directory.length > 0) {
    return resolve(join(directory, PLEX_AUTH_STORE_FILE_NAME));
  }
  const override = dependencies?.storePath;
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(homedir(), ".config", "rfmedia", "plex-auth", PLEX_AUTH_STORE_FILE_NAME);
}

/**
 * @param storePath - Absolute path of the store document.
 * @returns Absolute path of the sibling inter-process lock file.
 */
export function resolvePlexAuthLockPath(storePath: string): string {
  return `${storePath}.lock`;
}

function asPlexAuthError(error: unknown): unknown {
  if (error instanceof SecureStoreError) {
    return new PlexAuthError(SECURE_STORE_CODE_MAP[error.code], { path: error.path });
  }
  return error;
}

function computeCredentialState(
  expiresAtEpochSeconds: number,
  nowEpochSeconds: number,
  refreshMarginSeconds: number,
): PlexCredentialState {
  const secondsRemaining = expiresAtEpochSeconds - nowEpochSeconds;
  const kind =
    secondsRemaining <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS
      ? "expired"
      : secondsRemaining <= refreshMarginSeconds
        ? "refresh-soon"
        : "fresh";
  return Object.freeze({ kind, expiresAtEpochSeconds, secondsRemaining });
}

function nowEpochSecondsFrom(dependencies: PlexAuthStoreDependencies | undefined): number {
  return Math.floor((dependencies?.now?.() ?? Date.now()) / 1000);
}

function createHandle(
  document: PlexAuthStoreDocument,
  path: string,
  fileMode: number,
  dependencies: PlexAuthStoreDependencies | undefined,
): PlexAuthStoreHandle {
  const handle: PlexAuthStoreHandle = Object.freeze({
    path,
    lockPath: resolvePlexAuthLockPath(path),
    version: document.version,
    clientIdentifier: document.clientIdentifier,
    deviceName: document.deviceName,
    kid: document.kid,
    credentialState: computeCredentialState(
      document.issuedAtEpochSeconds + document.lifetimeSeconds,
      nowEpochSecondsFrom(dependencies),
      dependencies?.refreshMarginSeconds ?? PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS,
    ),
    lifetimeAssumed: document.lifetimeAssumed,
    refreshNotBeforeEpochSeconds: document.refreshNotBeforeEpochSeconds,
    lastObservedSkewSeconds: document.lastObservedSkewSeconds,
    authorizedOrigins: document.authorizedOrigins,
    fileMode: fileMode & 0o777,
  });
  storeSecrets.set(
    handle,
    Object.freeze({
      credential: document.credential,
      privateKeyPkcs8Pem: document.privateKeyPkcs8Pem,
    }),
  );
  return handle;
}

function loadSnapshot(
  storePath: string,
  dependencies: PlexAuthStoreDependencies | undefined,
): PlexAuthStoreSnapshot | undefined {
  const read = readBoundedPrivateFileSync(
    storePath,
    PLEX_AUTH_STORE_MAX_BYTES,
    PLEX_AUTH_STORE_SUBJECT,
  );
  if (read === undefined) return undefined;
  const document = parsePlexAuthStoreDocument(read.text, storePath);
  return {
    document,
    identity: read.identity,
    handle: createHandle(document, storePath, read.mode, dependencies),
  };
}

/**
 * Loads the credential store synchronously and TOCTOU-safely.
 *
 * `createMediaServerAdapter` is synchronous, so the enrolled precedence branch
 * needs a synchronous read. At most 8 KiB is read with `O_NOFOLLOW`, the file's
 * `{dev, ino}` are re-asserted after the read, and a file readable by anyone but
 * its owner is refused with a `chmod 600` remedy rather than repaired.
 *
 * @param dependencies - Store path override and injectable clock.
 * @returns The parsed handle, or `undefined` when no store file exists.
 * @throws {PlexAuthError} `PLEX_AUTH_STORE_UNSAFE_PATH`,
 *   `PLEX_AUTH_STORE_PERMISSIONS` or `PLEX_AUTH_STORE_CORRUPT`.
 */
export function loadPlexAuthStoreSync(
  dependencies?: PlexAuthStoreDependencies,
): PlexAuthStoreHandle | undefined {
  const storePath = resolvePlexAuthStorePath(dependencies);
  try {
    return loadSnapshot(storePath, dependencies)?.handle;
  } catch (error) {
    throw asPlexAuthError(error);
  }
}

/**
 * Cheap existence probe used to order the adapter precedence gate.
 *
 * It answers only "is there something at the store path", never "is it usable":
 * an unsafe or unreadable entry answers `true` so the authoritative
 * {@link loadPlexAuthStoreSync} raises the typed failure instead of this probe
 * degrading it to "not configured". It never throws, because
 * `createOptionalMediaServerAdapter` must not throw.
 *
 * @param dependencies - Store path override.
 * @returns `true` when an entry exists at the store path.
 */
export function plexAuthStoreExistsSync(dependencies?: PlexAuthStoreDependencies): boolean {
  try {
    lstatSync(resolvePlexAuthStorePath(dependencies));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    return true;
  }
}

function requireSecrets(handle: PlexAuthStoreHandle): PlexAuthStoreSecrets {
  const secrets = storeSecrets.get(handle);
  if (secrets === undefined) {
    throw new TypeError("Plex credential store handle is unavailable");
  }
  return secrets;
}

/**
 * Reads the stored credential for one explicitly authorized origin.
 *
 * The credential is account-scoped and `authorizedOrigins` is an allowlist, not
 * a per-origin copy: using it against a server the user never enrolled requires
 * an explicit `rfmedia plex auth login --plex-url <url>`, so opportunistic
 * cross-origin send is impossible.
 *
 * @param handle - Handle returned by {@link loadPlexAuthStoreSync}.
 * @param origin - Canonical origin, exactly as produced by `normalizePlexOrigin`.
 * @returns The stored credential.
 * @throws {PlexAuthError} `PLEX_AUTH_ORIGIN_NOT_AUTHORIZED` for an unlisted origin.
 * @throws TypeError when `handle` did not come from this module.
 */
export function readStoredCredential(handle: PlexAuthStoreHandle, origin: string): string {
  const secrets = requireSecrets(handle);
  if (!handle.authorizedOrigins.some((entry) => entry.origin === origin)) {
    throw new PlexAuthError("PLEX_AUTH_ORIGIN_NOT_AUTHORIZED", { path: handle.path });
  }
  return secrets.credential;
}

/**
 * Reads the PKCS#8 Ed25519 signing key backing this enrollment.
 *
 * @param handle - Handle returned by {@link loadPlexAuthStoreSync}.
 * @returns The PEM-encoded private key.
 * @throws TypeError when `handle` did not come from this module.
 */
export function readStoredSigningKey(handle: PlexAuthStoreHandle): string {
  return requireSecrets(handle).privateKeyPkcs8Pem;
}

/**
 * Compare-and-swaps the store on the content axis immediately before the rename.
 *
 * Inode identity alone cannot detect an in-place, same-inode rewrite by a writer
 * that bypassed the lock; the monotonic version alone cannot detect a replaced
 * file. Both are required, so both are checked here.
 */
function assertVersionUnchanged(storePath: string, snapshot: PlexAuthStoreSnapshot): void {
  const verify = readBoundedPrivateFileSync(
    storePath,
    PLEX_AUTH_STORE_MAX_BYTES,
    PLEX_AUTH_STORE_SUBJECT,
  );
  if (
    verify === undefined ||
    !sameIdentity(verify.identity, snapshot.identity) ||
    parsePlexAuthStoreDocument(verify.text, storePath).version !== snapshot.document.version
  ) {
    throw new PlexAuthError("PLEX_AUTH_STORE_VERSION_CONFLICT", { path: storePath });
  }
}

async function publishDocument(
  storePath: string,
  next: PlexAuthStoreDocument,
  snapshot: PlexAuthStoreSnapshot | undefined,
): Promise<void> {
  const text = serializePlexAuthStoreDocument(next);
  if (snapshot === undefined) {
    await createPrivateFileAtomically({
      path: storePath,
      text,
      subject: PLEX_AUTH_STORE_SUBJECT,
      temporaryId: PLEX_AUTH_STORE_TEMPORARY_ID,
    });
    return;
  }
  assertVersionUnchanged(storePath, snapshot);
  await replacePrivateFileAtomically({
    path: storePath,
    text,
    subject: PLEX_AUTH_STORE_SUBJECT,
    temporaryId: PLEX_AUTH_STORE_TEMPORARY_ID,
    expectedIdentity: snapshot.identity,
  });
}

async function destroyDocument(storePath: string): Promise<void> {
  let removed = true;
  await unlink(storePath).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    removed = false;
  });
  if (removed) await syncDirectory(dirname(storePath));
}

async function runUnderStoreLock<T>(
  storePath: string,
  dependencies: PlexAuthStoreDependencies,
  budget: PlexAuthStoreLockBudget,
  mutate: (current: PlexAuthStoreHandle | undefined) => Promise<PlexStoreMutationOutcome<T>>,
): Promise<T> {
  const lock = await acquireExclusiveLock(resolvePlexAuthLockPath(storePath), {
    subject: PLEX_AUTH_STORE_SUBJECT,
    deadlineEpochMs: budget.deadlineEpochMs,
    signal: budget.signal,
    now: dependencies.now,
    hostname: dependencies.hostname,
    pid: dependencies.pid,
    isProcessAlive: dependencies.isProcessAlive,
  });
  try {
    const snapshot = loadSnapshot(storePath, dependencies);
    const outcome = await mutate(snapshot?.handle);
    const mutations: readonly PlexStoreMutation[] = outcome.mutations;
    if (mutations.length === 0) return outcome.result;

    if (containsDestroyMutation(mutations)) {
      if (mutations.length !== 1) {
        throw new TypeError("Plex credential store destroy must be the only mutation");
      }
      await destroyDocument(storePath);
      return outcome.result;
    }

    const next = applyPlexStoreMutations(
      snapshot?.document,
      mutations,
      nowEpochSecondsFrom(dependencies),
    );
    await publishDocument(storePath, next, snapshot);
    return outcome.result;
  } finally {
    await lock.release();
  }
}

/**
 * Runs `mutate` under the exclusive inter-process lock with an inode + version
 * compare-and-swap.
 *
 * `mutate` receives the state RE-READ under the lock, so a peer that refreshed
 * between the caller's first read and lock acquisition is observed rather than
 * overwritten; there is no caller-held stale snapshot to reconcile. Callers must
 * acquire this lock BEFORE issuing any network call, so a credential that Plex
 * invalidates on refresh cannot be destroyed by a racing process.
 *
 * Returning zero mutations writes nothing. `destroy` must be the only mutation
 * in its batch and unlinks the document instead of replacing it.
 *
 * @param dependencies - Store path override and injectable clock/host/pid seams.
 * @param budget - Lock-wait deadline and cancellation signal.
 * @param mutate - Receives the state re-read under the lock; returns the
 *   mutations to apply and the value handed back to the caller.
 * @returns The `result` returned by `mutate`.
 * @throws {PlexAuthError} `PLEX_AUTH_REFRESH_BUSY` at the deadline,
 *   `PLEX_AUTH_CANCELLED` on abort, `PLEX_AUTH_STORE_VERSION_CONFLICT` when a
 *   writer bypassed the lock, or the `PLEX_AUTH_STORE_*` custody failures.
 */
export async function withPlexAuthStoreLock<T>(
  dependencies: PlexAuthStoreDependencies,
  budget: PlexAuthStoreLockBudget,
  mutate: (current: PlexAuthStoreHandle | undefined) => Promise<PlexStoreMutationOutcome<T>>,
): Promise<T> {
  const storePath = resolvePlexAuthStorePath(dependencies);
  try {
    return await runUnderStoreLock(storePath, dependencies, budget, mutate);
  } catch (error) {
    throw asPlexAuthError(error);
  }
}
