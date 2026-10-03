/**
 * The four Plex credential use-cases behind `rfmedia plex auth …` (issue #251).
 *
 * This module owns `login`, `status` and `logout` and is the single import
 * surface for all four verbs: `refresh` lives in `enrollment-refresh.ts` and is
 * re-exported here, so the `plex-adapter.ts` façade depends on one path.
 *
 * VERIFY BEFORE PERSIST. `enrollPlexClient` mints a fresh Ed25519 key pair and a
 * fresh client identifier, claims an authorization pin, and then PROBES the
 * configured Plex Media Server with the newly issued credential. Only a probe
 * answering `200` with a `machineIdentifier` reaches the disk, in a single locked
 * `{enroll, issue, authorize-origin}` write. This is how U6 — "does a plex.tv
 * JWT work against a PMS?" — is answered empirically per install instead of
 * guessed: a broken assumption surfaces at enrollment with
 * `PLEX_AUTH_PMS_REJECTED` and nothing persisted, never mid-copy.
 *
 * ORIGIN AUTHORITY. Enrollment goes AROUND `buildPlexAdapterConfiguration`: that
 * cross-origin guard stops an untrusted MCP caller redirecting an ALREADY-HELD
 * credential, whereas these verbs mint a FRESH credential for the origin the
 * user just named. Both still agree on what "the same origin" means, because
 * both terminate at the single `normalizePlexOrigin` authority.
 *
 * SECRET HYGIENE. The authorization code and link go to stderr only — never
 * stdout, never a log file, never a JSON envelope. Signing keys are read from
 * the store handle's off-object `WeakMap` and never copied onto a result.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { hostname as nodeHostname } from "node:os";

import { MediaServerError } from "../../../types/media-server.js";
import { removeOrphanedTemporaryFiles } from "../../secure-store/index.js";
import { StaticPlexTokenProvider } from "./auth.js";
import {
  loadPlexAuthStoreSync,
  resolvePlexAuthStorePath,
  withPlexAuthStoreLock,
} from "./credential-store.js";
import type {
  PlexAuthorizedOrigin,
  PlexAuthStoreDependencies,
  PlexCredentialState,
} from "./credential-store.js";
import { PlexEnrollmentClient } from "./enrollment-client.js";
import type { PlexAccountProtocol } from "./enrollment-client.js";
import {
  ASSERTION_LIFETIME_SECONDS,
  defaultProbeTransport,
  delayCancellably,
  epochSeconds,
  lockWaitMilliseconds,
  LOCK_WAIT_BUDGET_MS,
  MILLISECONDS_PER_SECOND,
  PLEX_ASSERTION_AUDIENCE,
  PLEX_AUTHORIZED_DEVICES_URL,
  requirePlexOrigin,
  requireTimeoutSeconds,
  resolveDeviceName,
  signAssertion,
  toPrintable,
  withClock,
  writeStderrLine,
} from "./enrollment-support.js";
import type { PlexEnrollmentDependencies } from "./enrollment-support.js";
import { PlexAuthError } from "./errors.js";
import { generatePlexClientKeyPair } from "./jwt.js";
import { PLEX_ACCOUNT_WIRE, PLEX_JWT_ASSUMED_LIFETIME_SECONDS } from "./jwt-wire.js";
import type { PlexAssertionInput } from "./jwt-wire.js";
import { createPlexConnectionSettings, isPlexWireServerResponse } from "./types.js";

export { PLEX_AUTHORIZED_DEVICES_URL } from "./enrollment-support.js";
export type { PlexEnrollmentDependencies } from "./enrollment-support.js";
export { refreshPlexCredential } from "./enrollment-refresh.js";
export type {
  PlexRefreshOptions,
  PlexRefreshReason,
  PlexRefreshResult,
} from "./enrollment-refresh.js";

/** Default browser-authorization budget when the caller names no `--timeout`. */
const DEFAULT_ENROLLMENT_TIMEOUT_SECONDS = 300;

/** Pin poll cadence. A cancellable sleep, never a busy loop. */
const ENROLLMENT_POLL_INTERVAL_MS = 1000;

const PIN_CODE_PRINT_MAX_LENGTH = 64;
const AUTHORIZATION_URL_PRINT_MAX_LENGTH = 512;

/** Operation label carried by the probe request's failures. */
const PROBE_OPERATION = "verify Plex enrollment";

/** Statuses that mean the PMS refused the credential rather than failed to answer. */
const PMS_REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 403, 422]);

