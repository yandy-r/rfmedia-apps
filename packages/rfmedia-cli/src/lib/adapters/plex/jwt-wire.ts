/**
 * PLEX ACCOUNT WIRE ADAPTER — CONTAINS UNVERIFIED PROTOCOL DETAIL.
 *
 * Probe date: 2026-07-28, against clients.plex.tv.
 *
 * VERIFIED: pins create/read, nonce endpoint + shape, X-Plex-Token transport,
 *   both error envelopes, 429 headers (limit 10 / period 300, IP-scoped).
 * UNVERIFIED:
 *   U1 success body of POST /api/v2/auth/token — doc says `auth_token`, the
 *      sibling pins endpoint says `authToken`. NEVER OBSERVED. Read tolerantly.
 *   U2 whether ANY lifetime field is returned. NEVER OBSERVED. See
 *      PLEX_JWT_ASSUMED_LIFETIME_SECONDS.
 *   U3 whether the pin-exchange deviceJWT requires a `nonce` claim. The doc
 *      lists a nonce only for the REFRESH assertion. We omit it (design s.13 D6).
 *   U4 HTTP 498 — documented, never emitted by any reachable path.
 *   U5 duplicate-thumbprint / key-rotation behaviour — unknown.
 *   U6 whether a plex.tv JWT is accepted by a PMS — answered per install by a
 *      runtime probe in `enrollment.ts`, never assumed here.
 *
 * A protocol correction is a diff to THIS FILE plus one fixture in
 * `jwt-wire.test.ts`. No HTTP, clock, or filesystem code lives here: every
 * export is a pure function of its arguments.
 */

import type { PlexEd25519PublicJwk } from "./jwt.js";

/** Date on which every VERIFIED item in this module's header was live-probed. */
export const PLEX_WIRE_PROBE_DATE = "2026-07-28" as const;

/** Verified account origin. A module constant — never caller-supplied. */
export const PLEX_ACCOUNT_ORIGIN = "https://clients.plex.tv";

/** Verified: `POST` creates an authorization pin, `GET /<id>` reads its claim. */
export const PLEX_PINS_PATH = "/api/v2/pins";

/** Verified: `GET` issues a single-use refresh nonce. */
export const PLEX_NONCE_PATH = "/api/v2/auth/nonce";

/** Documented token exchange. Its success body has NEVER been observed (U1). */
export const PLEX_TOKEN_PATH = "/api/v2/auth/token";

/** Documented but deliberately unused — it destroys the caller's legacy token. */
export const PLEX_JWK_PATH = "/api/v2/auth/jwk";

/**
 * Deliberately shorter than the documented 7-day maximum. U2 records that no
 * lifetime field was ever observed, so 7 days is an assumption with zero margin.
 * Over-refreshing costs one bounded request; under-refreshing costs a failed
 * mutation.
 */
export const PLEX_JWT_ASSUMED_LIFETIME_SECONDS = 6 * 24 * 60 * 60;

/** Documented nonce validity window. Verified as a 5-minute rate-limit period. */
export const PLEX_NONCE_MAX_AGE_SECONDS = 300;

/** Interactive approval surface printed to stderr during enrollment. */
const PLEX_AUTHORIZATION_APP_URL = "https://app.plex.tv/auth";

const PIN_CODE_MAX_LENGTH = 64;
const NONCE_MAX_LENGTH = 128;
const CREDENTIAL_MAX_LENGTH = 4096;
const IDENTIFIER_MAX_LENGTH = 128;
const AUDIENCE_MAX_LENGTH = 256;
const DEVICE_NAME_MAX_LENGTH = 64;
const AUTHORIZATION_URL_MAX_LENGTH = 512;
const ASSERTION_LIFETIME_MAX_SECONDS = 3600;
const DECLARED_LIFETIME_MAX_SECONDS = 30 * 24 * 60 * 60;

