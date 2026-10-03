/** Hardened origin lock and apply journal for Lidarr profile presets. */

import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { hostname as nodeHostname } from "node:os";
import { join, resolve } from "node:path";

import {
  LIDARR_PRESET_JOURNAL_VERSION,
  type LidarrPresetApplyJournal,
  type LidarrPresetJournalResourceState,
  type LidarrPresetResourceDiff,
  type LidarrPresetResourceKey,
} from "../../types/lidarr-presets.js";
import { getDefaultPlanDir } from "../plan.js";
import {
  acquireExclusiveLock,
  createPrivateFileAtomically,
  replacePrivateFileAtomically,
  SECURE_STORE_MAX_PATH_LENGTH,
  SECURE_STORE_UUID_PATTERN,
  SecureStoreError,
} from "../secure-store/index.js";
import type { FileIdentity, SecureStoreLock } from "../secure-store/index.js";

export const LIDARR_PRESET_JOURNAL_MAX_BYTES = 1024 * 1024;
const JOURNAL_MAX_RESOURCES = 2_048;
const JOURNAL_MAX_DEPTH = 32;
const JOURNAL_MAX_NODES = 50_000;
const JOURNAL_MAX_STRING_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const SENSITIVE_KEY_PATTERN = /^(?:apikey|authorization|cookie|password|secret|token)$/u;
const LOCK_SUBJECT = "Lidarr preset apply lock";
const JOURNAL_SUBJECT = "Lidarr preset apply journal";

export type LidarrPresetPersistenceErrorCode =
  | "LIDARR_PRESET_ALREADY_RUNNING"
  | "LIDARR_PRESET_LOCK_METADATA_INVALID"
  | "LIDARR_PRESET_LOCK_LOST"
  | "LIDARR_PRESET_UNSAFE_PATH"
  | "LIDARR_PRESET_JOURNAL_INVALID"
  | "LIDARR_PRESET_JOURNAL_TOO_LARGE"
  | "LIDARR_PRESET_JOURNAL_EXISTS"
  | "LIDARR_PRESET_IO";

/** Stable, secret-free failure raised by preset lock and journal persistence. */
export class LidarrPresetPersistenceError extends Error {
  readonly code: LidarrPresetPersistenceErrorCode;
  readonly path?: string;

  constructor(
    code: LidarrPresetPersistenceErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LidarrPresetPersistenceError";
    this.code = code;
    this.path = path;
  }
}

export interface LidarrPresetPersistenceDependencies {
  /** Test/ops seam for the `lidarr-preset-applies` directory. */
  readonly storageDirectory?: string;
  readonly hostname?: () => string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly randomUUID?: () => string;
}

