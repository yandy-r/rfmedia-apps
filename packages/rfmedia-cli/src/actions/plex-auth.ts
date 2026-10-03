/**
 * Framework-agnostic action layer for `rfmedia plex auth …` (issue #251).
 *
 * OUTPUT BOUNDARY. Every verb here returns a typed `{ command, result }`
 * envelope or throws. Nothing in this module writes to stdout and nothing sets
 * `process.exitCode`: the command layer renders the success envelope through
 * `formatOutput`, catches, calls `buildPlexAuthFailureEnvelope`, prints that,
 * and sets the exit code. Only the stderr progress countdown is written here,
 * and only when a human is watching a real terminal.
 *
 * VALIDATION LIVES HERE, NEVER IN A COMMANDER `argParser`. An
 * `InvalidArgumentError` thrown from a parser is routed through
 * `Command.error()` → `process.exit(1)` *before* `.action()` runs, which
 * bypasses the failure envelope, the redaction pass, and every test. So
 * `--timeout 0`, `--timeout abc`, and `--plex-url ""` (an unset CI variable)
 * all arrive here as raw values and fail through these functions.
 *
 * ORIGIN AUTHORITY. Enrollment deliberately goes AROUND
 * `buildPlexAdapterConfiguration`: that resolver's cross-origin guard exists to
 * stop an untrusted MCP caller redirecting an ALREADY-HELD credential, whereas
 * these verbs mint or destroy a credential for the origin the user just named.
 * Both sides still agree on what "the same origin" is, because both terminate
 * at the single `normalizePlexOrigin` authority in `../lib/plex-origin.js`.
 *
 * ARCHITECTURE GATE. Plex symbols are imported ONLY from
 * `../lib/adapters/plex-adapter.js`, the sole `PRIVATE_PLEX_COMPOSER`. A direct
 * `../lib/adapters/plex/*` import raises `private-plex-import`, and a
 * `../types/plex.js` import raises `plex-compatibility-import` — this file is
 * not on the compatibility allowlist and must not be added to it. Both fail
 * `check:architecture`, which gates `typecheck` and `build`.
 *
 * SECRET HYGIENE. No envelope built here can carry the credential, the signing
 * key, the authorization code, a nonce, or a device assertion: the use-cases
 * never return them. `kid` and `clientIdentifier` are public by design.
 */

import { isMachineFormat } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import {
  PlexAuthError,
  enrollPlexClient,
  forgetPlexEnrollment,
  plexAuthStoreExistsSync,
  readPlexAuthStatus,
  refreshPlexCredential,
} from "../lib/adapters/plex-adapter.js";
import type {
  PlexAuthStatusResult,
  PlexAuthStoreDependencies,
  PlexEnrollmentDependencies,
  PlexEnrollmentResult,
  PlexForgetResult,
  PlexRefreshResult,
} from "../lib/adapters/plex-adapter.js";
import { MissingRequiredArgumentError } from "../lib/errors.js";
import { getLoadedPlexConfig } from "../lib/loaded-config.js";
import { normalizePlexOrigin } from "../lib/plex-origin.js";
import { confirm, isInteractive } from "../lib/prompt.js";

export { buildPlexAuthFailureEnvelope } from "./plex-auth-envelope.js";
export type {
  PlexAuthFailureDiagnostics,
  PlexAuthFailureEnvelope,
  PlexAuthVerb,
} from "./plex-auth-envelope.js";

/** Browser-authorization budget applied when `--timeout` names none. */
const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;

/** Lower bound for `--timeout`; `--timeout 0` is a hang, not a request. */
const MIN_TIMEOUT_SECONDS = 1;

/** Upper bound for `--timeout`, an hour. Beyond this the pin has long expired. */
const MAX_TIMEOUT_SECONDS = 3600;

/** `--timeout` accepts whole seconds only — no `1e3`, no `0x10`, no sign. */
const WHOLE_SECONDS_PATTERN = /^\d+$/u;

