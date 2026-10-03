/**
 * The sole plex.tv account transport (#251).
 *
 * ARCHITECTURE GATE: this module is the second registered owner in `FETCH_OWNERS`
 * (`scripts/check-direct-plex-imports.mjs`), which requires EXACTLY ONE request
 * call site here. That count is textual — the gate's pattern matches comments and
 * string literals as readily as code — so no example, JSDoc snippet, or message
 * anywhere in this file may spell the call out. The one site is in `#attempt`.
 *
 * The module is deliberately thin: it targets the module constant
 * {@link PLEX_ACCOUNT_ORIGIN} rather than any caller-supplied origin; it NEVER
 * receives the Plex Media Server credential, and shares no header set with the
 * PMS transport (design s.13 D5); every request and response SHAPE belongs to
 * `jwt-wire.ts` (D18), so a protocol correction never touches this gated file;
 * and every user-visible failure is a {@link PlexAuthError} whose text comes from
 * a frozen table, so terminal or bidi injection from plex.tv is impossible by
 * construction rather than by sanitization.
 */

import { logDebug } from "../../logger.js";
import { PLEX_RETRY_AFTER_WAIT_CAP_SECONDS, parseRetryAfter } from "../../retry-after.js";
import { PlexAuthError, type PlexAuthErrorCode } from "./errors.js";
import {
  BodyLimitError,
  composeAbortSignals,
  isAborted,
  readBoundedBody,
  sanitizeMessage,
  type AbortComposition,
} from "./http.js";
import type { PlexEd25519PublicJwk } from "./jwt.js";
import {
  PLEX_ACCOUNT_ORIGIN,
  PLEX_ACCOUNT_WIRE,
  PLEX_NONCE_MAX_AGE_SECONDS,
  PLEX_NONCE_PATH,
  PLEX_PINS_PATH,
  PLEX_TOKEN_PATH,
  PlexJwtWireError,
  type PlexAccountWire,
  type PlexPinClaim,
  type PlexPinRecord,
  type PlexTokenGrant,
  type PlexWireFailure,
} from "./jwt-wire.js";

/** `X-Plex-Product` value. Reaches plex.tv only — never a PMS (design s.13 D5). */
const PLEX_ACCOUNT_PRODUCT = "rfmedia-cli";

/** Per-attempt ceiling. Enrollment polling is paced by the caller, not by this. */
const DEFAULT_ACCOUNT_TIMEOUT_MS = 15_000;

/**
 * Hard body ceiling for every account response, success or failure. One limit
 * rather than the PMS client's success/error pair: the largest body this protocol
 * produces is a pin record of a few hundred bytes.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/** One initial attempt plus at most one retry after a bounded `Retry-After` wait. */
const MAX_ATTEMPTS = 2;

const HEADER_TOKEN_MAX_LENGTH = 128;
const DEVICE_NAME_MAX_LENGTH = 64;
const ASSERTION_MAX_LENGTH = 4096;
const MILLISECONDS_PER_SECOND = 1000;

/** Printable ASCII excluding space — a safe HTTP header value by construction. */
const HEADER_TOKEN_PATTERN = /^[!-~]+$/;

/** Printable ASCII including space, so `"Living Room Laptop"` is a usable name. */
const DEVICE_NAME_PATTERN = /^[ -~]+$/;

/**
 * `422` code `1097` provably covers BOTH "Not enough or too many segments" and
 * "JWK not found", so it is disambiguated by the CALL SITE (plan A4.11 / design
 * s.13 D13) and never from server text.
 */
const PLEX_WIRE_CODE_JWK_NOT_FOUND = 1097;

/**
 * Reported when a 429 carries no parseable `Retry-After`. The rate-limit envelope
 * always reports a wait (plan A4.9), and the limiter was live-probed on
 * 2026-07-28 as `x-ratelimit-period: 300` — the same window as
 * {@link PLEX_NONCE_MAX_AGE_SECONDS} — so one full period is the honest default.
 */
const PLEX_RATE_LIMIT_FALLBACK_SECONDS = PLEX_NONCE_MAX_AGE_SECONDS;

type PlexAccountFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Which failure `422` code `1097` denotes for a given endpoint. The pin endpoints
 * are reached only from `enrollPlexClient`, where a rejected key means browser
 * authorization was never completed; the nonce and token endpoints are reached
 * only from a refresh, where it means a registered key is gone.
 */
type PlexKeyRejectionCode = "PLEX_AUTH_NOT_ENROLLED" | "PLEX_AUTH_KEY_REJECTED";

/**
 * What an HTTP `404` denotes for a given endpoint.
 *
 * Only the pin endpoints have a VERIFIED 404 — an unknown pin, code `1020` —
 * which for the user means the authorization code is gone. The nonce and token
 * paths are protocol assumptions (U1/U2): a 404 there means THIS BUILD asked for
 * a path plex.tv does not serve, which re-enrolling cannot fix. Reporting that as
 * an expired enrollment would send `plex auth refresh` into an unbounded
 * re-enrollment loop, minting a new device on every cycle.
 */
type PlexNotFoundCode = "PLEX_AUTH_ENROLLMENT_EXPIRED" | "PLEX_AUTH_INVALID_RESPONSE";

interface PlexAccountRequestInput {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly clientIdentifier: string;
  readonly deviceName?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  /** Credentials live for this request, removed from any diagnostic text. */
  readonly secrets: readonly string[];
  readonly keyRejectionCode: PlexKeyRejectionCode;
  readonly notFoundCode: PlexNotFoundCode;
  readonly signal?: AbortSignal;
}

interface PlexAccountResponse {
  /** Parsed body, `undefined` when empty. Interpreted only by `jwt-wire.ts`. */
  readonly body: unknown;
  /** Response `Date` header in epoch seconds, or the local clock (design s.13 D19). */
  readonly observedAtEpochSeconds: number;
}

type PlexAccountAttemptResult =
  | { readonly kind: "response"; readonly value: PlexAccountResponse }
  | { readonly kind: "retry-after"; readonly waitSeconds: number };

/** A single-use refresh nonce and the moment its issuing response was observed. */
export interface PlexNonceIssue {
  readonly nonce: string;
  /**
   * From the response's TLS-authenticated HTTP `Date` header, falling back to the
   * local clock. Transport metadata, not a JWT claim, so the 300 s staleness
   * check survives a skewed local clock.
   */
  readonly receivedAtEpochSeconds: number;
}

/** Arguments for creating one strong authorization pin. */
export interface PlexCreatePinInput {
  readonly publicJwk: PlexEd25519PublicJwk;
  readonly clientIdentifier: string;
  /** Label shown on the browser approval screen. */
  readonly deviceName: string;
  readonly signal?: AbortSignal;
}

/** Arguments for polling one authorization pin. */
export interface PlexReadPinInput {
  readonly pinId: number;
  /** Compact JWS device assertion built from `buildPinExchangeClaims`. */
  readonly deviceJwt: string;
  readonly clientIdentifier: string;
  readonly signal?: AbortSignal;
}

/** Arguments for issuing one single-use refresh nonce. */
export interface PlexCreateNonceInput {
  readonly clientIdentifier: string;
  readonly signal?: AbortSignal;
}

/** Arguments for exchanging a signed device assertion for a credential. */
export interface PlexExchangeAssertionInput {
  /** Compact JWS device assertion built from `buildRefreshClaims`. */
  readonly deviceJwt: string;
  readonly clientIdentifier: string;
  readonly signal?: AbortSignal;
}

/**
 * The plex.tv account protocol surface.
 *
 * Optional members are DECLARED AND DELIBERATELY UNIMPLEMENTED so each deferral
 * is visible to the compiler — a caller must reach them through `?.` — rather
 * than living only in prose.
 */
export interface PlexAccountProtocol {
  /** Creates an authorization pin bound to a freshly generated public JWK. */
  createPin(input: PlexCreatePinInput): Promise<PlexPinRecord>;

  /** Polls a pin. An unclaimed pin is a `pending` success, never an error. */
  readPin(input: PlexReadPinInput): Promise<PlexPinClaim>;

  /** Issues one nonce against the IP-scoped budget of 10 per 300 s. */
  createNonce(input: PlexCreateNonceInput): Promise<PlexNonceIssue>;