export interface LidarrPresetApplyLock {
  readonly path: string;
  readonly originDigest: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface LidarrPresetApplyJournalHandle {
  readonly path: string;
  transition(next: LidarrPresetApplyJournal): Promise<void>;
  finalize(next: LidarrPresetApplyJournal): Promise<void>;
}

interface OwnedLockState {
  readonly canonicalOrigin: string;
  readonly storageDirectory: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function fail(
  code: LidarrPresetPersistenceErrorCode,
  message: string,
  path?: string,
  cause?: unknown,
): LidarrPresetPersistenceError {
  return new LidarrPresetPersistenceError(
    code,
    message,
    path,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Maps a shared-store failure raised by the origin lock back onto this module's
 * code taxonomy.
 *
 * `rethrowAsSecureStoreError` maps only ELOOP/ENOTDIR and EACCES/EPERM and
 * rethrows every other errno RAW, and `src/commands/lidarr.ts:258-281` reads
 * `.code` structurally off any thrown object and forwards it into the machine
 * envelope. The explicit non-SecureStoreError arm below is what stops an
 * ENOSPC/EIO/EROFS replacing `LIDARR_PRESET_IO` in user-visible output.
 */
function translateLockFailure(
  error: unknown,
  lockPath: string,
  message: string,
): LidarrPresetPersistenceError {
  if (error instanceof LidarrPresetPersistenceError) return error;
  if (error instanceof SecureStoreError) {
    switch (error.code) {
      case "SECURE_STORE_LOCK_BUSY":
      case "SECURE_STORE_CORRUPT":
        return fail(
          "LIDARR_PRESET_ALREADY_RUNNING",
          "Another preset apply owns this Lidarr origin",
          lockPath,
          error,
        );
      case "SECURE_STORE_UNSAFE_PATH":
      case "SECURE_STORE_PERMISSIONS":
        return fail("LIDARR_PRESET_UNSAFE_PATH", message, lockPath, error);
      default:
        return fail("LIDARR_PRESET_IO", message, lockPath, error);
    }
  }
  return fail("LIDARR_PRESET_IO", message, lockPath, error);
}

/** Maps a shared-store failure raised by the journal writers. */
function translateJournalIo(
  error: unknown,
  path: string,
  message: string,
): LidarrPresetPersistenceError {
  if (error instanceof LidarrPresetPersistenceError) return error;
  if (error instanceof SecureStoreError) {
    switch (error.code) {
      case "SECURE_STORE_UNSAFE_PATH":
      case "SECURE_STORE_PERMISSIONS":
        return fail("LIDARR_PRESET_UNSAFE_PATH", message, path, error);
      case "SECURE_STORE_TOO_LARGE":
        return fail("LIDARR_PRESET_JOURNAL_TOO_LARGE", message, path, error);
      case "SECURE_STORE_VERSION_CONFLICT":
        return fail("LIDARR_PRESET_JOURNAL_EXISTS", message, path, error);
      case "SECURE_STORE_CORRUPT":
        return fail("LIDARR_PRESET_JOURNAL_INVALID", message, path, error);
      default:
        return fail("LIDARR_PRESET_IO", message, path, error);
    }
  }
  return fail("LIDARR_PRESET_IO", message, path, error);
}

function resolveStoragePath(inputPath: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.length > SECURE_STORE_MAX_PATH_LENGTH ||
    TERMINAL_CONTROL_PATTERN.test(inputPath)
  ) {
    throw fail(
      "LIDARR_PRESET_UNSAFE_PATH",
      "Preset persistence path must be non-empty, bounded, and free of terminal controls",
    );
  }
  return resolve(inputPath);
}

function canonicalizeOrigin(value: string): string {
  if (TERMINAL_CONTROL_PATTERN.test(value)) {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Target origin contains terminal controls");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Target origin must be a valid URL origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin
  ) {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Target origin must be canonical HTTP(S)");
  }
  return url.origin;
}

function originDigest(origin: string): string {
  return createHash("sha256").update(origin, "utf8").digest("hex");
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validString(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, "utf8") <= JOURNAL_MAX_STRING_BYTES &&
    !TERMINAL_CONTROL_PATTERN.test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  return validString(value) && Number.isFinite(Date.parse(value));
}

function validResourceKey(value: unknown): value is LidarrPresetResourceKey {
  return (
    validString(value) &&
    (/^(?:custom-format|quality-profile):.+$/u.test(value) || /^naming:[1-9]\d*$/u.test(value))
  );
}

function validStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= JOURNAL_MAX_RESOURCES &&
    value.every((item) => validString(item))
  );
}

function assertSafeJson(value: unknown): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > JOURNAL_MAX_NODES || depth > JOURNAL_MAX_DEPTH) {
      throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal exceeds structural bounds");
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal contains a non-finite number");
      }
      return;
    }
    if (typeof item === "string") {
      if (!validString(item, true)) {
        throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal contains unsafe text");
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!isPlainRecord(item)) {
      throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal contains an unsupported value");
    }
    for (const [key, entry] of Object.entries(item)) {
      if (
        !validString(key) ||
        SENSITIVE_KEY_PATTERN.test(key.replaceAll(/[-_\s]/gu, "").toLowerCase())
      ) {
        throw fail(
          "LIDARR_PRESET_JOURNAL_INVALID",
          "Preset journal contains an unsafe or sensitive key",
        );
      }
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
}

function validResourceDiff(value: unknown): value is LidarrPresetResourceDiff {
  if (!isPlainRecord(value)) return false;
  const action = value["action"];
  const required = [
    "key",
    "resource",
    "name",
    "dependencies",
    "impact",
    "fieldChanges",
    "action",
    "before",
    "after",
  ];
  if (
    action !== "create" &&
    action !== "update" &&
    action !== "unchanged" &&
    action !== "retained"
  ) {
    return false;
  }
  if (!exactKeys(value, action === "create" ? required : [...required, "liveId"])) return false;
  if (
    !validResourceKey(value["key"]) ||
    !validString(value["name"]) ||
    !Array.isArray(value["dependencies"]) ||
    value["dependencies"].length > JOURNAL_MAX_RESOURCES ||
    !value["dependencies"].every(validResourceKey) ||
    new Set(value["dependencies"]).size !== value["dependencies"].length ||
    !Array.isArray(value["fieldChanges"]) ||
    value["fieldChanges"].length > JOURNAL_MAX_RESOURCES ||
    !value["fieldChanges"].every(
      (change) =>
        isPlainRecord(change) &&
        exactKeys(change, ["path", "before", "after"]) &&
        validString(change["path"]),
    )
  ) {
    return false;
  }
  const resource = value["resource"];
  if (
    (resource !== "custom-format" && resource !== "quality-profile" && resource !== "naming") ||
    !String(value["key"]).startsWith(resource === "naming" ? "naming:" : `${resource}:`)
  ) {
    return false;
  }
  if (
    action !== "create" &&
    (!Number.isSafeInteger(value["liveId"]) || (value["liveId"] as number) <= 0)
  ) {
    return false;
  }
  if (
    (action === "create" && value["before"] !== null) ||
    (action === "retained" && value["after"] !== null)
  ) {
    return false;
  }
  const impact = value["impact"];
  if (!isPlainRecord(impact)) return false;
  if (
    (resource === "custom-format" &&
      (!exactKeys(impact, ["kind", "referencingQualityProfiles"]) ||
        impact["kind"] !== "custom-format" ||
        !validStringArray(impact["referencingQualityProfiles"]))) ||
    (resource === "quality-profile" &&
      (!exactKeys(impact, ["kind", "assignedArtistCount"]) ||
        impact["kind"] !== "quality-profile" ||
        !Number.isSafeInteger(impact["assignedArtistCount"]) ||
        (impact["assignedArtistCount"] as number) < 0)) ||
    (resource === "naming" &&
      (!exactKeys(impact, ["kind", "renamesExistingFiles"]) ||
        impact["kind"] !== "naming" ||
        impact["renamesExistingFiles"] !== false))
  ) {
    return false;
  }
  return true;
}

function validSafeError(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["code", "phase", "resourcePath", "retryable", "nextAction"]) &&
    validString(value["code"]) &&
    validString(value["phase"]) &&
    validString(value["resourcePath"]) &&
    typeof value["retryable"] === "boolean" &&
    validString(value["nextAction"])
  );
}