/** Matches the device-label bound enforced by the enrollment use-case. */
const DEVICE_NAME_MAX_LENGTH = 64;

/** Printable ASCII, space included. A label is rejected, never silently stripped. */
const PRINTABLE_LABEL_PATTERN = /^[ -~]+$/u;

/** Milliseconds between two `login` progress lines. */
const POLL_COUNTDOWN_INTERVAL_MS = 15_000;

const MILLISECONDS_PER_SECOND = 1000;

/** Options shared by all four verbs. */
export interface PlexAuthCommonActionOptions {
  /** Raw `--plex-url`; falls back to `plex.url`. Validated here, never elsewhere. */
  readonly plexUrl?: string;
  /** Resolved global output format; decides whether approval may be prompted for. */
  readonly format?: OutputFormat;
  readonly signal?: AbortSignal;
}

/** Arguments for `rfmedia plex auth login`. */
export interface PlexAuthLoginActionOptions extends PlexAuthCommonActionOptions {
  /** Raw `--device-name`; falls back to `plex.auth.deviceName`, then the host name. */
  readonly deviceName?: string;
  /** Raw `--timeout`, still a string when it came from Commander. */
  readonly timeout?: string | number;
  /** Approves replacing an existing enrollment without a prompt. */
  readonly yes?: boolean;
}

/** Arguments for `rfmedia plex auth status`. */
export type PlexAuthStatusActionOptions = PlexAuthCommonActionOptions;

/** Arguments for `rfmedia plex auth refresh`. */
export interface PlexAuthRefreshActionOptions extends PlexAuthCommonActionOptions {
  /** Raw `--timeout`, still a string when it came from Commander. */
  readonly timeout?: string | number;
  /** Rotate even when the credential is fresh. Cannot bypass a Plex rate limit. */
  readonly force?: boolean;
}

/** Arguments for `rfmedia plex auth logout`. */
export interface PlexAuthLogoutActionOptions extends PlexAuthCommonActionOptions {
  /** Approves destroying the local credential without a prompt. */
  readonly yes?: boolean;
}

/** Success envelope for `rfmedia plex auth login`. */
export interface PlexAuthLoginEnvelope {
  readonly command: "plex-auth-login";
  readonly result: PlexEnrollmentResult;
}

/** Success envelope for `rfmedia plex auth status`. */
export interface PlexAuthStatusEnvelope {
  readonly command: "plex-auth-status";
  readonly result: PlexAuthStatusResult;
}

/** Success envelope for `rfmedia plex auth refresh`. */
export interface PlexAuthRefreshEnvelope {
  readonly command: "plex-auth-refresh";
  readonly result: PlexRefreshResult;
}

/** Success envelope for `rfmedia plex auth logout`. */
export interface PlexAuthLogoutEnvelope {
  readonly command: "plex-auth-logout";
  readonly result: PlexForgetResult;
}

/**
 * Resolves the Plex origin a verb operates on.
 *
 * An explicitly empty `--plex-url` is a failure rather than a fallback to
 * config: it is what an unset CI variable expands to, and silently acting
 * against a different server is worse than an error.
 *
 * @param override - Raw `--plex-url`, if the caller passed one.
 * @returns The canonical origin, e.g. `http://localhost:32400`.
 * @throws {MissingRequiredArgumentError} When neither the flag nor `plex.url`
 *   supplies a non-empty value.
 * @throws {TypeError} When the value is not a bare `http(s)` origin.
 */
function requireOrigin(override: string | undefined): string {
  const raw = override ?? getLoadedPlexConfig().url;
  if (raw === undefined || raw.trim().length === 0) {
    throw new MissingRequiredArgumentError(
      "--plex-url <url> (or plex.url in the config file)",
      "A Plex server URL is required",
    );
  }
  const origin = normalizePlexOrigin(raw);
  if (origin === undefined) {
    throw new TypeError(
      "--plex-url must be a bare http(s) origin, for example http://localhost:32400",
    );
  }
  return origin;
}

