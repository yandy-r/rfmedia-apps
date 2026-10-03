/**
 * Typed, secret-free failures for the Plex credential lifecycle (issue #251).
 *
 * SECURITY INVARIANT: every user-visible string produced here comes from a
 * frozen local literal table. No function in this module accepts server-supplied
 * text, so terminal/bidi injection from `plex.tv` or a Plex Media Server is
 * impossible **by construction** rather than by sanitization.
 *
 * The only caller-supplied strings are {@link PlexAuthErrorOptions.path} — a
 * locally constructed filesystem path — and
 * {@link PlexAuthErrorOptions.observedKeys} — response key NAMES already bounded
 * and charset-filtered by `jwt-wire.ts`. Neither is ever read from a wire
 * `message` field, and `observedKeys` never enters {@link Error.message}.
 */

/**
 * Every failure mode of the Plex enrollment, refresh, and credential-store
 * lifecycle.
 *
 * The union is closed on purpose: {@link PLEX_AUTH_MESSAGES} and the remediation
 * table are `Readonly<Record<PlexAuthErrorCode, string>>` mapped types, so
 * adding a member here without adding both entries is a compile error.
 *
 * `SecureStoreErrorCode` values are mapped onto this union 1:1 by the credential
 * store, with `SECURE_STORE_LOCK_BUSY` mapping to `PLEX_AUTH_REFRESH_BUSY`.
 */
export type PlexAuthErrorCode =
  | "PLEX_AUTH_NOT_ENROLLED"
  | "PLEX_AUTH_ORIGIN_NOT_AUTHORIZED"
  | "PLEX_AUTH_STORE_UNSAFE_PATH"
  | "PLEX_AUTH_STORE_PERMISSIONS"
  | "PLEX_AUTH_STORE_CORRUPT"
  | "PLEX_AUTH_STORE_VERSION_CONFLICT"
  | "PLEX_AUTH_REFRESH_BUSY"
  | "PLEX_AUTH_RATE_LIMITED"
  | "PLEX_AUTH_ENROLLMENT_EXPIRED"
  | "PLEX_AUTH_KEY_REJECTED"
  | "PLEX_AUTH_UNREACHABLE"
  | "PLEX_AUTH_CANCELLED"
  | "PLEX_AUTH_PMS_REJECTED"
  | "PLEX_AUTH_INVALID_RESPONSE"
  | "PLEX_AUTH_CLOCK_SKEW";

/**
 * Upper bound on reactive (post-401/422) credential refreshes a single process
 * will attempt for one credential store.
 *
 * `handleAuthFailure` bypasses the proactive freshness gate, so without a cap a
 * server that answers 401 unconditionally would spend the IP-scoped nonce budget
 * (measured: 10 per 300 s) in a single command. Beyond this count the provider
 * returns `"fail"` and makes no network call at all.
 */
export const PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS = 2;

/**
 * Substituted into a remediation template when the failure carried no
 * locally-constructed path. Deliberately shaped like a shell placeholder so the
 * remediation still reads as a runnable command.
 */
const PLEX_AUTH_PATH_PLACEHOLDER = "<path>";

/** Token replaced by {@link PlexAuthErrorOptions.path} in a remediation template. */
const PLEX_AUTH_PATH_TOKEN = "{path}";

/**
 * Frozen user-facing message for every {@link PlexAuthErrorCode}.
 *
 * Messages describe *what happened* only; the next command to run lives in
 * {@link PlexAuthError.remediation}. Several plex.tv HTTP statuses collapse onto
 * one code (for example HTTP 400, 422/1008, and an unrecognized 2xx body all
 * yield `PLEX_AUTH_INVALID_RESPONSE`), so the text is written to cover the whole
 * class of failure rather than one status.
 */