function validOutcome(value: unknown, resource: LidarrPresetResourceDiff): boolean {
  if (
    !isPlainRecord(value) ||
    value["key"] !== resource.key ||
    value["resource"] !== resource.resource ||
    value["name"] !== resource.name
  ) {
    return false;
  }
  const common = [
    "key",
    "resource",
    "name",
    "outcome",
    "attempted",
    "dispatchState",
    "verificationState",
  ];
  switch (value["outcome"]) {
    case "succeeded":
      return (
        exactKeys(value, common) &&
        value["attempted"] === true &&
        value["dispatchState"] === "dispatched" &&
        value["verificationState"] === "verified"
      );
    case "satisfied":
      return (
        exactKeys(value, common) &&
        typeof value["attempted"] === "boolean" &&
        (value["dispatchState"] === "not-dispatched" ||
          value["dispatchState"] === "dispatched" ||
          value["dispatchState"] === "dispatch-unknown") &&
        value["verificationState"] === "verified"
      );
    case "failed":
      return (
        exactKeys(value, [...common, "error"]) &&
        typeof value["attempted"] === "boolean" &&
        (value["dispatchState"] === "not-dispatched" ||
          value["dispatchState"] === "dispatched" ||
          value["dispatchState"] === "dispatch-unknown") &&
        (value["verificationState"] === "not-started" || value["verificationState"] === "failed") &&
        validSafeError(value["error"])
      );
    case "uncertain":
      return (
        exactKeys(value, [...common, "error"]) &&
        value["attempted"] === true &&
        (value["dispatchState"] === "dispatched" ||
          value["dispatchState"] === "dispatch-unknown") &&
        value["verificationState"] === "inconclusive" &&
        validSafeError(value["error"])
      );
    case "not-attempted":
      return (
        exactKeys(value, [...common, "blockedBy"]) &&
        value["attempted"] === false &&
        value["dispatchState"] === "not-dispatched" &&
        value["verificationState"] === "not-started" &&
        validResourceKey(value["blockedBy"])
      );
    default:
      return false;
  }
}

