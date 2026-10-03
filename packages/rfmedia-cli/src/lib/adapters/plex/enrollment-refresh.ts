/**
 * Credential rotation for an enrolled install — `rfmedia plex auth refresh`
 * (issue #251).
 *
 * LOCK BEFORE NETWORK. The store lock is acquired before the nonce request, not
 * merely before the write, so the rotation itself is serialized across
 * processes. A process that loses the race re-reads under the lock and ADOPTS
 * the winner's credential with zero calls, which matters against a measured
 * IP-scoped budget of ten nonces per 300 s.
 *
 * ADOPT ON FRESHNESS, NOT ON VERSION. `back-off`, `authorize-origin` and
 * `forget-origin` all advance the store version WITHOUT issuing a credential, so
 * a version-advance predicate would happily adopt an expired credential and burn
 * the very budget this design exists to protect. The predicate is therefore the
 * re-read credential's own freshness.
 *
 * RATE LIMITS ARE PERSISTED, NOT SLEPT. A 429 too long to wait out is recorded
 * as a cooperative `refreshNotBefore` window under the lock this path already
 * holds, and only then thrown. Every peer process observes it with zero network
 * calls, and no client-side flag — `--force` included — can bypass it.
 *
 * ONE CONVENTION PER SHARED STORE FIELD. This verb and `jwt-provider.ts` both
 * write the same store, so every value they share carries one meaning: skew is
 * local-minus-server, expiry tolerates
 * {@link PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS}, and a credential plex.tv
 * already issued is persisted even when the local clock makes it read expired.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";

import { PLEX_REFRESH_BACKOFF_CAP_SECONDS } from "../../retry-after.js";
import {
  PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS,
  loadPlexAuthStoreSync,
  readStoredSigningKey,
  withPlexAuthStoreLock,
} from "./credential-store.js";
import type {
  PlexAuthStoreDependencies,
  PlexAuthStoreHandle,
  PlexCredentialState,
  PlexStoreMutation,
  PlexStoreMutationOutcome,
} from "./credential-store.js";
import { PlexEnrollmentClient } from "./enrollment-client.js";
import type { PlexAccountProtocol } from "./enrollment-client.js";
import {
  epochSeconds,
  lockWaitMilliseconds,
  PLEX_ASSERTION_AUDIENCE,
  requireAuthorizedOrigin,
  requirePlexOrigin,
  signAssertion,
  withClock,
} from "./enrollment-support.js";
import type { PlexEnrollmentDependencies } from "./enrollment-support.js";
import { PlexAuthError } from "./errors.js";
import { PLEX_ACCOUNT_WIRE, PLEX_NONCE_MAX_AGE_SECONDS } from "./jwt-wire.js";
import type { PlexAccountWire, PlexTokenGrant } from "./jwt-wire.js";

/**
 * Lifetime of the device assertion this verb signs.
 *
 * Deliberately NOT `ASSERTION_LIFETIME_SECONDS` (1800 s): that value exists to
 * outlive a 30-minute authorization pin during `login`. A refresh assertion is
 * exchanged immediately, so it mirrors the provider pipeline's window and keeps
 * the replay surface of a leaked assertion identical on both.
 */
const REFRESH_ASSERTION_LIFETIME_SECONDS = 60;

/** Why a refresh did or did not rotate the credential. */
export type PlexRefreshReason = "forced" | "expiring-soon" | "expired" | "already-fresh";

/** Arguments for `rfmedia plex auth refresh`. */
export interface PlexRefreshOptions {
  /** Raw `--plex-url ?? plex.url`; must already be an authorized origin. */
  readonly plexUrl: string;
  /**
   * Rotate even when the credential is fresh. It does NOT and CANNOT bypass a
   * server-imposed rate limit: the persisted cooperative window is checked first.
   */
  readonly force?: boolean;
  /** Whole seconds allowed for the lock wait; capped at 60. */
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

/** Outcome of `rfmedia plex auth refresh`. */
export interface PlexRefreshResult {
  readonly refreshed: boolean;
  readonly reason: PlexRefreshReason;
  /**
   * False ONLY when a peer's credential was adopted under the lock with zero
   * calls. A run that simply found nothing to do was still the leader: it held
   * the exclusive lock and no other process rotated anything on its behalf.
   */
  readonly singleFlightLeader: boolean;
  readonly expiresAtEpochSeconds: number;
  readonly lifetimeAssumed: boolean;
  readonly retryAfterSeconds: number | null;
}

/**
 * What the locked section decided. Failures are carried out of the lock as data
 * so their `back-off` mutation is still written before the throw reaches the
 * caller.
 */
type RefreshOutcome =
  | { readonly kind: "done"; readonly result: PlexRefreshResult }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "clock-skew" };

