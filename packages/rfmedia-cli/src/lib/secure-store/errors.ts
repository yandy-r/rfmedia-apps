/**
 * Typed, secret-free failures raised by the hardened secure-store primitives.
 *
 * Messages come from a frozen table and are **subject-parameterized**: the
 * caller supplies a short human subject (for example `"Plex credential store"`)
 * so a shared primitive can name the document it protects without knowing
 * anything about it. No file-supplied or server-supplied byte ever reaches a
 * message, so terminal/bidi injection is impossible by construction rather than
 * by sanitization.
 */

/** Every failure mode the secure-store primitives can surface to a caller. */
export type SecureStoreErrorCode =
  | "SECURE_STORE_UNSAFE_PATH"
  | "SECURE_STORE_PERMISSIONS"
  | "SECURE_STORE_CORRUPT"
  | "SECURE_STORE_VERSION_CONFLICT"
  | "SECURE_STORE_LOCK_BUSY"
  | "SECURE_STORE_CANCELLED"
  | "SECURE_STORE_TOO_LARGE";

/** Longest path retained on an error; longer paths are truncated. */
const MAX_PRINTABLE_PATH_LENGTH = 512;

const SECURE_STORE_MESSAGES: Readonly<Record<SecureStoreErrorCode, (subject: string) => string>> =
  Object.freeze({
    SECURE_STORE_UNSAFE_PATH: (subject: string): string =>
      `${subject} path or one of its parent directories is unsafe`,
    SECURE_STORE_PERMISSIONS: (subject: string): string =>
      `${subject} file is accessible to another user`,
    SECURE_STORE_CORRUPT: (subject: string): string => `${subject} file contents are unreadable`,
    SECURE_STORE_VERSION_CONFLICT: (subject: string): string =>
      `${subject} file was replaced by another writer`,
    SECURE_STORE_LOCK_BUSY: (subject: string): string => `${subject} is locked by another process`,
    SECURE_STORE_CANCELLED: (subject: string): string => `${subject} update was cancelled`,
    SECURE_STORE_TOO_LARGE: (subject: string): string =>
      `${subject} file is larger than this build accepts`,
  });

const SECURE_STORE_REMEDIATIONS: Readonly<Record<SecureStoreErrorCode, (path: string) => string>> =
  Object.freeze({
    SECURE_STORE_UNSAFE_PATH: (path: string): string =>
      `Inspect ${path} and its parent directories; remove symlinks and group/other write permissions.`,
    SECURE_STORE_PERMISSIONS: (path: string): string => `chmod 600 ${path}`,
    SECURE_STORE_CORRUPT: (path: string): string => `Delete ${path} and create it again.`,
    SECURE_STORE_VERSION_CONFLICT: (path: string): string =>
      `Re-read ${path} under the lock and retry the update.`,
    SECURE_STORE_LOCK_BUSY: (path: string): string =>
      `Wait for the process that owns ${path} to finish, then retry; delete that file only if no such process exists.`,
    SECURE_STORE_CANCELLED: (path: string): string => `Re-run the command to update ${path}.`,
    SECURE_STORE_TOO_LARGE: (path: string): string =>
      `Inspect ${path}; it exceeds the size this build will read.`,
  });

/**
 * Reports whether a code point is a C0/C1 control or a Unicode bidi control.
 *
 * Expressed as explicit numeric ranges rather than a regular expression so this
 * source file never itself contains a control character. Bidi ranges are
 * U+061C, U+200E..U+200F, U+202A..U+202E and U+2066..U+2069.
 *
 * @param codePoint - Unicode code point to classify.
 * @returns `true` when the code point must never reach a terminal.
 */
export function isTerminalControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Reports whether a string contains any control or bidi character.
 *
 * @param value - String to inspect.
 * @returns `true` when at least one character must never reach a terminal.
 */
export function containsTerminalControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isTerminalControlCodePoint(codePoint)) return true;
  }
  return false;
}

