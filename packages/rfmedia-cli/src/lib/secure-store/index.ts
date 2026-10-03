/**
 * Hardened filesystem primitives for private documents and plan artifacts.
 *
 * This is the canonical home for the private-file/private-directory mode
 * constants, the safe-path machinery, strict-default bounded readers, atomic
 * writers, and the `link()`-based exclusive lock. Plan I/O selects explicit
 * compatibility policies for foreign read bits and final-parent hardening;
 * credential, lock, and preset consumers retain the strict defaults.
 *
 * What stays outside it is a decision, not an omission. Domain serializers,
 * validators, error translation, and append-only audit behavior remain local.
 * `filesystem.ts`'s `0o600` is a transient staging floor that is later relaxed,
 * not a private-document mode, and must never import `PRIVATE_FILE_MODE`.
 *
 * Import from this barrel; the submodules have no supported deep-import path.
 */

export {
  containsTerminalControl,
  hasErrorCode,
  isTerminalControlCodePoint,
  rethrowAsSecureStoreError,
  sanitizePathForMessage,
  SecureStoreError,
  secureStoreError,
} from "./errors.js";
export type { SecureStoreErrorCode, SecureStoreErrorOptions } from "./errors.js";

export {
  assertOpenedFileIdentity,
  assertOpenedFileIdentitySync,
  assertSafeParentUnchanged,
  assertSafeParentUnchangedSync,
  prepareSafeParent,
  prepareSafeParentSync,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  readBoundedPrivateFile,
  readBoundedPrivateFileSync,
  resolveSecurePath,
  sameIdentity,
  SECURE_STORE_MAX_PATH_LENGTH,
} from "./paths.js";
export type {
  BoundedPrivateFileModePolicy,
  BoundedPrivateRead,
  FileIdentity,
  FinalParentPolicy,
  ReadParentPolicy,
  SafeParent,
} from "./paths.js";

export {
  createPrivateFileAtomically,
  removeOrphanedTemporaryFiles,
  replacePrivateFileAtomically,
  syncDirectory,
} from "./atomic.js";
export type {
  AtomicReplaceInput,
  AtomicWriteInput,
  OrphanedTemporarySweepInput,
} from "./atomic.js";

export {
  acquireExclusiveLock,
  isProcessAliveByDefault,
  SECURE_STORE_LOCK_MAX_AGE_MS,
  SECURE_STORE_UUID_PATTERN,
} from "./lock.js";
export type { SecureStoreLock, SecureStoreLockOptions, SecureStoreLockRecord } from "./lock.js";
