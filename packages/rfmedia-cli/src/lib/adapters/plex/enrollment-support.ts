/**
 * Shared seams, constants, and pure primitives for the four Plex credential
 * verbs (issue #251).
 *
 * Split out of `enrollment.ts` so the login/status/logout module and the refresh
 * module share ONE definition of every cross-cutting rule — most importantly the
 * origin authority and the assertion audience. A second copy of either would
 * diverge silently: a looser origin rule weakens the cross-origin credential
 * guard, and a stricter one makes a working enrollment resolve as `not-enrolled`.
 *
 * Nothing here performs IO of its own; the only side effect is the stderr sink
 * used to show the user their authorization link.
 */

import { normalizePlexOrigin } from "../../plex-origin.js";
import type { PlexTokenProvider } from "./auth.js";
import { PlexClient } from "./client.js";
import type { PlexTransport } from "./client.js";
import type { PlexAuthStoreDependencies, PlexAuthStoreHandle } from "./credential-store.js";
import type { PlexAccountProtocol } from "./enrollment-client.js";
import { PlexAuthError } from "./errors.js";
import { signCompactJws } from "./jwt.js";
import { PLEX_ACCOUNT_ORIGIN } from "./jwt-wire.js";
import type { PlexAccountWire } from "./jwt-wire.js";
import type { PlexConnectionSettings } from "./types.js";

/**
 * Where a user removes a device from their Plex account.
 *
 * `logout` can only destroy the LOCAL root of authority: no client-callable
 * revocation endpoint is documented, so this URL is returned rather than the gap
 * being faked as a server call.
 */
export const PLEX_AUTHORIZED_DEVICES_URL = "https://app.plex.tv/desktop/#!/settings/devices";

/** Assertion `aud`. A module constant, never caller-supplied. */
export const PLEX_ASSERTION_AUDIENCE = PLEX_ACCOUNT_ORIGIN;

/** Assertion validity. Covers a 30-minute strong pin, under the wire's 3600 s cap. */
export const ASSERTION_LIFETIME_SECONDS = 1800;

/** Ceiling on how long any verb waits for the inter-process store lock. */
export const LOCK_WAIT_BUDGET_MS = 60_000;

/** Shared unit conversion for the epoch arithmetic every verb performs. */
export const MILLISECONDS_PER_SECOND = 1000;

const DEVICE_NAME_MAX_LENGTH = 64;

/** Used when the host name yields no printable label of its own. */
const FALLBACK_DEVICE_NAME = "rfmedia-cli";

/** Characters a device label may keep: printable ASCII, space included. */
const NON_PRINTABLE_LABEL_PATTERN = /[^ -~]+/gu;

/** Stripped from anything written to a terminal, as defence in depth. */
const BIDI_CONTROL_PATTERN = /\p{Bidi_Control}/gu;

/** Test seams for the four verbs. Every field has a production default. */
export interface PlexEnrollmentDependencies {
  /** Credential-store seams: path override, clock, host name, pid, liveness. */
  readonly store?: PlexAuthStoreDependencies;
  /** plex.tv account transport. Defaults to a real `PlexEnrollmentClient`. */
  readonly account?: PlexAccountProtocol;
  /** Pure wire mapping, so a protocol correction never touches these modules. */
  readonly wire?: PlexAccountWire;
  /** Builds the throwaway PMS transport used by the verify-before-persist probe. */
  readonly createProbeTransport?: (
    connection: PlexConnectionSettings,
    provider: PlexTokenProvider,
  ) => PlexTransport;
  /** Epoch milliseconds. Injected for deterministic tests. */
  readonly now?: () => number;
  /** Cancellable sleep backing the pin poll. */
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Stderr sink for the authorization code and link. */
  readonly notify?: (line: string) => void;
  /** Source of the per-install client identifier minted by every `login`. */
  readonly randomUUID?: () => string;
  /** Source of the default device label. */
  readonly hostname?: () => string;
}

/**
 * Writes one line to stderr.
 *
 * Enrollment prompts must never reach stdout, which belongs to `formatOutput`,
 * and must never be suppressed by a log level, because a headless `login` is
 * unusable without its link.
 *
 * @param line - Already-bounded, already-printable text.
 */
export function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Sleeps for `milliseconds`, rejecting immediately when `signal` aborts.
 *
 * @param milliseconds - Delay before resolution.
 * @param signal - Caller cancellation, checked before and during the wait.
 * @returns A promise resolved after the delay.
 * @throws {PlexAuthError} `PLEX_AUTH_CANCELLED` when the signal aborts.
 */