/**
 * Resolves the origin for verbs that can work without one.
 *
 * @param override - Raw `--plex-url`, if the caller passed one.
 * @returns The canonical origin, or `undefined` when none is configured.
 * @throws {MissingRequiredArgumentError} When a value was supplied but empty.
 * @throws {TypeError} When the value is not a bare `http(s)` origin.
 */
function resolveOptionalOrigin(override: string | undefined): string | undefined {
  const raw = override ?? getLoadedPlexConfig().url;
  if (raw === undefined) return undefined;
  return requireOrigin(raw);
}

/**
 * Validates `--timeout` before it can reach a sleep loop.
 *
 * @param value - Raw flag value; a string when it came from Commander.
 * @returns Whole seconds, or `undefined` when the caller named none.
 * @throws {TypeError} For a non-integer, a zero, a negative, or an out-of-range value.
 */
function parseTimeoutSeconds(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds =
    typeof value === "number"
      ? value
      : WHOLE_SECONDS_PATTERN.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS) {
    throw new TypeError(
      `--timeout must be a whole number of seconds of at least ${MIN_TIMEOUT_SECONDS}`,
    );
  }
  if (seconds > MAX_TIMEOUT_SECONDS) {
    throw new TypeError(`--timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return seconds;
}

/**
 * Validates `--device-name`, which becomes a label in plex.tv Authorized Devices.
 *
 * A label containing anything unprintable is rejected outright rather than
 * stripped, so the name shown in a Plex account is the name that was asked for.
 *
 * @param value - Raw flag value, or the configured default.
 * @returns The trimmed label, or `undefined` to let the host name be used.
 * @throws {TypeError} When the label is empty, over-long, or not printable ASCII.
 */
function requireDeviceName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > DEVICE_NAME_MAX_LENGTH ||
    !PRINTABLE_LABEL_PATTERN.test(trimmed)
  ) {
    throw new TypeError(
      `--device-name must be 1-${DEVICE_NAME_MAX_LENGTH} printable ASCII characters`,
    );
  }
  return trimmed;
}

/**
 * Merges caller-injected store seams over the `plex.auth` configuration.
 *
 * Injected values win field by field, so a test that overrides only `storePath`
 * still gets the configured refresh margin instead of an all-or-nothing swap.
 *
 * @param overrides - Store seams supplied by a test or a composing caller.
 * @returns Store dependencies with the configured path and margin applied.
 */
function resolveStoreDependencies(
  overrides: PlexAuthStoreDependencies | undefined,
): PlexAuthStoreDependencies {
  const auth = getLoadedPlexConfig().auth;
  return {
    ...overrides,
    storePath: overrides?.storePath ?? auth?.storePath,
    refreshMarginSeconds: overrides?.refreshMarginSeconds ?? auth?.refreshMarginSeconds,
  };
}

/**
 * Sleeps for `milliseconds`, settling early only by cancellation.
 *
 * @param milliseconds - How long to wait.
 * @param signal - Caller cancellation, threaded from the verb's budget.
 * @returns A promise settled by the timer or rejected by the abort.
 * @throws {PlexAuthError} `PLEX_AUTH_CANCELLED` when the signal fires.
 */
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((settle, fail) => {
    if (signal?.aborted === true) {
      fail(new PlexAuthError("PLEX_AUTH_CANCELLED"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      settle();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      fail(new PlexAuthError("PLEX_AUTH_CANCELLED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Builds the pin-poll sleep, optionally announcing progress on stderr.
 *
 * `login` polls once a second, so the announcement is throttled to one line per
 * {@link POLL_COUNTDOWN_INTERVAL_MS}. It is suppressed entirely for machine
 * output and for a non-TTY, where a repeating line is noise a parser must skip.
 *
 * @param deadlineEpochMs - End of the caller's own authorization budget; the
 *   pin's own expiry may end the wait sooner.
 * @param announce - Whether a human is watching a real terminal.
 * @returns A cancellable sleep suitable for `PlexEnrollmentDependencies.delay`.
 */
function createEnrollmentDelay(
  deadlineEpochMs: number,
  announce: boolean,
): (milliseconds: number, signal?: AbortSignal) => Promise<void> {
  let nextAnnounceAtEpochMs = Date.now() + POLL_COUNTDOWN_INTERVAL_MS;
  return async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    const nowEpochMs = Date.now();
    if (announce && nowEpochMs >= nextAnnounceAtEpochMs) {
      nextAnnounceAtEpochMs = nowEpochMs + POLL_COUNTDOWN_INTERVAL_MS;
      const remaining = Math.max(
        0,
        Math.ceil((deadlineEpochMs - nowEpochMs) / MILLISECONDS_PER_SECOND),
      );
      console.error(`Waiting for Plex authorization... up to ${remaining}s remaining.`);
    }
    await sleep(milliseconds, signal);
  };
}

/**
 * Gates a destructive verb on explicit approval.
 *
 * Mirrors `assertInteractiveApplyApproval`: when the output is machine-readable
 * or no terminal can answer, there is nobody to ask, so `--yes` is mandatory.
 *
 * @param input - The prompt text, the `--yes` flag, and the output format.
 * @throws {MissingRequiredArgumentError} When approval cannot be obtained.
 * @throws {PlexAuthError} `PLEX_AUTH_CANCELLED` when the operator declines.
 */
async function requireApproval(input: {
  readonly question: string;
  readonly yes: boolean;
  readonly format: OutputFormat | undefined;
}): Promise<void> {
  if (input.yes) return;
  if (isMachineFormat(input.format) || !isInteractive()) {
    throw new MissingRequiredArgumentError(
      `--yes is required for non-interactive or machine-output runs: ${input.question}`,
    );
  }
  if (!(await confirm(input.question))) {
    throw new PlexAuthError("PLEX_AUTH_CANCELLED");
  }
}

/**
 * Enrolls this install with plex.tv and records the credential only after the
 * configured Plex Media Server has accepted it.
 *
 * `login` is not TTY-dependent: the authorization code and link go to stderr
 * and the poll runs headlessly, so it works under `--output json`. Only
 * REPLACING an existing enrollment needs approval, because every `login` mints
 * a fresh key pair and so invalidates the credential the old one backed.
 *
 * @param options - Origin, device label, authorization budget, and approval.
 * @param dependencies - Injectable transport, wire mapping, clock, and store seams.
 * @returns The `plex-auth-login` success envelope; no field is a secret.
 * @throws {MissingRequiredArgumentError} For a missing URL or unobtainable approval.
 * @throws {TypeError} For an invalid URL, timeout, or device name.
 * @throws {PlexAuthError} For every enrollment, probe, and custody failure.
 */
export async function executePlexAuthLogin(
  options: PlexAuthLoginActionOptions,
  dependencies: PlexEnrollmentDependencies = {},
): Promise<PlexAuthLoginEnvelope> {
  const origin = requireOrigin(options.plexUrl);
  const timeoutSeconds = parseTimeoutSeconds(options.timeout) ?? DEFAULT_LOGIN_TIMEOUT_SECONDS;
  const deviceName = requireDeviceName(
    options.deviceName ?? getLoadedPlexConfig().auth?.deviceName,
  );
  const store = resolveStoreDependencies(dependencies.store);

  if (plexAuthStoreExistsSync(store)) {
    await requireApproval({
      question: "Replace the existing Plex enrollment with a new signing key?",
      yes: options.yes === true,
      format: options.format,
    });
  }

  const announce = isInteractive() && !isMachineFormat(options.format);
  const deadlineEpochMs = Date.now() + timeoutSeconds * MILLISECONDS_PER_SECOND;
  const result = await enrollPlexClient(
    { plexUrl: origin, deviceName, timeoutSeconds, signal: options.signal },
    {
      ...dependencies,
      store,
      delay: dependencies.delay ?? createEnrollmentDelay(deadlineEpochMs, announce),
    },
  );

  return { command: "plex-auth-login", result };
}

/**
 * Reports the credential store's state without touching the network.
 *
 * Synchronous on purpose: `status` must stay usable while plex.tv is
 * unreachable or rate limiting this address, so every field — including
 * `clockSkewSeconds` — is the last PERSISTED observation rather than a fresh one.
 *
 * @param options - Optional origin whose authorization should be reported.
 * @param dependencies - Store path override and injectable clock.
 * @returns The `plex-auth-status` success envelope; no field is a secret.
 * @throws {MissingRequiredArgumentError} When `--plex-url` was supplied empty.
 * @throws {TypeError} When `--plex-url` is not a bare `http(s)` origin.
 * @throws {PlexAuthError} For a `PLEX_AUTH_STORE_*` custody failure.
 */
export function executePlexAuthStatus(
  options: PlexAuthStatusActionOptions = {},
  dependencies: PlexAuthStoreDependencies = {},
): PlexAuthStatusEnvelope {
  const origin = resolveOptionalOrigin(options.plexUrl);
  const result = readPlexAuthStatus({ plexUrl: origin }, resolveStoreDependencies(dependencies));
  return { command: "plex-auth-status", result };
}

/**
 * Rotates the stored credential, single-flight across processes.
 *
 * `--force` means "rotate now even though the credential is fresh". It does not
 * and cannot bypass a server-imposed rate limit: an open cooperative window
 * fails with `PLEX_AUTH_RATE_LIMITED` and the remaining wait, before any
 * network call is made.
 *
 * @param options - Origin, lock-wait budget, and the `--force` switch.
 * @param dependencies - Injectable transport, wire mapping, clock, and store seams.
 * @returns The `plex-auth-refresh` success envelope; no field is a secret.
 * @throws {MissingRequiredArgumentError} When no Plex server URL is configured.
 * @throws {TypeError} For an invalid URL or timeout.
 * @throws {PlexAuthError} For every refresh, rate-limit, and custody failure.
 */
export async function executePlexAuthRefresh(
  options: PlexAuthRefreshActionOptions,
  dependencies: PlexEnrollmentDependencies = {},
): Promise<PlexAuthRefreshEnvelope> {
  const origin = requireOrigin(options.plexUrl);
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const result = await refreshPlexCredential(
    { plexUrl: origin, force: options.force === true, timeoutSeconds, signal: options.signal },
    { ...dependencies, store: resolveStoreDependencies(dependencies.store) },
  );

  return { command: "plex-auth-refresh", result };
}

/**
 * Destroys the local root of authority for this install.
 *
 * One signing key backs every authorized origin, so `--plex-url` is validated
 * for consistency with the other verbs but cannot scope the removal: logout
 * always removes the whole document, and `removedOrigins` reports what that
 * covered. No client-callable revocation endpoint exists, so the result names
 * the manual step rather than faking a server call.
 *
 * @param options - Origin, output format, and approval.
 * @param dependencies - Injectable clock and store seams.
 * @returns The `plex-auth-logout` success envelope.
 * @throws {MissingRequiredArgumentError} When approval cannot be obtained.
 * @throws {TypeError} When `--plex-url` is not a bare `http(s)` origin.
 * @throws {PlexAuthError} `PLEX_AUTH_REFRESH_BUSY` at the lock deadline, or a
 *   `PLEX_AUTH_STORE_*` custody failure.
 */
export async function executePlexAuthLogout(
  options: PlexAuthLogoutActionOptions = {},
  dependencies: PlexEnrollmentDependencies = {},
): Promise<PlexAuthLogoutEnvelope> {
  resolveOptionalOrigin(options.plexUrl);
  await requireApproval({
    question: "Destroy the local Plex credential and signing key?",
    yes: options.yes === true,
    format: options.format,
  });

  const result = await forgetPlexEnrollment(
    { signal: options.signal },
    { ...dependencies, store: resolveStoreDependencies(dependencies.store) },
  );

  return { command: "plex-auth-logout", result };
}