const OBSERVED_KEY_MAX_LENGTH = 32;
const OBSERVED_KEY_LIMIT = 12;
const OBSERVED_KEY_CHARSET_PATTERN = /^[A-Za-z0-9_.-]+$/;
const OBSERVED_KEY_SECRET_RUN_PATTERN = /[A-Za-z0-9_-]{16,}/;

/** Printable ASCII excluding space and every other whitespace character. */
const PRINTABLE_ASCII_PATTERN = /^[!-~]+$/;

/** One issued account credential and the lifetime the expiry clock uses. */
export interface PlexTokenGrant {
  readonly token: string;
  readonly lifetimeSeconds: number;
  /** True when `lifetimeSeconds` was assumed rather than server-declared (U2). */
  readonly lifetimeAssumed: boolean;
}

/** One freshly created authorization pin awaiting a browser approval. */
export interface PlexPinRecord {
  readonly pinId: number;
  /** Server-formatted. Validated only as bounded, whitespace-free printable ASCII. */
  readonly code: string;
  readonly expiresInSeconds: number;
}

/** Claim state of a polled authorization pin. `pending` is a success, not an error. */
export type PlexPinClaim =
  | { readonly kind: "pending" }
  | { readonly kind: "claimed"; readonly token: string };

/** Normalized form of BOTH observed plex.tv error envelopes. */
export interface PlexWireFailure {
  readonly httpStatus: number;
  /** Numeric `code` when present and a safe integer. The `message` is NEVER read. */
  readonly code?: number;
}

/**
 * Everything needed to build one signed device assertion.
 *
 * `kid` is carried here so a caller builds a single input object for both the
 * JWS protected header and the claim set; it is deliberately NOT a claim.
 * `nonce` is required by {@link PlexAccountWire.buildRefreshClaims} and omitted
 * by {@link PlexAccountWire.buildPinExchangeClaims} (U3 / design s.13 D6).
 */
export interface PlexAssertionInput {
  readonly clientIdentifier: string;
  readonly kid: string;
  readonly audience: string;
  readonly issuedAtEpochSeconds: number;
  readonly lifetimeSeconds: number;
  readonly jti: string;
  readonly nonce?: string;
}

/** The pure request/response mapping for the plex.tv account protocol. */
export interface PlexAccountWire {
  readonly probeDate: typeof PLEX_WIRE_PROBE_DATE;
  createPinBody(input: {
    readonly publicJwk: PlexEd25519PublicJwk;
    readonly strong: true;
  }): Readonly<Record<string, unknown>>;
  readPinRecord(body: unknown): PlexPinRecord;
  buildAuthorizationUrl(input: {
    readonly clientIdentifier: string;
    readonly code: string;
    readonly deviceName: string;
  }): string;
  readPinClaim(body: unknown): PlexPinClaim;
  readNonce(body: unknown): string;
  buildPinExchangeClaims(input: PlexAssertionInput): Readonly<Record<string, unknown>>;
  buildRefreshClaims(
    input: PlexAssertionInput & { readonly nonce: string },
  ): Readonly<Record<string, unknown>>;
  createTokenBody(deviceJwt: string): Readonly<Record<string, unknown>>;
  readTokenGrant(body: unknown): PlexTokenGrant;
  normalizeFailure(httpStatus: number, body: unknown): PlexWireFailure;
}

/** Discriminator for a 2xx body that does not match this build's wire mapping. */
export type PlexJwtWireErrorCode =
  | "unrecognized-pin-record"
  | "unrecognized-pin-claim"
  | "unrecognized-nonce"
  | "unrecognized-token-grant";

/**
 * Frozen local messages. Server-supplied `message` text is never read, so
 * terminal or bidi injection from plex.tv is impossible by construction.
 */