  /** Exchanges a signed device assertion for an account credential. */
  exchangeDeviceAssertion(input: PlexExchangeAssertionInput): Promise<PlexTokenGrant>;

  /**
   * DEFERRED — enrollment Option 2. Plex documents that registering a JWK with a
   * legacy token EXPIRES that token, destroying the rollback credential and
   * making migration one-way. Option 1 (a fresh PIN) is used instead.
   */
  registerJwkWithLegacyToken?(input: {
    readonly clientIdentifier: string;
    readonly legacyToken: string;
    readonly publicJwk: PlexEd25519PublicJwk;
    readonly signal?: AbortSignal;
  }): Promise<void>;

  /**
   * DEFERRED — no client-callable revocation endpoint is documented. `plex auth
   * logout` destroys the local root of authority and reports
   * `serverSideRevocation: "manual"`.
   */
  revokeDevice?(input: {
    readonly clientIdentifier: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;

  /**
   * DEFERRED — needed only if the enrollment probe proves U6 false (a PMS that
   * refuses a plex.tv-issued JWT). `PLEX_AUTH_PMS_REJECTED`'s remediation names
   * this gap.
   */
  exchangeServerAccessToken?(input: {
    readonly accountToken: string;
    readonly machineIdentifier: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

/** Test seams and hard limits for one account transport. */
export interface PlexEnrollmentClientDependencies {
  readonly fetch?: PlexAccountFetch;
  /** Epoch milliseconds, used only as the `Date`-header fallback. */
  readonly now?: () => number;
  /** Cancellable sleep backing the bounded `Retry-After` wait. */
  readonly delay?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
  /** Wire-mapping seam, so a corrected mapping needs no diff to this file. */
  readonly wire?: PlexAccountWire;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

function defaultScheduleTimeout(callback: () => void, milliseconds: number): unknown {
  return setTimeout(callback, milliseconds);
}

function defaultCancelTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (isAborted(signal)) {
      reject(new PlexAuthError("PLEX_AUTH_CANCELLED"));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new PlexAuthError("PLEX_AUTH_CANCELLED"));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validatePositiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertBoundedText(
  value: string,
  maxLength: number,
  pattern: RegExp,
  subject: string,
): string {
  if (value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw new TypeError(`${subject} must be 1-${maxLength} printable ASCII characters`);
  }
  return value;
}

function buildAccountUrl(request: PlexAccountRequestInput): URL {
  const url = new URL(`${PLEX_ACCOUNT_ORIGIN}${request.path}`);
  if (url.origin !== PLEX_ACCOUNT_ORIGIN) {
    throw new TypeError("Plex account request resolved outside the account origin");
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function buildAccountHeaders(request: PlexAccountRequestInput): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Client-Identifier": assertBoundedText(
      request.clientIdentifier,
      HEADER_TOKEN_MAX_LENGTH,
      HEADER_TOKEN_PATTERN,
      "Plex client identifier",
    ),
    "X-Plex-Product": PLEX_ACCOUNT_PRODUCT,
  };
  if (request.deviceName !== undefined) {
    headers["X-Plex-Device-Name"] = assertBoundedText(
      request.deviceName,
      DEVICE_NAME_MAX_LENGTH,
      DEVICE_NAME_PATTERN,
      "Plex device name",
    );
  }
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function decodeJsonBody(body: Uint8Array): unknown {
  if (body.byteLength === 0) {
    return undefined;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}

/**
 * Maps one normalized wire failure onto a frozen-table code, exactly as design
 * s.7 tabulates it. Only the numeric `code` participates — the server `message`
 * is never read — and the two endpoint-scoped statuses, `404` and `422`/`1097`,
 * resolve through the call site's `notFoundCode` and `keyRejectionCode`.
 */
function classifyWireFailure(
  failure: PlexWireFailure,
  request: Pick<PlexAccountRequestInput, "keyRejectionCode" | "notFoundCode">,
): PlexAuthErrorCode {
  const status = failure.httpStatus;

  if (status === 429) {
    return "PLEX_AUTH_RATE_LIMITED";
  }
  if (status === 404) {
    return request.notFoundCode;
  }
  if (status === 401 || status === 403 || status === 498) {
    return "PLEX_AUTH_KEY_REJECTED";
  }
  if (status === 422) {
    return failure.code === PLEX_WIRE_CODE_JWK_NOT_FOUND
      ? request.keyRejectionCode
      : "PLEX_AUTH_INVALID_RESPONSE";
  }
  if (status >= 500) {
    return "PLEX_AUTH_UNREACHABLE";
  }
  return "PLEX_AUTH_INVALID_RESPONSE";
}

/**
 * Bounded transport for the four plex.tv account endpoints.
 *
 * @example
 * ```
 * const account = new PlexEnrollmentClient();
 * const pin = await account.createPin({ publicJwk, clientIdentifier, deviceName });
 * ```
 */
export class PlexEnrollmentClient implements PlexAccountProtocol {
  readonly #fetch: PlexAccountFetch;
  readonly #wire: PlexAccountWire;
  readonly #now: () => number;
  readonly #delay: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly #scheduleTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly #cancelTimeout: (handle: unknown) => void;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  /**
   * @param dependencies - Test seams and hard limits. Every field has a
   *   production default, so `new PlexEnrollmentClient()` is the real client.
   * @throws TypeError When a supplied limit is not a positive safe integer.
   */
  constructor(dependencies: PlexEnrollmentClientDependencies = {}) {
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#wire = dependencies.wire ?? PLEX_ACCOUNT_WIRE;
    this.#now = dependencies.now ?? Date.now;
    this.#delay = dependencies.delay ?? defaultDelay;
    this.#scheduleTimeout = dependencies.scheduleTimeout ?? defaultScheduleTimeout;
    this.#cancelTimeout = dependencies.cancelTimeout ?? defaultCancelTimeout;
    this.#timeoutMs = validatePositiveLimit(
      "timeoutMs",
      dependencies.timeoutMs ?? DEFAULT_ACCOUNT_TIMEOUT_MS,
    );
    this.#maxResponseBytes = validatePositiveLimit(
      "maxResponseBytes",
      dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    Object.freeze(this);
  }

  /**
   * @param input - Public JWK, stable client identity, and approval-screen label.
   * @returns The pin identifier, its display code, and its lifetime.
   * @throws PlexAuthError When plex.tv rejects the request or answers with a body
   *   this build does not recognize.
   * @throws TypeError When the client identifier or device name is out of bounds.
   */
  async createPin(input: PlexCreatePinInput): Promise<PlexPinRecord> {
    const response = await this.#send({
      method: "POST",
      path: PLEX_PINS_PATH,
      clientIdentifier: input.clientIdentifier,
      deviceName: input.deviceName,
      body: this.#wire.createPinBody({ publicJwk: input.publicJwk, strong: true }),
      secrets: [],
      keyRejectionCode: "PLEX_AUTH_NOT_ENROLLED",
      notFoundCode: "PLEX_AUTH_ENROLLMENT_EXPIRED",
      signal: input.signal,
    });
    return this.#readWire(() => this.#wire.readPinRecord(response.body));
  }

  /**
   * @param input - Pin identifier, compact JWS assertion, and client identity.
   * @returns `pending` until the user approves, then the issued credential.
   * @throws PlexAuthError `PLEX_AUTH_ENROLLMENT_EXPIRED` once the pin is gone.
   * @throws TypeError When the pin identifier or the assertion is invalid.
   */
  async readPin(input: PlexReadPinInput): Promise<PlexPinClaim> {
    if (!Number.isSafeInteger(input.pinId) || input.pinId < 1) {
      throw new TypeError("Plex pin identifier must be a positive safe integer");
    }
    const deviceJwt = assertBoundedText(
      input.deviceJwt,
      ASSERTION_MAX_LENGTH,
      HEADER_TOKEN_PATTERN,
      "Plex device assertion",
    );
    const response = await this.#send({
      method: "GET",
      path: `${PLEX_PINS_PATH}/${input.pinId}`,
      clientIdentifier: input.clientIdentifier,
      query: { deviceJWT: deviceJwt },
      secrets: [deviceJwt],
      keyRejectionCode: "PLEX_AUTH_NOT_ENROLLED",
      notFoundCode: "PLEX_AUTH_ENROLLMENT_EXPIRED",
      signal: input.signal,
    });
    return this.#readWire(() => this.#wire.readPinClaim(response.body));
  }

  /**
   * @param input - Stable client identity and an optional cancellation signal.
   * @returns The nonce plus the observation time its staleness check uses.
   * @throws PlexAuthError `PLEX_AUTH_RATE_LIMITED` against the IP-scoped budget.
   * @throws TypeError When the client identifier is out of bounds.
   */
  async createNonce(input: PlexCreateNonceInput): Promise<PlexNonceIssue> {
    const response = await this.#send({
      method: "GET",
      path: PLEX_NONCE_PATH,
      clientIdentifier: input.clientIdentifier,
      secrets: [],
      keyRejectionCode: "PLEX_AUTH_KEY_REJECTED",
      notFoundCode: "PLEX_AUTH_INVALID_RESPONSE",
      signal: input.signal,
    });
    const nonce = this.#readWire(() => this.#wire.readNonce(response.body));
    return Object.freeze({ nonce, receivedAtEpochSeconds: response.observedAtEpochSeconds });
  }