function validResourceState(value: unknown): value is LidarrPresetJournalResourceState {
  if (!isPlainRecord(value) || !validResourceDiff(value["resource"])) return false;
  if (value["state"] === "pending") return exactKeys(value, ["state", "resource"]);
  if (value["state"] === "dispatching") {
    return (
      exactKeys(value, ["state", "resource", "dispatchStartedAt"]) &&
      validTimestamp(value["dispatchStartedAt"])
    );
  }
  if (value["state"] === "terminal") {
    return (
      exactKeys(value, ["state", "resource", "outcome", "recordedAt"]) &&
      validOutcome(value["outcome"], value["resource"]) &&
      validTimestamp(value["recordedAt"])
    );
  }
  return false;
}

function serializeAndValidateJournal(
  journal: LidarrPresetApplyJournal,
  expectedOrigin: string,
): string {
  assertSafeJson(journal);
  if (
    !isPlainRecord(journal) ||
    !exactKeys(journal, [
      "schemaVersion",
      "id",
      "createdAt",
      "updatedAt",
      "status",
      "pack",
      "targetOrigin",
      "resources",
    ]) ||
    journal.schemaVersion !== LIDARR_PRESET_JOURNAL_VERSION ||
    !SECURE_STORE_UUID_PATTERN.test(journal.id) ||
    !validTimestamp(journal.createdAt) ||
    !validTimestamp(journal.updatedAt) ||
    Date.parse(journal.updatedAt) < Date.parse(journal.createdAt) ||
    canonicalizeOrigin(journal.targetOrigin) !== expectedOrigin ||
    !isPlainRecord(journal.pack) ||
    !exactKeys(journal.pack, ["source", "ref", "id", "version", "digest"]) ||
    (journal.pack.source !== "builtin" && journal.pack.source !== "config") ||
    journal.pack.ref !== `${journal.pack.source}:${journal.pack.id}` ||
    !validString(journal.pack.id) ||
    !Number.isSafeInteger(journal.pack.version) ||
    journal.pack.version <= 0 ||
    !DIGEST_PATTERN.test(journal.pack.digest) ||
    !["in-progress", "completed", "partial", "failed", "uncertain"].includes(journal.status) ||
    !Array.isArray(journal.resources) ||
    journal.resources.length === 0 ||
    journal.resources.length > JOURNAL_MAX_RESOURCES ||
    !journal.resources.every(validResourceState)
  ) {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset apply journal is invalid");
  }
  const keys = journal.resources.map((state) => state.resource.key);
  if (new Set(keys).size !== keys.length) {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset apply journal has duplicate resources");
  }
  const text = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > LIDARR_PRESET_JOURNAL_MAX_BYTES) {
    throw fail("LIDARR_PRESET_JOURNAL_TOO_LARGE", "Preset apply journal exceeds its byte limit");
  }
  return text;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTransition(
  previous: LidarrPresetApplyJournal,
  next: LidarrPresetApplyJournal,
  final: boolean,
): void {
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.id !== next.id ||
    previous.createdAt !== next.createdAt ||
    previous.targetOrigin !== next.targetOrigin ||
    !sameJson(previous.pack, next.pack) ||
    previous.resources.length !== next.resources.length ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
    previous.status !== "in-progress"
  ) {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal identity or ordering changed");
  }
  for (const [index, prior] of previous.resources.entries()) {
    const current = next.resources[index];
    if (current === undefined || !sameJson(prior.resource, current.resource)) {
      throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal resource intent changed");
    }
    const allowed =
      prior.state === current.state ||
      (prior.state === "pending" &&
        (current.state === "dispatching" || current.state === "terminal")) ||
      (prior.state === "dispatching" && current.state === "terminal");
    const skippedDispatchBoundary =
      prior.state === "pending" && current.state === "terminal" && current.outcome.attempted;
    if (
      !allowed ||
      skippedDispatchBoundary ||
      (prior.state === "terminal" && !sameJson(prior, current))
    ) {
      throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset journal state moved backward");
    }
  }
  if (final) {
    if (
      next.status === "in-progress" ||
      next.resources.some((state) => state.state !== "terminal")
    ) {
      throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Final journal must contain terminal outcomes");
    }
  } else if (next.status !== "in-progress") {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Journal transition must remain in progress");
  }
}