const PLEX_JWT_WIRE_MESSAGES: Readonly<Record<PlexJwtWireErrorCode, string>> = Object.freeze({
  "unrecognized-pin-record":
    "Plex returned an unrecognized authorization-pin response; this build's wire mapping may be out of date.",
  "unrecognized-pin-claim":
    "Plex returned an unrecognized authorization-pin claim; this build's wire mapping may be out of date.",
  "unrecognized-nonce":
    "Plex returned an unrecognized refresh-nonce response; this build's wire mapping may be out of date.",
  "unrecognized-token-grant":
    "Plex returned an unrecognized token response; this build's wire mapping may be out of date.",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAcceptableObservedKey(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    candidate.length <= OBSERVED_KEY_MAX_LENGTH &&
    OBSERVED_KEY_CHARSET_PATTERN.test(candidate) &&
    !OBSERVED_KEY_SECRET_RUN_PATTERN.test(candidate)
  );
}

/**
 * Collects response key NAMES for diagnostics, never values.
 *
 * Reject-never-strip: a key is dropped when it exceeds 32 characters, contains a
 * character outside `[A-Za-z0-9_.-]`, or holds a 16-or-longer base64url run that
 * could itself be a secret. Recursion goes exactly one level into a plain-object
 * value, prefixed `parent.child`; arrays are not descended into. The result is
 * capped at 12 entries and `truncated` is set when anything was dropped for any
 * reason.
 */
function collectObservedKeys(body: unknown): {
  readonly keys: readonly string[];
  readonly truncated: boolean;
} {
  if (!isRecord(body)) {
    return { keys: Object.freeze([]), truncated: false };
  }

  const accepted: string[] = [];
  let truncated = false;

  const consider = (candidate: string): void => {
    if (!isAcceptableObservedKey(candidate)) {
      truncated = true;
      return;
    }
    if (accepted.length >= OBSERVED_KEY_LIMIT) {
      truncated = true;
      return;
    }
    accepted.push(candidate);
  };

  for (const key of Object.keys(body)) {
    consider(key);

    const child = body[key];
    if (!isRecord(child)) {
      continue;
    }
    for (const childKey of Object.keys(child)) {
      consider(`${key}.${childKey}`);
    }
  }

  return { keys: Object.freeze(accepted), truncated };
}

/**
 * Thrown when a 2xx response does not match this build's wire mapping.
 *
 * `observedKeys` carries response key NAMES only — never values, and never any
 * server-supplied text. It never enters `message`; it is surfaced only in the
 * `--output json` `diagnostics` field and under `--debug`.
 */
export class PlexJwtWireError extends Error {
  override readonly name = "PlexJwtWireError";
  readonly code: PlexJwtWireErrorCode;
  readonly observedKeys: readonly string[];
  readonly observedKeysTruncated: boolean;

  /**
   * Creates a wire-mapping failure whose diagnostics are bounded by construction.
   *
   * @param code - Which tolerant reader rejected the body.
   * @param body - The rejected body. Only its key names are retained.
   */
  constructor(code: PlexJwtWireErrorCode, body: unknown) {
    super(PLEX_JWT_WIRE_MESSAGES[code]);
    const observed = collectObservedKeys(body);
    this.code = code;
    this.observedKeys = observed.keys;
    this.observedKeysTruncated = observed.truncated;
    Object.freeze(this);
  }
}

function readBoundedPrintable(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return PRINTABLE_ASCII_PATTERN.test(value) ? value : undefined;
}

function readPositiveInteger(value: unknown, maxValue: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maxValue) {
    return undefined;
  }
  return value;
}

function assertBoundedPrintable(value: unknown, maxLength: number, subject: string): string {
  const text = readBoundedPrintable(value, maxLength);
  if (text === undefined) {
    throw new TypeError(`${subject} must be 1-${maxLength} printable ASCII characters, no spaces`);
  }
  return text;
}

function assertPositiveInteger(value: unknown, maxValue: number, subject: string): number {
  const parsed = readPositiveInteger(value, maxValue);
  if (parsed === undefined) {
    throw new TypeError(`${subject} must be a safe integer between 1 and ${maxValue}`);
  }
  return parsed;
}

/**
 * Builds the verified pin-creation body.
 *
 * @param input - The freshly generated public JWK; `strong` widens the code space.
 * @returns The frozen request body `{ jwk, strong }`.
 * @throws TypeError when the JWK is not an Ed25519 OKP key.
 */