interface IssuedCredential {
  readonly grant: PlexTokenGrant;
  readonly issuedAtEpochSeconds: number;
  /**
   * LOCAL clock minus the server's authenticated instant: positive means this
   * host runs AHEAD of plex.tv. Identical to `jwt-provider.ts` because both
   * pipelines publish it through the same `issue` mutation into the store's
   * single `lastObservedSkewSeconds`, which `plex auth status` renders and the
   * provider's warning ("Local clock appears off by ~N seconds") reads.
   */
  readonly observedSkewSeconds: number;
}

/**
 * Issues one nonce recent enough to sign against.
 *
 * A nonce lives 300 s and a lock wait can straddle that window, so a stale issue
 * is re-fetched exactly once. A nonce still stale immediately after issue means
 * the LOCAL clock is wrong, which is reported as skew rather than as an expiry
 * the user cannot act on.
 */
async function requireFreshNonce(input: {
  readonly account: PlexAccountProtocol;
  readonly clientIdentifier: string;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly nonce: string; readonly receivedAtEpochSeconds: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const issue = await input.account.createNonce({
      clientIdentifier: input.clientIdentifier,
      signal: input.signal,
    });
    if (epochSeconds(input.now) - issue.receivedAtEpochSeconds <= PLEX_NONCE_MAX_AGE_SECONDS) {
      return issue;
    }
  }
  throw new PlexAuthError("PLEX_AUTH_CLOCK_SKEW");
}

/**
 * Runs the nonce, sign, and exchange sequence for one stored enrollment.
 *
 * `issuedAt` is the nonce response's TLS-authenticated HTTP `Date` header rather
 * than the local clock: it is transport metadata, not a decoded JWT claim, so
 * the expiry arithmetic survives a skewed local clock while the "never trust
 * unverified claims" rule holds. The nonce itself stays a function-local
 * constant and appears in no store mutation.
 */
async function issueRefreshedCredential(input: {
  readonly account: PlexAccountProtocol;
  readonly wire: PlexAccountWire;
  readonly handle: PlexAuthStoreHandle;
  readonly now: () => number;
  readonly randomUUID: () => string;
  readonly signal?: AbortSignal;
}): Promise<IssuedCredential> {
  const { handle } = input;
  const issue = await requireFreshNonce({
    account: input.account,
    clientIdentifier: handle.clientIdentifier,
    now: input.now,
    signal: input.signal,
  });

  const deviceJwt = signAssertion(
    handle.kid,
    readStoredSigningKey(handle),
    input.wire.buildRefreshClaims({
      clientIdentifier: handle.clientIdentifier,
      kid: handle.kid,
      audience: PLEX_ASSERTION_AUDIENCE,
      issuedAtEpochSeconds: issue.receivedAtEpochSeconds,
      lifetimeSeconds: REFRESH_ASSERTION_LIFETIME_SECONDS,
      jti: input.randomUUID(),
      nonce: issue.nonce,
    }),
  );

  return {
    grant: await input.account.exchangeDeviceAssertion({
      deviceJwt,
      clientIdentifier: handle.clientIdentifier,
      signal: input.signal,
    }),
    issuedAtEpochSeconds: issue.receivedAtEpochSeconds,
    observedSkewSeconds: epochSeconds(input.now) - issue.receivedAtEpochSeconds,
  };
}

/**
 * Reports the credential already in the store without spending a nonce.
 *
 * @param handle - The state re-read under the lock.
 * @param peerAdopted - True only when this credential arrived from a peer that
 *   rotated while this process waited for the lock.
 */