const PLEX_AUTH_MESSAGES: Readonly<Record<PlexAuthErrorCode, string>> = Object.freeze({
  PLEX_AUTH_NOT_ENROLLED:
    "This Plex client is not enrolled; browser authorization was never completed.",
  PLEX_AUTH_ORIGIN_NOT_AUTHORIZED:
    "The stored Plex credential is not authorized for this server origin.",
  PLEX_AUTH_STORE_UNSAFE_PATH:
    "The Plex credential store path is unsafe: a symlink, a foreign owner, or a group/world-writable directory was found on it.",
  PLEX_AUTH_STORE_PERMISSIONS:
    "The Plex credential store is readable by users other than its owner.",
  PLEX_AUTH_STORE_CORRUPT:
    "The Plex credential store could not be parsed as a valid store document.",
  PLEX_AUTH_STORE_VERSION_CONFLICT:
    "Another rfmedia process replaced the Plex credential store during this write.",
  PLEX_AUTH_REFRESH_BUSY: "Another rfmedia process is holding the Plex credential refresh lock.",
  PLEX_AUTH_RATE_LIMITED:
    "Plex is rate limiting this network address; the enrollment budget is shared per IP.",
  PLEX_AUTH_ENROLLMENT_EXPIRED: "The Plex authorization code expired before it was claimed.",
  PLEX_AUTH_KEY_REJECTED: "Plex did not recognize this client's signing key.",
  PLEX_AUTH_UNREACHABLE: "Plex could not be reached over the network.",
  PLEX_AUTH_CANCELLED: "The Plex credential operation was cancelled before it completed.",
  PLEX_AUTH_PMS_REJECTED:
    "The Plex Media Server rejected the newly issued credential; it was discarded and nothing was persisted.",
  PLEX_AUTH_INVALID_RESPONSE:
    "Plex returned a response this build does not recognize; its wire mapping may be stale.",
  PLEX_AUTH_CLOCK_SKEW:
    "The Plex credential was already expired when it was issued; this system's clock is wrong.",
});

/**
 * Frozen remediation template for every {@link PlexAuthErrorCode}.
 *
 * Each entry names the exact next command wherever one exists. The
 * {@link PLEX_AUTH_PATH_TOKEN} placeholder is replaced with the failure's
 * locally-constructed {@link PlexAuthErrorOptions.path}; no other interpolation
 * is possible, and no wire text can reach these strings.
 */
const PLEX_AUTH_REMEDIATIONS: Readonly<Record<PlexAuthErrorCode, string>> = Object.freeze({
  PLEX_AUTH_NOT_ENROLLED: "Run: rfmedia plex auth login",
  PLEX_AUTH_ORIGIN_NOT_AUTHORIZED:
    "Authorize this server explicitly. Run: rfmedia plex auth login --plex-url <url>",
  PLEX_AUTH_STORE_UNSAFE_PATH:
    "Remove the unsafe entry on {path} (and tighten its parent directories to 0700), then run: rfmedia plex auth login",
  PLEX_AUTH_STORE_PERMISSIONS: "Run: chmod 600 {path}",
  PLEX_AUTH_STORE_CORRUPT: "Delete {path}, then run: rfmedia plex auth login",
  PLEX_AUTH_STORE_VERSION_CONFLICT:
    "Run the command again; the other process has already finished writing.",
  PLEX_AUTH_REFRESH_BUSY:
    "Wait for the other rfmedia process to finish. If none is running, delete the stale lock file at {path}.",
  PLEX_AUTH_RATE_LIMITED:
    "Wait for the reported retry-after window to elapse, then run: rfmedia plex auth refresh. Rate limits are per IP address and cannot be bypassed with --force.",
  PLEX_AUTH_ENROLLMENT_EXPIRED: "Run: rfmedia plex auth login",
  PLEX_AUTH_KEY_REJECTED: "Run: rfmedia plex auth login",
  PLEX_AUTH_UNREACHABLE:
    "Check network connectivity and the configured Plex URL, then run the command again.",
  PLEX_AUTH_CANCELLED: "Run the command again when ready.",
  PLEX_AUTH_PMS_REJECTED:
    "This server does not accept plex.tv-issued JWTs, and per-server access-token exchange is not implemented in this build. Set plex.token (or pass --plex-token) to keep using a legacy token, and report this so the exchange can be added.",
  PLEX_AUTH_INVALID_RESPONSE:
    "Upgrade rfmedia. If the failure persists, report the diagnostics.observedKeys field from --output json.",
  PLEX_AUTH_CLOCK_SKEW: "Synchronize this system's clock, then run: rfmedia plex auth refresh",
});