export function createPinBody(input: {
  readonly publicJwk: PlexEd25519PublicJwk;
  readonly strong: true;
}): Readonly<Record<string, unknown>> {
  const { publicJwk } = input;
  if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519") {
    throw new TypeError("Plex pin creation requires an Ed25519 OKP public JWK");
  }
  assertBoundedPrintable(publicJwk.x, CREDENTIAL_MAX_LENGTH, "Public JWK `x`");
  return Object.freeze({ jwk: publicJwk, strong: input.strong });
}

/**
 * Reads the verified `201` pin-creation body.
 *
 * The pin code is validated only as bounded, whitespace-free printable ASCII
 * (design s.13 D14 (b)): its charset was observed in exactly one probe run and is
 * documented nowhere, so a strict regex would turn a benign Plex change into a
 * hard enrollment failure.
 *
 * @param body - Parsed response body.
 * @returns The pin identifier, its display code, and its lifetime.
 * @throws PlexJwtWireError when the body does not match this build's mapping.
 */
export function readPinRecord(body: unknown): PlexPinRecord {
  if (!isRecord(body)) {
    throw new PlexJwtWireError("unrecognized-pin-record", body);
  }

  const pinId = readPositiveInteger(body["id"], Number.MAX_SAFE_INTEGER);
  const code = readBoundedPrintable(body["code"], PIN_CODE_MAX_LENGTH);
  const expiresInSeconds = readPositiveInteger(body["expiresIn"], DECLARED_LIFETIME_MAX_SECONDS);

  if (pinId === undefined || code === undefined || expiresInSeconds === undefined) {
    throw new PlexJwtWireError("unrecognized-pin-record", body);
  }

  return Object.freeze({ pinId, code, expiresInSeconds });
}

/**
 * Builds the browser approval link printed to stderr during enrollment.
 *
 * Only `clientID` and `code` are load-bearing; the device context merely labels
 * the approval screen. The result is bounded so the caller can print it without
 * risking an unbounded terminal write.
 *
 * @param input - Stable client identity, the pin code, and the device label.
 * @returns An absolute `https://app.plex.tv/auth#?…` URL of at most 512 characters.
 * @throws TypeError when any input is out of bounds or the URL exceeds the cap.
 */
export function buildAuthorizationUrl(input: {
  readonly clientIdentifier: string;
  readonly code: string;
  readonly deviceName: string;
}): string {
  const clientIdentifier = assertBoundedPrintable(
    input.clientIdentifier,
    IDENTIFIER_MAX_LENGTH,
    "Plex client identifier",
  );
  const code = assertBoundedPrintable(input.code, PIN_CODE_MAX_LENGTH, "Plex authorization code");
  if (input.deviceName.length === 0 || input.deviceName.length > DEVICE_NAME_MAX_LENGTH) {
    throw new TypeError(`Plex device name must be 1-${DEVICE_NAME_MAX_LENGTH} characters`);
  }

  const parameters = new URLSearchParams({
    clientID: clientIdentifier,
    code,
    "context[device][deviceName]": input.deviceName,
  });
  const url = `${PLEX_AUTHORIZATION_APP_URL}#?${parameters.toString()}`;

  if (url.length > AUTHORIZATION_URL_MAX_LENGTH) {
    throw new TypeError(
      `Plex authorization URL must not exceed ${AUTHORIZATION_URL_MAX_LENGTH} characters`,
    );
  }
  return url;
}

/**
 * Reads a polled pin body.
 *
 * `authToken === null` is VERIFIED to mean "not yet claimed" and is returned as
 * `pending`, never as an error. An ABSENT `authToken` is rejected rather than
 * treated as pending: silently polling to timeout would hide a renamed field,
 * whereas a rejection names the observed keys in one bug report.
 *
 * @param body - Parsed response body.
 * @returns `pending` while unclaimed, or the issued account credential.
 * @throws PlexJwtWireError when the body does not match this build's mapping.
 */