/**
 * Staging discriminator and subject `credential-store.ts` publishes the store
 * document under.
 *
 * Mirrored here because logout must RECOGNIZE a stage that a crash between
 * publication and cleanup left behind: that file is a `0600` copy of the whole
 * document, PKCS#8 signing key included. Both values are part of an on-disk
 * name, so they may only ever be widened, never renamed, on either side.
 */
const PLEX_AUTH_STORE_TEMPORARY_ID = "plex-auth-store";
const PLEX_AUTH_STORE_SUBJECT = "Plex credential store";

/** Arguments for `rfmedia plex auth login`. */
export interface PlexEnrollmentOptions {
  /** Raw `--plex-url ?? plex.url`; normalized here, never elsewhere. */
  readonly plexUrl: string;
  /** Device label shown in plex.tv Authorized Devices. Defaults to the host name. */
  readonly deviceName?: string;
  /** Whole seconds allowed for browser authorization. */
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

/** Outcome of a completed, probed, and persisted enrollment. */
export interface PlexEnrollmentResult {
  readonly origin: string;
  readonly clientIdentifier: string;
  /** RFC 7638 thumbprint of the new signing key. Public, not a secret. */
  readonly kid: string;
  readonly deviceName: string;
  /** `machineIdentifier` observed by the probe; detects a later origin swap. */
  readonly machineIdentifier: string;
  readonly authorizedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  /** Always true today: the pin claim declares no lifetime (U2). */
  readonly lifetimeAssumed: boolean;
  readonly replacedExistingEnrollment: boolean;
}

/** Arguments for `rfmedia plex auth status`. */
export interface PlexAuthStatusOptions {
  /** Optional origin to report authorization for; not required to read status. */
  readonly plexUrl?: string;
}

/** Freshness projection reported by `plex auth status`. */
export interface PlexAuthStatusCredential {
  readonly state: PlexCredentialState["kind"];
  readonly expiresAtEpochSeconds: number;
  readonly secondsRemaining: number;
  /** True when the lifetime was assumed rather than server-declared (U2). */
  readonly lifetimeAssumed: boolean;
}

/** Offline projection of the credential store. Never contains a secret. */
export type PlexAuthStatusResult =
  | {
      readonly enrolled: false;
      readonly credentialSource: "none";
      readonly storePath: string;
      readonly origin: string | null;
    }
  | {
      readonly enrolled: true;
      readonly credentialSource: "stored";
      readonly clientIdentifier: string;
      readonly kid: string;
      readonly deviceName: string;
      readonly storePath: string;
      /** Named verbatim by `PLEX_AUTH_REFRESH_BUSY`'s remediation. */
      readonly lockPath: string;
      /** Octal permission bits, e.g. `"600"`. */
      readonly storeMode: string;
      readonly storeOwnerOnly: boolean;
      readonly credential: PlexAuthStatusCredential;
      readonly refreshNotBeforeEpochSeconds: number;
      /** Last PERSISTED observation; `status` makes no network call. */
      readonly clockSkewSeconds: number | null;
      readonly origin: string | null;
      readonly originAuthorized: boolean | null;
      readonly origins: readonly PlexAuthorizedOrigin[];
    };

/** Arguments for `rfmedia plex auth logout`. */
export interface PlexForgetOptions {
  /** Whole seconds allowed for the lock wait; capped at 60. */
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

/** Outcome of `rfmedia plex auth logout`. */
export interface PlexForgetResult {
  /** Every origin the destroyed credential had been authorized for. */
  readonly removedOrigins: readonly string[];
  /** Refers to LOCAL file removal only. */
  readonly keyDestroyed: boolean;
  /** Always `"manual"`: no client-callable revocation endpoint is documented. */
  readonly serverSideRevocation: "manual";
  readonly authorizedDevicesUrl: string;
  readonly deviceName: string | null;
}

/**
 * Classifies a probe failure without ever reading server text. A refusal
 * (401/403/422, or the adapter's own authentication/authorization codes) is the
 * U6 answer for this install, and `PLEX_AUTH_PMS_REJECTED`'s remediation names
 * the deferred per-server exchange seam; anything else is an unreachable server.
 */
function toProbeFailure(error: unknown, signal: AbortSignal | undefined): unknown {
  if (error instanceof PlexAuthError) return error;
  if (signal?.aborted === true) return new PlexAuthError("PLEX_AUTH_CANCELLED");
  if (
    error instanceof MediaServerError &&
    (PMS_REJECTION_STATUSES.has(error.statusCode ?? 0) ||
      error.code === "authentication" ||
      error.code === "authorization")
  ) {
    return new PlexAuthError("PLEX_AUTH_PMS_REJECTED");
  }
  return new PlexAuthError("PLEX_AUTH_UNREACHABLE");
}

/**
 * Answers U6 for this install: does THIS server accept the credential just
 * minted? Nothing is on disk when this runs, so a rejection costs one re-run
 * rather than a half-recorded enrollment. It is wired to a STATIC credential
 * cell and the static provider; a rotating provider would try to refresh a
 * credential that is not stored yet. Returns the server's `machineIdentifier`,
 * persisted so a later origin swap onto a different server is detectable.
 */
async function probePlexServer(input: {
  readonly origin: string;
  readonly clientIdentifier: string;
  readonly credential: string;
  readonly createTransport: NonNullable<PlexEnrollmentDependencies["createProbeTransport"]>;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const connection = createPlexConnectionSettings({
    origin: input.origin,
    token: input.credential,
    clientIdentifier: input.clientIdentifier,
  });
  const transport = input.createTransport(connection, new StaticPlexTokenProvider(connection));

  let body: unknown;
  try {
    body = await transport.request<unknown>({
      path: "/",
      operation: PROBE_OPERATION,
      options: { method: "GET", signal: input.signal },
    });
  } catch (error: unknown) {
    throw toProbeFailure(error, input.signal);
  }

  if (!isPlexWireServerResponse(body)) {
    throw new PlexAuthError("PLEX_AUTH_INVALID_RESPONSE");
  }
  return body.MediaContainer.machineIdentifier;
}

/**
 * Polls one authorization pin until it is claimed, cancelled, or expires. The
 * device assertion is signed ONCE and reused — it is bound to the pin, not to a
 * poll — and an unclaimed pin is a `pending` success, never an error.
 */
async function awaitPinClaim(input: {
  readonly account: PlexAccountProtocol;
  readonly pinId: number;
  readonly deviceJwt: string;
  readonly clientIdentifier: string;
  readonly deadlineEpochMs: number;
  readonly now: () => number;
  readonly delay: NonNullable<PlexEnrollmentDependencies["delay"]>;
  readonly signal?: AbortSignal;
}): Promise<string> {
  for (;;) {
    if (input.now() >= input.deadlineEpochMs) {
      throw new PlexAuthError("PLEX_AUTH_ENROLLMENT_EXPIRED");
    }
    const claim = await input.account.readPin({
      pinId: input.pinId,
      deviceJwt: input.deviceJwt,
      clientIdentifier: input.clientIdentifier,
      signal: input.signal,
    });
    if (claim.kind === "claimed") return claim.token;
    await input.delay(ENROLLMENT_POLL_INTERVAL_MS, input.signal);
  }
}

/**
 * Enrolls this install with plex.tv and records the result only after the target
 * Plex Media Server has accepted the new credential.
 *
 * Every `login` mints a FRESH key pair and client identifier; a key is never
 * rotated in place, because duplicate-thumbprint behaviour is unverified (U5).
 * Nothing reaches disk until a credential exists AND the probe succeeds, so a
 * cancelled, expired, or rejected enrollment leaves any previous enrollment
 * untouched. The lifetime is the conservative assumed one (U2).
 *
 * @param options - Target origin, device label, and browser-authorization budget.
 * @param dependencies - Injectable transport, wire mapping, clock, and sinks.
 * @returns The recorded enrollment, with no secret in any field.
 * @throws {PlexAuthError} `PLEX_AUTH_ENROLLMENT_EXPIRED` when the pin lapses,
 *   `PLEX_AUTH_PMS_REJECTED` when the server refuses the credential (U6),
 *   `PLEX_AUTH_UNREACHABLE` when the server cannot be reached,
 *   `PLEX_AUTH_CANCELLED` on abort, or a `PLEX_AUTH_STORE_*` custody failure.
 * @throws TypeError when the URL or the device name is unusable.
 */
export async function enrollPlexClient(
  options: PlexEnrollmentOptions,
  dependencies: PlexEnrollmentDependencies = {},
): Promise<PlexEnrollmentResult> {
  const origin = requirePlexOrigin(options.plexUrl);
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const account = dependencies.account ?? new PlexEnrollmentClient();
  const wire = dependencies.wire ?? PLEX_ACCOUNT_WIRE;
  const notify = dependencies.notify ?? writeStderrLine;
  const deviceName = resolveDeviceName(options.deviceName, dependencies.hostname ?? nodeHostname);
  const clientIdentifier = randomUUID();
  const budgetSeconds = requireTimeoutSeconds(
    options.timeoutSeconds,
    DEFAULT_ENROLLMENT_TIMEOUT_SECONDS,
  );
  const { signal } = options;

  const keyPair = await generatePlexClientKeyPair();
  const pin = await account.createPin({
    publicJwk: keyPair.publicJwk,
    clientIdentifier,
    deviceName,
    signal,
  });

  const link = toPrintable(
    wire.buildAuthorizationUrl({ clientIdentifier, code: pin.code, deviceName }),
    AUTHORIZATION_URL_PRINT_MAX_LENGTH,
  );
  notify(`Plex authorization code: ${toPrintable(pin.code, PIN_CODE_PRINT_MAX_LENGTH)}`);
  notify(`Open this link to authorize rfmedia: ${link}`);

  const assertionInput: PlexAssertionInput = {
    clientIdentifier,
    kid: keyPair.kid,
    audience: PLEX_ASSERTION_AUDIENCE,
    issuedAtEpochSeconds: epochSeconds(now),
    lifetimeSeconds: ASSERTION_LIFETIME_SECONDS,
    jti: randomUUID(),
  };
  const credential = await awaitPinClaim({
    account,
    pinId: pin.pinId,
    deviceJwt: signAssertion(
      keyPair.kid,
      keyPair.privateKeyPkcs8Pem,
      wire.buildPinExchangeClaims(assertionInput),
    ),
    clientIdentifier,
    deadlineEpochMs:
      now() + Math.min(pin.expiresInSeconds, budgetSeconds) * MILLISECONDS_PER_SECOND,
    now,
    delay: dependencies.delay ?? delayCancellably,
    signal,
  });

  const machineIdentifier = await probePlexServer({
    origin,
    clientIdentifier,
    credential,
    createTransport: dependencies.createProbeTransport ?? defaultProbeTransport,
    signal,
  });

  const issuedAtEpochSeconds = epochSeconds(now);
  const replacedExistingEnrollment = await withPlexAuthStoreLock<boolean>(
    withClock(dependencies.store, now),
    // The full lock budget, deliberately not `--timeout`: that governs how long
    // the USER may take in the browser, and discarding a credential that has
    // already been issued and probed because a peer held the lock is worse.
    { deadlineEpochMs: now() + LOCK_WAIT_BUDGET_MS, signal },
    async (current) => ({
      mutations: [
        {
          kind: "enroll",
          clientIdentifier,
          deviceName,
          kid: keyPair.kid,
          privateKeyPkcs8Pem: keyPair.privateKeyPkcs8Pem,
        },
        {
          kind: "issue",
          credential,
          issuedAtEpochSeconds,
          lifetimeSeconds: PLEX_JWT_ASSUMED_LIFETIME_SECONDS,
          lifetimeAssumed: true,
        },
        { kind: "authorize-origin", origin, machineIdentifier },
      ],
      result: current !== undefined,
    }),
  );

  return Object.freeze({
    origin,
    clientIdentifier,
    kid: keyPair.kid,
    deviceName,
    machineIdentifier,
    authorizedAtEpochSeconds: issuedAtEpochSeconds,
    expiresAtEpochSeconds: issuedAtEpochSeconds + PLEX_JWT_ASSUMED_LIFETIME_SECONDS,
    lifetimeAssumed: true,
    replacedExistingEnrollment,
  });
}

/**
 * Reports the credential store's state without touching the network.
 *
 * `clockSkewSeconds` is the LAST PERSISTED observation, or `null`: a live
 * measurement would need a request, and `status` stays offline so it remains
 * usable while plex.tv is unreachable or rate limiting this address.
 *
 * @param options - Optional origin whose authorization should be reported.
 * @param dependencies - Store path override and injectable clock.
 * @returns A secret-free projection of the store.
 * @throws {PlexAuthError} `PLEX_AUTH_STORE_UNSAFE_PATH`,
 *   `PLEX_AUTH_STORE_PERMISSIONS` or `PLEX_AUTH_STORE_CORRUPT`.
 * @throws TypeError when `plexUrl` is not a bare `http(s)` origin.
 */
export function readPlexAuthStatus(
  options: PlexAuthStatusOptions = {},
  dependencies: PlexAuthStoreDependencies = {},
): PlexAuthStatusResult {
  const origin = options.plexUrl === undefined ? null : requirePlexOrigin(options.plexUrl);
  const handle = loadPlexAuthStoreSync(dependencies);

  if (handle === undefined) {
    return Object.freeze({
      enrolled: false as const,
      credentialSource: "none" as const,
      storePath: resolvePlexAuthStorePath(dependencies),
      origin,
    });
  }

  return Object.freeze({
    enrolled: true as const,
    credentialSource: "stored" as const,
    clientIdentifier: handle.clientIdentifier,
    kid: handle.kid,
    deviceName: handle.deviceName,
    storePath: handle.path,
    lockPath: handle.lockPath,
    storeMode: handle.fileMode.toString(8).padStart(3, "0"),
    storeOwnerOnly: (handle.fileMode & 0o077) === 0,
    credential: Object.freeze({
      state: handle.credentialState.kind,
      expiresAtEpochSeconds: handle.credentialState.expiresAtEpochSeconds,
      secondsRemaining: handle.credentialState.secondsRemaining,
      lifetimeAssumed: handle.lifetimeAssumed,
    }),
    refreshNotBeforeEpochSeconds: handle.refreshNotBeforeEpochSeconds,
    clockSkewSeconds: handle.lastObservedSkewSeconds,
    origin,
    originAuthorized:
      origin === null ? null : handle.authorizedOrigins.some((entry) => entry.origin === origin),
    origins: handle.authorizedOrigins,
  });
}

/**
 * Destroys the local root of authority for this install.
 *
 * One signing key backs every authorized origin, so logout removes the whole
 * document rather than one origin and `removedOrigins` reports what that
 * covered. No client-callable revocation endpoint exists, so
 * `serverSideRevocation` is `"manual"` and the Authorized Devices URL is
 * returned — the gap is named, never faked.
 *
 * Removing the document is not sufficient on its own: a crash between the
 * store's publication and its cleanup can strand a `0600` staging copy of the
 * same bytes beside it, so logout sweeps those too.
 *
 * @param options - Lock budget and cancellation signal.
 * @param dependencies - Store path override and injectable clock.
 * @returns What was removed and where server-side revocation must be completed.
 * @throws {PlexAuthError} `PLEX_AUTH_REFRESH_BUSY` at the lock deadline,
 *   `PLEX_AUTH_CANCELLED` on abort, or a `PLEX_AUTH_STORE_*` custody failure.
 */
export async function forgetPlexEnrollment(
  options: PlexForgetOptions = {},
  dependencies: PlexEnrollmentDependencies = {},
): Promise<PlexForgetResult> {
  const now = dependencies.now ?? Date.now;
  const storeDependencies = withClock(dependencies.store, now);
  const storePath = resolvePlexAuthStorePath(storeDependencies);

  return withPlexAuthStoreLock<PlexForgetResult>(
    storeDependencies,
    {
      deadlineEpochMs: now() + lockWaitMilliseconds(options.timeoutSeconds),
      signal: options.signal,
    },
    async (current) => {
      // Under the lock, so no conforming writer can own a live stage: every
      // remaining one is an orphan holding this install's signing key. Swept
      // BEFORE the destroy, so a sweep that cannot complete fails the whole
      // logout instead of reporting a key destroyed while a copy survives.
      await removeOrphanedTemporaryFiles({
        path: storePath,
        temporaryId: PLEX_AUTH_STORE_TEMPORARY_ID,
        subject: PLEX_AUTH_STORE_SUBJECT,
      });

      if (current === undefined) {
        return {
          mutations: [],
          result: Object.freeze({
            removedOrigins: Object.freeze([]),
            keyDestroyed: false,
            serverSideRevocation: "manual" as const,
            authorizedDevicesUrl: PLEX_AUTHORIZED_DEVICES_URL,
            deviceName: null,
          }),
        };
      }
      return {
        mutations: [{ kind: "destroy" }],
        result: Object.freeze({
          removedOrigins: Object.freeze(current.authorizedOrigins.map((entry) => entry.origin)),
          keyDestroyed: true,
          serverSideRevocation: "manual" as const,
          authorizedDevicesUrl: PLEX_AUTHORIZED_DEVICES_URL,
          deviceName: current.deviceName,
        }),
      };
    },
  );
}