  /**
   * @param input - Compact JWS assertion and the stable client identity.
   * @returns The credential and the lifetime the expiry clock will use.
   * @throws PlexAuthError `PLEX_AUTH_KEY_REJECTED` when the signing key is gone.
   * @throws TypeError When the assertion is empty or out of bounds.
   */
  async exchangeDeviceAssertion(input: PlexExchangeAssertionInput): Promise<PlexTokenGrant> {
    const deviceJwt = assertBoundedText(
      input.deviceJwt,
      ASSERTION_MAX_LENGTH,
      HEADER_TOKEN_PATTERN,
      "Plex device assertion",
    );
    const response = await this.#send({
      method: "POST",
      path: PLEX_TOKEN_PATH,
      clientIdentifier: input.clientIdentifier,
      body: this.#wire.createTokenBody(deviceJwt),
      secrets: [deviceJwt],
      keyRejectionCode: "PLEX_AUTH_KEY_REJECTED",
      notFoundCode: "PLEX_AUTH_INVALID_RESPONSE",
      signal: input.signal,
    });
    return this.#readWire(() => this.#wire.readTokenGrant(response.body));
  }

  /**
   * Runs one request, honouring at most one bounded `Retry-After` wait.
   *
   * A 429 advertising no more than {@link PLEX_RETRY_AFTER_WAIT_CAP_SECONDS} is
   * waited out once and retried here. Anything longer surfaces as
   * `PLEX_AUTH_RATE_LIMITED` with the advertised delay, because the caller — which
   * already holds the credential-store lock — persists it as cooperative
   * cross-process backoff rather than sleeping a CLI for minutes.
   */
  async #send(request: PlexAccountRequestInput): Promise<PlexAccountResponse> {
    const url = buildAccountUrl(request);
    const headers = buildAccountHeaders(request);
    const payload = request.body === undefined ? undefined : JSON.stringify(request.body);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (isAborted(request.signal)) {
        throw new PlexAuthError("PLEX_AUTH_CANCELLED");
      }

      const allowRetry = attempt + 1 < MAX_ATTEMPTS;
      const result = await this.#attempt(request, url, headers, payload, allowRetry);
      if (result.kind === "response") {
        return result.value;
      }
      await this.#delay(result.waitSeconds * MILLISECONDS_PER_SECOND, request.signal);
    }

    throw new Error("Plex account request retry limit was exceeded");
  }

  async #attempt(
    request: PlexAccountRequestInput,
    url: URL,
    headers: Record<string, string>,
    payload: string | undefined,
    allowRetry: boolean,
  ): Promise<PlexAccountAttemptResult> {
    const abort = composeAbortSignals(
      request.signal,
      this.#timeoutMs,
      this.#scheduleTimeout,
      this.#cancelTimeout,
    );

    try {
      const response = await this.#fetch(url, {
        method: request.method,
        headers,
        body: payload,
        redirect: "error",
        signal: abort.signal,
      });

      if (!response.ok) {
        return await this.#handleNonSuccess(response, request, allowRetry);
      }
      return {
        kind: "response",
        value: {
          body: await this.#readSuccessBody(response),
          observedAtEpochSeconds: this.#readObservedAt(response),
        },
      };
    } catch (error: unknown) {
      throw this.#toAccountFailure(error, request, abort);
    } finally {
      abort.cleanup();
    }
  }

  async #handleNonSuccess(
    response: Response,
    request: PlexAccountRequestInput,
    allowRetry: boolean,
  ): Promise<PlexAccountAttemptResult> {
    const failure = this.#wire.normalizeFailure(
      response.status,
      await this.#readFailureBody(response),
    );
    const code = classifyWireFailure(failure, request);
    if (code !== "PLEX_AUTH_RATE_LIMITED") {
      throw new PlexAuthError(code);
    }

    const advertisedSeconds = parseRetryAfter(response.headers.get("retry-after"));
    if (
      allowRetry &&
      advertisedSeconds !== undefined &&
      advertisedSeconds <= PLEX_RETRY_AFTER_WAIT_CAP_SECONDS
    ) {
      return { kind: "retry-after", waitSeconds: advertisedSeconds };
    }
    throw new PlexAuthError("PLEX_AUTH_RATE_LIMITED", {
      retryAfterSeconds: advertisedSeconds ?? PLEX_RATE_LIMIT_FALLBACK_SECONDS,
    });
  }

  async #readSuccessBody(response: Response): Promise<unknown> {
    let body: Uint8Array;
    try {
      body = await readBoundedBody(response, this.#maxResponseBytes);
    } catch (error: unknown) {
      if (error instanceof BodyLimitError) {
        throw new PlexAuthError("PLEX_AUTH_INVALID_RESPONSE");
      }
      throw error;
    }

    try {
      return decodeJsonBody(body);
    } catch {
      throw new PlexAuthError("PLEX_AUTH_INVALID_RESPONSE");
    }
  }

  /**
   * Reads a failure body for its numeric discriminator only. An unreadable or
   * malformed body degrades to `undefined` rather than propagating: the failure
   * code is already fixed by the HTTP status and `normalizeFailure` accepts any
   * shape, so this discards nothing a caller could have acted on.
   */
  async #readFailureBody(response: Response): Promise<unknown> {
    try {
      return decodeJsonBody(await readBoundedBody(response, this.#maxResponseBytes));
    } catch {
      return undefined;
    }
  }

  #readObservedAt(response: Response): number {
    const header = response.headers.get("date");
    const parsed = header === null ? Number.NaN : Date.parse(header);
    const epochMilliseconds = Number.isFinite(parsed) ? parsed : this.#now();
    return Math.floor(epochMilliseconds / MILLISECONDS_PER_SECOND);
  }

  /**
   * Converts a tolerant reader's rejection into a frozen-table failure, carrying
   * the bounded, charset-filtered key NAMES so a maintainer can correct
   * `jwt-wire.ts` from a single bug report.
   */
  #readWire<T>(read: () => T): T {
    try {
      return read();
    } catch (error: unknown) {
      if (error instanceof PlexJwtWireError) {
        throw new PlexAuthError("PLEX_AUTH_INVALID_RESPONSE", {
          observedKeys: error.observedKeys,
        });
      }
      throw error;
    }
  }

  /**
   * Classifies a transport-level throw. The sanitized detail goes to the debug
   * log only — never into the thrown error, whose text comes from the frozen
   * table — and `secrets` carries every credential live for this request, so an
   * echoed assertion cannot leak even under `--debug`.
   */
  #toAccountFailure(
    error: unknown,
    request: PlexAccountRequestInput,
    abort: AbortComposition,
  ): Error {
    if (error instanceof PlexAuthError) {
      return error;
    }
    if (isAborted(request.signal)) {
      return new PlexAuthError("PLEX_AUTH_CANCELLED");
    }

    const detail = sanitizeMessage(error, request.secrets);
    const outcome = abort.didTimeout() ? "timed out" : "failed";
    logDebug(`Plex account ${request.method} ${request.path} ${outcome}: ${detail}`);
    return new PlexAuthError("PLEX_AUTH_UNREACHABLE");
  }
}