export function readPinClaim(body: unknown): PlexPinClaim {
  if (!isRecord(body) || !("authToken" in body)) {
    throw new PlexJwtWireError("unrecognized-pin-claim", body);
  }

  const raw = body["authToken"];
  if (raw === null) {
    return Object.freeze({ kind: "pending" as const });
  }

  const token = readBoundedPrintable(raw, CREDENTIAL_MAX_LENGTH);
  if (token === undefined) {
    throw new PlexJwtWireError("unrecognized-pin-claim", body);
  }
  return Object.freeze({ kind: "claimed" as const, token });
}

/**
 * Reads the verified nonce body.
 *
 * Success is never inferred from status: a `200 {}` nonce response was actually
 * observed, so an empty body is rejected here rather than signing with `undefined`.
 *
 * @param body - Parsed response body.
 * @returns The single-use nonce.
 * @throws PlexJwtWireError when no usable nonce is present.
 */
export function readNonce(body: unknown): string {
  const nonce = isRecord(body) ? readBoundedPrintable(body["nonce"], NONCE_MAX_LENGTH) : undefined;
  if (nonce === undefined) {
    throw new PlexJwtWireError("unrecognized-nonce", body);
  }
  return nonce;
}

function buildBaseClaims(input: PlexAssertionInput): Record<string, unknown> {
  const clientIdentifier = assertBoundedPrintable(
    input.clientIdentifier,
    IDENTIFIER_MAX_LENGTH,
    "Plex client identifier",
  );
  const audience = assertBoundedPrintable(
    input.audience,
    AUDIENCE_MAX_LENGTH,
    "Assertion audience",
  );
  const jti = assertBoundedPrintable(input.jti, IDENTIFIER_MAX_LENGTH, "Assertion `jti`");
  const issuedAt = assertPositiveInteger(
    input.issuedAtEpochSeconds,
    Number.MAX_SAFE_INTEGER,
    "Assertion `iat`",
  );
  const lifetimeSeconds = assertPositiveInteger(
    input.lifetimeSeconds,
    ASSERTION_LIFETIME_MAX_SECONDS,
    "Assertion lifetime",
  );

  return {
    iss: clientIdentifier,
    sub: clientIdentifier,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    jti,
  };
}

/**
 * Builds the claim set for the PIN-exchange device assertion.
 *
 * The `nonce` claim is deliberately OMITTED (U3 / design s.13 D6): the doc lists
 * a nonce only for the refresh assertion, a nonce lives 300 s while a strong pin
 * lives 1800 s, and each nonce spends one of ten per 300 s.
 *
 * @param input - Assertion identity, audience, and timing.
 * @returns The frozen claim set.
 * @throws TypeError when any assertion input is out of bounds.
 */
export function buildPinExchangeClaims(
  input: PlexAssertionInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze(buildBaseClaims(input));
}

/**
 * Builds the claim set for the refresh device assertion.
 *
 * @param input - Assertion identity, audience, timing, and the single-use nonce.
 * @returns The frozen claim set including `nonce`.
 * @throws TypeError when the nonce is missing or any assertion input is out of bounds.
 */
export function buildRefreshClaims(
  input: PlexAssertionInput & { readonly nonce: string },
): Readonly<Record<string, unknown>> {
  const nonce = assertBoundedPrintable(input.nonce, NONCE_MAX_LENGTH, "Refresh assertion nonce");
  return Object.freeze({ ...buildBaseClaims(input), nonce });
}

/**
 * Builds the token-exchange request body.
 *
 * The field name mirrors the VERIFIED `deviceJWT` query parameter of
 * `GET /api/v2/pins/<id>`; the token endpoint itself has never been exercised, so
 * this spelling falls inside U1's unobserved region.
 *
 * @param deviceJwt - The compact JWS device assertion.
 * @returns The frozen request body.
 * @throws TypeError when the assertion is empty or out of bounds.
 */
export function createTokenBody(deviceJwt: string): Readonly<Record<string, unknown>> {
  const assertion = assertBoundedPrintable(deviceJwt, CREDENTIAL_MAX_LENGTH, "Device assertion");
  return Object.freeze({ deviceJWT: assertion });
}