export function delayCancellably(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new PlexAuthError("PLEX_AUTH_CANCELLED"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new PlexAuthError("PLEX_AUTH_CANCELLED"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Builds the throwaway transport the enrollment probe uses.
 *
 * @param connection - Connection bound to the freshly issued credential.
 * @param provider - Static provider; the rotating one must never be used here.
 * @returns A one-shot Plex transport.
 */
export function defaultProbeTransport(
  connection: PlexConnectionSettings,
  provider: PlexTokenProvider,
): PlexTransport {
  return new PlexClient(connection, provider);
}

/**
 * Bounds and de-fangs a string before it is written to a terminal.
 *
 * @param value - Text to print.
 * @param maxLength - Hard character ceiling.
 * @returns The bidi-stripped, truncated text.
 */
export function toPrintable(value: string, maxLength: number): string {
  return value.replace(BIDI_CONTROL_PATTERN, "").slice(0, maxLength);
}

/**
 * Resolves the device label shown on the plex.tv approval screen.
 *
 * An explicitly requested label that survives no printable character is a user
 * error and fails fast; a host name that survives none only means the machine is
 * poorly named, so the product name is used instead.
 *
 * @param requested - Caller-supplied `--device-name`, if any.
 * @param readHostname - Source of the default label.
 * @returns A non-empty label of at most 64 printable ASCII characters.
 * @throws TypeError when an explicit label contains nothing printable.
 */
export function resolveDeviceName(
  requested: string | undefined,
  readHostname: () => string,
): string {
  const clean = (value: string): string =>
    value.replace(NON_PRINTABLE_LABEL_PATTERN, "").trim().slice(0, DEVICE_NAME_MAX_LENGTH);

  if (requested !== undefined) {
    const cleaned = clean(requested);
    if (cleaned.length === 0) {
      throw new TypeError("Plex device name must contain at least one printable ASCII character");
    }
    return cleaned;
  }
  const derived = clean(readHostname());
  return derived.length === 0 ? FALLBACK_DEVICE_NAME : derived;
}

/**
 * Normalizes a raw Plex URL through the single origin authority.
 *
 * @param value - Raw `--plex-url ?? plex.url`.
 * @returns The canonical origin.
 * @throws TypeError when the value is not a bare `http(s)` origin.
 */
export function requirePlexOrigin(value: string): string {
  const origin = normalizePlexOrigin(value);
  if (origin === undefined) {
    throw new TypeError(
      "Plex server URL must be a bare http(s) origin, for example http://localhost:32400",
    );
  }
  return origin;
}

/**
 * Validates a caller-supplied timeout.
 *
 * @param requested - Whole seconds requested, if any.
 * @param fallback - Value used when none was requested.
 * @returns The effective timeout in whole seconds.
 * @throws TypeError when the request is not a positive whole number.
 */
export function requireTimeoutSeconds(requested: number | undefined, fallback: number): number {
  if (requested === undefined) return fallback;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new TypeError("Plex authorization timeout must be a positive whole number of seconds");
  }
  return requested;
}

/**
 * Converts a caller timeout into a lock-wait budget, capped at 60 seconds.
 *
 * @param timeoutSeconds - Whole seconds requested, if any.
 * @returns The lock-wait budget in milliseconds.
 * @throws TypeError when the request is not a positive whole number.
 */
export function lockWaitMilliseconds(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined) return LOCK_WAIT_BUDGET_MS;
  return Math.min(
    LOCK_WAIT_BUDGET_MS,
    requireTimeoutSeconds(timeoutSeconds, LOCK_WAIT_BUDGET_MS) * MILLISECONDS_PER_SECOND,
  );
}

/**
 * Threads one clock through both the verb and the credential store, so a test's
 * injected time governs stored timestamps as well as local arithmetic.
 *
 * @param store - Caller-supplied store seams, if any.
 * @param now - Clock to install when the caller named none.
 * @returns Store dependencies carrying a definite clock.
 */
export function withClock(
  store: PlexAuthStoreDependencies | undefined,
  now: () => number,
): PlexAuthStoreDependencies {
  return { ...store, now: store?.now ?? now };
}

/**
 * @param now - Epoch-millisecond clock.
 * @returns The same instant in whole epoch seconds.
 */
export function epochSeconds(now: () => number): number {
  return Math.floor(now() / MILLISECONDS_PER_SECOND);
}

/**
 * Signs one compact-JWS device assertion.
 *
 * @param kid - RFC 7638 thumbprint of the signing key; a header value, not a claim.
 * @param privateKeyPkcs8Pem - PEM key read from the store's off-object secrets.
 * @param payload - Claim set built by the wire module, never hand-assembled.
 * @returns The compact JWS serialization.
 * @throws TypeError when the key or the claim set is unusable.
 */
export function signAssertion(
  kid: string,
  privateKeyPkcs8Pem: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return signCompactJws({
    protectedHeader: { kid, alg: "EdDSA", typ: "JWT" },
    payload,
    privateKeyPkcs8Pem,
  });
}

/**
 * Refuses to use an account credential against a server the user never enrolled.
 *
 * @param handle - Store handle re-read under the lock.
 * @param origin - Canonical origin of the pending operation.
 * @throws {PlexAuthError} `PLEX_AUTH_ORIGIN_NOT_AUTHORIZED` for an unlisted origin.
 */
export function requireAuthorizedOrigin(handle: PlexAuthStoreHandle, origin: string): void {
  if (!handle.authorizedOrigins.some((entry) => entry.origin === origin)) {
    throw new PlexAuthError("PLEX_AUTH_ORIGIN_NOT_AUTHORIZED", { path: handle.path });
  }
}