const ownedLocks = new WeakMap<LidarrPresetApplyLock, OwnedLockState>();

/** Acquires the local exclusive lock for one exact canonical Lidarr origin. */
export async function acquireLidarrPresetApplyLock(
  canonicalOrigin: string,
  dependencies: LidarrPresetPersistenceDependencies = {},
): Promise<LidarrPresetApplyLock> {
  const origin = canonicalizeOrigin(canonicalOrigin);
  const digest = originDigest(origin);
  const storageDirectory = resolveStoragePath(
    dependencies.storageDirectory ?? join(getDefaultPlanDir(), "lidarr-preset-applies"),
  );
  const lockPath = join(storageDirectory, "locks", `${digest}.lock`);
  const host = dependencies.hostname?.() ?? nodeHostname();
  const pid = dependencies.pid ?? process.pid;
  if (!validString(host) || !Number.isSafeInteger(pid) || pid <= 0) {
    throw fail("LIDARR_PRESET_LOCK_METADATA_INVALID", "Preset lock owner metadata is invalid");
  }
  // Preserves the ownership-token half of the pre-migration owner-metadata check:
  // an injected UUID seam that yields a value outside the accepted UUID shape is
  // owner-metadata corruption, not a lock failure. Thrown from inside
  // `acquireExclusiveLock`, it reaches the translator below as a
  // LidarrPresetPersistenceError and is rethrown unchanged.
  const randomUUID = (): string => {
    const value = (dependencies.randomUUID ?? nodeRandomUUID)();
    if (!SECURE_STORE_UUID_PATTERN.test(value)) {
      throw fail("LIDARR_PRESET_LOCK_METADATA_INVALID", "Preset lock owner metadata is invalid");
    }
    return value;
  };
  const nowSource = dependencies.now;
  const nowMs = nowSource === undefined ? Date.now : (): number => nowSource().getTime();

  let held: SecureStoreLock;
  try {
    held = await acquireExclusiveLock(lockPath, {
      subject: LOCK_SUBJECT,
      // Fail fast: zero wait. A contended acquire reaches the deadline check with
      // `remainingMs === 0` and throws SECURE_STORE_LOCK_BUSY on the first pass,
      // reproducing the pre-migration semantics exactly. The sole production
      // caller acquires this lock before its AbortController and its Ctrl-C
      // cleanup handler exist, so a waiting acquisition would be uninterruptible.
      deadlineEpochMs: nowMs(),
      // No age-based steal. A preset apply drives per-entry network mutations with
      // assertOwned() between each and routinely exceeds SECURE_STORE_LOCK_MAX_AGE_MS;
      // the default would let a second process steal a LIVE owner's lock cross-host.
      maxAgeMs: null,
      // Replaces the bespoke `originDigest` record key and its cross-check. A
      // record written by the pre-migration build still carries the digest under
      // `originDigest`; `parseLockRecord` accepts that shape so the dead-pid
      // steal below still clears a lock stranded by the shipped build.
      binding: digest,
      now: nowMs,
      hostname: () => host,
      pid,
      // Deliberately this module's own probe, not `isProcessAliveByDefault`: an
      // unknown errno means ALIVE here and DEAD there. Migrating a lock must not
      // silently migrate its liveness policy.
      isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
      randomUUID,
    });
  } catch (error) {
    throw translateLockFailure(error, lockPath, "Unable to acquire preset apply lock");
  }

  const state: OwnedLockState = { canonicalOrigin: origin, storageDirectory };
  const lock: LidarrPresetApplyLock = {
    path: held.path,
    originDigest: digest,
    assertOwned: async (): Promise<void> => {
      try {
        await held.assertOwned();
      } catch (error) {
        throw fail(
          "LIDARR_PRESET_LOCK_LOST",
          "Preset apply lock is no longer owned",
          held.path,
          error,
        );
      }
    },
    release: async (): Promise<void> => {
      try {
        await held.release();
      } catch (error) {
        // A record we cannot parse, or one carrying foreign access bits, is by
        // definition not a record this acquisition published, so there is
        // nothing of ours left to unlink. Both resolve to "not owned" rather
        // than to a failure.
        //
        // `SECURE_STORE_PERMISSIONS` is load-bearing: the shared
        // `readBoundedPrivateFile` (`secure-store/paths.ts`) rejects any mode
        // carrying group/other bits, where the pre-#288 `readBoundedFile` had
        // no mode check at all and `readLock` returned `undefined`. `release()`
        // runs inside a `finally` in the sole production caller
        // (`actions/lidarr/profile-presets.ts:894-901`), so a throw here
        // discards the `applyResult(...)` already being returned.
        if (
          error instanceof SecureStoreError &&
          (error.code === "SECURE_STORE_CORRUPT" || error.code === "SECURE_STORE_PERMISSIONS")
        ) {
          return;
        }
        throw translateLockFailure(error, held.path, "Unable to release preset apply lock");
      }
    },
  };
  ownedLocks.set(lock, state);
  return Object.freeze(lock);
}