/**
 * Resolves the frozen remediation template for `code`, substituting the
 * locally-constructed `path` when the template names one.
 *
 * @param code - Failure code whose remediation is required.
 * @param path - Locally constructed filesystem path, or `undefined`.
 * @returns The remediation sentence to show the user.
 */
function buildPlexAuthRemediation(code: PlexAuthErrorCode, path: string | undefined): string {
  return PLEX_AUTH_REMEDIATIONS[code].replaceAll(
    PLEX_AUTH_PATH_TOKEN,
    path ?? PLEX_AUTH_PATH_PLACEHOLDER,
  );
}

/** Optional context attached to a {@link PlexAuthError}. */
export interface PlexAuthErrorOptions {
  /**
   * Server-advertised cooperative wait in seconds. Mandatory in practice for
   * `PLEX_AUTH_RATE_LIMITED`, whose failure envelope always reports it.
   */
  readonly retryAfterSeconds?: number;
  /**
   * A locally constructed filesystem path — the credential store for the
   * `PLEX_AUTH_STORE_*` codes, the lock file for `PLEX_AUTH_REFRESH_BUSY`.
   *
   * NEVER pass server-supplied text here: it is interpolated into
   * {@link PlexAuthError.remediation} and rendered in a terminal.
   */
  readonly path?: string;
  /**
   * Response key NAMES observed on an unrecognized 2xx body, already bounded and
   * charset-filtered by `jwt-wire.ts`. Diagnostics only — never rendered in
   * {@link Error.message}, only in the `--output json` `diagnostics` field and
   * under `--debug`.
   */
  readonly observedKeys?: readonly string[];
}

/**
 * Typed failure of the Plex credential lifecycle.
 *
 * The instance is frozen after construction, so neither the code, the
 * remediation, nor the diagnostics can be rewritten as the error propagates
 * through the provider, the action layer, and the command layer.
 *
 * @example
 * ```
 * throw new PlexAuthError("PLEX_AUTH_STORE_PERMISSIONS", { path: storePath });
 * ```
 */
export class PlexAuthError extends Error {
  override readonly name = "PlexAuthError";
  /** Discriminator used for mapping onto `MediaServerError` and JSON envelopes. */
  readonly code: PlexAuthErrorCode;
  /** Frozen local literal naming the exact next command to run. */
  readonly remediation: string;
  /** Server-advertised cooperative wait in seconds, when one was supplied. */
  readonly retryAfterSeconds?: number;
  /** Locally constructed filesystem path only — never wire text. */
  readonly path?: string;
  /** Bounded, charset-filtered response key NAMES. Never rendered in `message`. */
  readonly observedKeys?: readonly string[];

  /**
   * @param code - Failure code selecting the frozen message and remediation.
   * @param options - Optional diagnostics; see {@link PlexAuthErrorOptions}.
   */
  constructor(code: PlexAuthErrorCode, options: PlexAuthErrorOptions = {}) {
    super(PLEX_AUTH_MESSAGES[code]);
    this.code = code;
    this.remediation = buildPlexAuthRemediation(code, options.path);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.path = options.path;
    this.observedKeys =
      options.observedKeys === undefined ? undefined : Object.freeze([...options.observedKeys]);
    Object.freeze(this);
  }
}