/**
 * Reads the token-exchange success body tolerantly (U1 / U2).
 *
 * BOTH `auth_token` (documented) and `authToken` (sibling-endpoint spelling) are
 * accepted because the body has never been observed and one of the two is a typo.
 * When NO lifetime field is present the conservative
 * {@link PLEX_JWT_ASSUMED_LIFETIME_SECONDS} is applied with `lifetimeAssumed: true`
 * so the assumption is surfaced in `plex auth status` rather than laundered. A
 * lifetime field that IS present but unusable is rejected rather than assumed
 * away — a wrong expiry silently breaks the refresh clock.
 *
 * @param body - Parsed response body.
 * @returns The issued credential and the lifetime the expiry clock will use.
 * @throws PlexJwtWireError when no usable credential is present.
 */
export function readTokenGrant(body: unknown): PlexTokenGrant {
  if (!isRecord(body)) {
    throw new PlexJwtWireError("unrecognized-token-grant", body);
  }

  const token =
    readBoundedPrintable(body["auth_token"], CREDENTIAL_MAX_LENGTH) ??
    readBoundedPrintable(body["authToken"], CREDENTIAL_MAX_LENGTH);
  if (token === undefined) {
    throw new PlexJwtWireError("unrecognized-token-grant", body);
  }

  const declaredKey =
    "expires_in" in body ? "expires_in" : "expiresIn" in body ? "expiresIn" : undefined;
  if (declaredKey === undefined) {
    return Object.freeze({
      token,
      lifetimeSeconds: PLEX_JWT_ASSUMED_LIFETIME_SECONDS,
      lifetimeAssumed: true,
    });
  }

  const lifetimeSeconds = readPositiveInteger(body[declaredKey], DECLARED_LIFETIME_MAX_SECONDS);
  if (lifetimeSeconds === undefined) {
    throw new PlexJwtWireError("unrecognized-token-grant", body);
  }
  return Object.freeze({ token, lifetimeSeconds, lifetimeAssumed: false });
}

/**
 * Normalizes BOTH observed plex.tv error envelopes.
 *
 * `{"errors":[{code,message,status}]}` and `{"error":"…"}` both reduce to a
 * status plus an optional numeric `code`. Only the numeric `code`, validated as a
 * safe integer, is read: the server `message` is never read, never stored, and
 * never rendered, so this reader cannot throw on a body of the other shape.
 *
 * @param httpStatus - The observed HTTP status.
 * @param body - Parsed response body of either envelope, or anything else.
 * @returns The normalized, secret-free failure discriminator.
 * @throws TypeError when `httpStatus` is not a safe integer (a local caller bug).
 */
export function normalizeFailure(httpStatus: number, body: unknown): PlexWireFailure {
  if (!Number.isSafeInteger(httpStatus)) {
    throw new TypeError("Plex wire failure requires a safe-integer HTTP status");
  }

  let code: number | undefined;
  if (isRecord(body)) {
    const errors = body["errors"];
    const first = Array.isArray(errors) ? errors[0] : undefined;
    if (isRecord(first)) {
      const candidate = first["code"];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
        code = candidate;
      }
    }
  }

  return Object.freeze(code === undefined ? { httpStatus } : { httpStatus, code });
}

/**
 * The frozen wire mapping injected into the enrollment transport.
 *
 * Injecting this object — rather than importing the functions directly — lets a
 * test drive the transport against a corrected mapping without touching the
 * architecture-gated request owner.
 */
export const PLEX_ACCOUNT_WIRE: PlexAccountWire = Object.freeze({
  probeDate: PLEX_WIRE_PROBE_DATE,
  createPinBody,
  readPinRecord,
  buildAuthorizationUrl,
  readPinClaim,
  readNonce,
  buildPinExchangeClaims,
  buildRefreshClaims,
  createTokenBody,
  readTokenGrant,
  normalizeFailure,
});