/** Creates the durable pre-dispatch intent journal while the origin lock is owned. */
export async function createLidarrPresetApplyJournal(
  lock: LidarrPresetApplyLock,
  initial: LidarrPresetApplyJournal,
): Promise<LidarrPresetApplyJournalHandle> {
  const lockState = ownedLocks.get(lock);
  if (lockState === undefined) {
    throw fail("LIDARR_PRESET_LOCK_LOST", "Preset apply lock is not owned by this process");
  }
  await lock.assertOwned();
  if (
    initial.status !== "in-progress" ||
    initial.resources.some((resource) => resource.state !== "pending")
  ) {
    throw fail(
      "LIDARR_PRESET_JOURNAL_INVALID",
      "Initial preset journal must contain pending intent",
    );
  }
  const text = serializeAndValidateJournal(initial, lockState.canonicalOrigin);
  const path = join(lockState.storageDirectory, "journals", `${initial.id}.json`);
  let identity: FileIdentity;
  try {
    identity = await createPrivateFileAtomically({
      path,
      text,
      subject: JOURNAL_SUBJECT,
      temporaryId: initial.id,
    });
  } catch (error) {
    throw translateJournalIo(error, path, "Unable to create preset apply journal");
  }
  let current = initial;
  let finished = false;
  let writing = false;

  const write = async (next: LidarrPresetApplyJournal, final: boolean): Promise<void> => {
    if (finished || writing) {
      throw fail(
        "LIDARR_PRESET_JOURNAL_INVALID",
        finished
          ? "Preset journal is already final"
          : "Preset journal update is already in progress",
        path,
      );
    }
    writing = true;
    try {
      await lock.assertOwned();
      const nextText = serializeAndValidateJournal(next, lockState.canonicalOrigin);
      assertTransition(current, next, final);
      try {
        identity = await replacePrivateFileAtomically({
          path,
          text: nextText,
          subject: JOURNAL_SUBJECT,
          temporaryId: initial.id,
          expectedIdentity: identity,
        });
      } catch (error) {
        throw translateJournalIo(error, path, "Unable to update preset apply journal");
      }
      current = next;
      finished = final;
    } finally {
      writing = false;
    }
  };

  return Object.freeze({
    path,
    transition: (next: LidarrPresetApplyJournal) => write(next, false),
    finalize: (next: LidarrPresetApplyJournal) => write(next, true),
  });
}