function adoptCurrentCredential(
  handle: PlexAuthStoreHandle,
  peerAdopted: boolean,
): PlexRefreshResult {
  return Object.freeze({
    refreshed: false,
    reason: "already-fresh" as const,
    singleFlightLeader: !peerAdopted,
    expiresAtEpochSeconds: handle.credentialState.expiresAtEpochSeconds,
    lifetimeAssumed: handle.lifetimeAssumed,
    retryAfterSeconds: null,
  });
}

function refreshReason(state: PlexCredentialState, force: boolean): PlexRefreshReason {
  if (state.kind === "expired") return "expired";
  if (state.kind === "refresh-soon") return "expiring-soon";
  return force ? "forced" : "already-fresh";
}

function toBackOffOutcome(
  error: PlexAuthError,
  nowSeconds: number,
): PlexStoreMutationOutcome<RefreshOutcome> {
  const retryAfterSeconds = Math.min(
    error.retryAfterSeconds ?? PLEX_REFRESH_BACKOFF_CAP_SECONDS,
    PLEX_REFRESH_BACKOFF_CAP_SECONDS,
  );
  const backOff: PlexStoreMutation = {
    kind: "back-off",
    notBeforeEpochSeconds: nowSeconds + retryAfterSeconds,
  };
  return { mutations: [backOff], result: { kind: "rate-limited", retryAfterSeconds } };
}

/**
 * Decides and performs the rotation with the store lock already held.
 *
 * @param input - The state re-read under the lock plus the injected seams.
 * @returns The mutations to publish and the outcome to hand back.
 * @throws {PlexAuthError} `PLEX_AUTH_NOT_ENROLLED`,
 *   `PLEX_AUTH_ORIGIN_NOT_AUTHORIZED`, `PLEX_AUTH_RATE_LIMITED` for a still-open
 *   cooperative window, or any account-transport failure.
 */
async function decideRefresh(input: {
  readonly current: PlexAuthStoreHandle | undefined;
  readonly origin: string;
  readonly force: boolean;
  /** Whether rotation was still outstanding when the lock wait began. */
  readonly rotationPending: boolean;
  readonly account: PlexAccountProtocol;
  readonly wire: PlexAccountWire;
  readonly now: () => number;
  readonly randomUUID: () => string;
  readonly signal?: AbortSignal;
}): Promise<PlexStoreMutationOutcome<RefreshOutcome>> {
  const { current } = input;
  if (current === undefined) throw new PlexAuthError("PLEX_AUTH_NOT_ENROLLED");
  requireAuthorizedOrigin(current, input.origin);

  const nowSeconds = epochSeconds(input.now);
  if (current.refreshNotBeforeEpochSeconds > nowSeconds) {
    throw new PlexAuthError("PLEX_AUTH_RATE_LIMITED", {
      retryAfterSeconds: current.refreshNotBeforeEpochSeconds - nowSeconds,
    });
  }

  const state = current.credentialState;
  if (state.kind === "fresh" && !input.force) {
    // Freshness only decays with time for a FIXED credential, so a credential
    // that was not fresh before the lock wait and is fresh now cannot have aged
    // into freshness: a peer rotated it. That is the only honest source for
    // `singleFlightLeader`; without it every no-op refresh claims a peer.
    return {
      mutations: [],
      result: {
        kind: "done",
        result: adoptCurrentCredential(current, input.rotationPending),
      },
    };
  }

  let issued: IssuedCredential;
  try {
    issued = await issueRefreshedCredential({
      account: input.account,
      wire: input.wire,
      handle: current,
      now: input.now,
      randomUUID: input.randomUUID,
      signal: input.signal,
    });
  } catch (error: unknown) {
    if (error instanceof PlexAuthError && error.code === "PLEX_AUTH_RATE_LIMITED") {
      return toBackOffOutcome(error, nowSeconds);
    }
    throw error;
  }

  // plex.tv issued this credential, so it is persisted BEFORE any verdict on the
  // local clock: discarding it would spend the nonce for nothing and leave the
  // remediation ("synchronize the clock, then refresh") with no progress to make.
  const mutations: readonly PlexStoreMutation[] = [
    {
      kind: "issue",
      credential: issued.grant.token,
      issuedAtEpochSeconds: issued.issuedAtEpochSeconds,
      lifetimeSeconds: issued.grant.lifetimeSeconds,
      lifetimeAssumed: issued.grant.lifetimeAssumed,
      observedSkewSeconds: issued.observedSkewSeconds,
    },
  ];

  // A refresh that SUCCEEDED but whose credential already reads expired means the
  // local clock is wrong, not that the token is. Same tolerance as the provider
  // and as `computeCredentialState`, so all three agree on what "expired" means.
  const expiresAtEpochSeconds = issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds;
  if (expiresAtEpochSeconds - nowSeconds <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS) {
    return { mutations, result: { kind: "clock-skew" } };
  }

  return {
    mutations,
    result: {
      kind: "done",
      result: Object.freeze({
        refreshed: true,
        reason: refreshReason(state, input.force),
        singleFlightLeader: true,
        expiresAtEpochSeconds,
        lifetimeAssumed: issued.grant.lifetimeAssumed,
        retryAfterSeconds: null,
      }),
    },
  };
}