/**
 * Removes control and bidi characters from a path and bounds its length so it
 * can be embedded in an error message or written to a terminal.
 *
 * @param path - Raw filesystem path.
 * @returns The printable form of `path`.
 */
export function sanitizePathForMessage(path: string): string {
  let stripped = "";
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isTerminalControlCodePoint(codePoint)) continue;
    stripped += character;
  }
  return stripped.length > MAX_PRINTABLE_PATH_LENGTH
    ? `${stripped.slice(0, MAX_PRINTABLE_PATH_LENGTH)}...`
    : stripped;
}

/** Construction inputs for {@link SecureStoreError}. */
export interface SecureStoreErrorOptions {
  /** Stable machine-readable discriminator. */
  readonly code: SecureStoreErrorCode;
  /** Short human name of the protected document, e.g. `"Plex credential store"`. */
  readonly subject: string;
  /** Filesystem path the failure concerns. Sanitized before it is retained. */
  readonly path: string;
  /** Underlying `NodeJS.ErrnoException`, when there was one. */
  readonly cause?: unknown;
}

/**
 * Stable, secret-free failure raised by the secure-store primitives.
 *
 * Both {@link SecureStoreError.message} and {@link SecureStoreError.remediation}
 * are safe to print: the message is a fixed local literal and the path has had
 * control and bidi characters removed.
 */
export class SecureStoreError extends Error {
  override readonly name = "SecureStoreError";
  /** Stable machine-readable discriminator. */
  readonly code: SecureStoreErrorCode;
  /** Short human name of the protected document. */
  readonly subject: string;
  /** Printable path: control/bidi characters removed, truncated to 512 chars. */
  readonly path: string;
  /** Fixed local literal naming the next action the operator should take. */
  readonly remediation: string;

  constructor(options: SecureStoreErrorOptions) {
    super(
      SECURE_STORE_MESSAGES[options.code](options.subject),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    const printablePath = sanitizePathForMessage(options.path);
    this.code = options.code;
    this.subject = options.subject;
    this.path = printablePath;
    this.remediation = SECURE_STORE_REMEDIATIONS[options.code](printablePath);
  }
}

/**
 * Builds a {@link SecureStoreError}.
 *
 * @param code - Stable machine-readable discriminator.
 * @param subject - Short human name of the protected document.
 * @param path - Filesystem path the failure concerns.
 * @param cause - Underlying error, when there was one.
 * @returns The constructed error, ready to throw.
 */
export function secureStoreError(
  code: SecureStoreErrorCode,
  subject: string,
  path: string,
  cause?: unknown,
): SecureStoreError {
  return new SecureStoreError({ code, subject, path, cause });
}

/**
 * Reports whether an unknown thrown value is a Node error carrying `code`.
 *
 * @param error - Value caught from a filesystem call.
 * @param code - `errno` string such as `"ENOENT"` or `"EEXIST"`.
 * @returns `true` when `error` is an `Error` whose `code` matches.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Maps a raw filesystem `errno` onto the secure-store code union and throws.
 *
 * Errors with no faithful mapping (`ENOSPC`, `EIO`, `EROFS`, ...) are rethrown
 * unchanged rather than forced into an inaccurate code — inventing a
 * classification would hide the real fault.
 *
 * @param error - Value caught from a filesystem call.
 * @param subject - Short human name of the protected document.
 * @param path - Filesystem path the failure concerns.
 * @throws {SecureStoreError} for path- and permission-shaped `errno` values.
 * @throws The original error for every other value.
 */
export function rethrowAsSecureStoreError(error: unknown, subject: string, path: string): never {
  if (error instanceof SecureStoreError) throw error;
  if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "ENOTDIR")) {
    throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path, error);
  }
  if (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")) {
    throw secureStoreError("SECURE_STORE_PERMISSIONS", subject, path, error);
  }
  throw error;
}