/**
 * Observes, BEFORE the lock wait, whether rotation was still outstanding.
 *
 * The read is advisory only — every decision is still made on the state re-read
 * under the lock — so a store that is absent here simply reports "nothing
 * pending" and the locked read raises `PLEX_AUTH_NOT_ENROLLED`.
 *
 * @param dependencies - Store seams already bound to this verb's clock.
 * @returns True when the stored credential was not fresh at that instant.
 */
function hasPendingRotation(dependencies: PlexAuthStoreDependencies): boolean {
  const handle = loadPlexAuthStoreSync(dependencies);
  return handle !== undefined && handle.credentialState.kind !== "fresh";
}

/**
 * Rotates the stored credential for one authorized origin.
 *
 * @param options - Authorized origin, force flag, lock budget, and signal.
 * @param dependencies - Injectable transport, wire mapping, clock, and store seams.
 * @returns Whether the credential rotated, and the resulting expiry.
 * @throws {PlexAuthError} `PLEX_AUTH_NOT_ENROLLED`,
 *   `PLEX_AUTH_ORIGIN_NOT_AUTHORIZED`, `PLEX_AUTH_RATE_LIMITED` carrying the
 *   remaining wait, `PLEX_AUTH_CLOCK_SKEW`, `PLEX_AUTH_KEY_REJECTED`,
 *   `PLEX_AUTH_REFRESH_BUSY`, or `PLEX_AUTH_CANCELLED`.
 * @throws TypeError when `plexUrl` is not a bare `http(s)` origin.
 */
export async function refreshPlexCredential(
  options: PlexRefreshOptions,
  dependencies: PlexEnrollmentDependencies = {},
): Promise<PlexRefreshResult> {
  const origin = requirePlexOrigin(options.plexUrl);
  const now = dependencies.now ?? Date.now;
  const { signal } = options;
  const store = withClock(dependencies.store, now);
  const rotationPending = hasPendingRotation(store);

  const outcome = await withPlexAuthStoreLock<RefreshOutcome>(
    store,
    { deadlineEpochMs: now() + lockWaitMilliseconds(options.timeoutSeconds), signal },
    async (current) =>
      decideRefresh({
        current,
        origin,
        force: options.force === true,
        rotationPending,
        account: dependencies.account ?? new PlexEnrollmentClient(),
        wire: dependencies.wire ?? PLEX_ACCOUNT_WIRE,
        now,
        randomUUID: dependencies.randomUUID ?? nodeRandomUUID,
        signal,
      }),
  );

  if (outcome.kind === "rate-limited") {
    throw new PlexAuthError("PLEX_AUTH_RATE_LIMITED", {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  if (outcome.kind === "clock-skew") {
    throw new PlexAuthError("PLEX_AUTH_CLOCK_SKEW");
  }
  return outcome.result;
}
