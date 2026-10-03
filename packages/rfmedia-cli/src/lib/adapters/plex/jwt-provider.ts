/**
 * The rotating credential provider for enrolled Plex installs (issue #251).
 *
 * THREE LAYERS OF SINGLE-FLIGHT, NOT ONE. A refresh spends one of an IP-scoped
 * budget of ten nonces per 300 s, so burning a redundant one can lock a user out
 * for five minutes:
 *
 * 1. In-process: a module-private `Map<storePath, Promise<string>>` collapses N
 *    concurrent `getToken()` calls onto ONE refresh, cleared in `finally`.
 * 2. Cross-process: the credential-store lock is taken BEFORE the nonce request,
 *    so the network call itself is serialized across processes.
 * 3. Adoption: under the lock the store is RE-READ. A peer that refreshed while
 *    we waited is adopted with ZERO network calls (plan A4.2) — adoption is
 *    keyed on credential freshness, never on the monotonic version, which exists
 *    solely as the store's compare-and-swap axis.
 *
 * BUDGETS, NOT BLIND RETRIES. Collapsing duplicates is only half the guarantee:
 * a refresh that FAILS must not be re-attempted on every call either. Each
 * network-spending failure is charged against a per-store, per-process cap of
 * {@link PLEX_MAX_FAILED_REFRESHES_PER_PROCESS} inside one
 * {@link PLEX_REFRESH_FAILURE_WINDOW_SECONDS}, and a DETERMINISTIC failure also
 * persists a cooperative refusal window so sibling processes decline with zero
 * network calls. A refresh that yields a credential clears both.
 *
 * ONE DOOR FOR THE ORIGIN GUARD. Every value this provider returns comes out of
 * `getPlexConnectionToken`, exactly like {@link StaticPlexTokenProvider}'s, so
 * #119's SEC-001 cross-origin guard cannot evaporate through a second entrance.
 * That requires a ROTATING connection (`createPlexRotatingConnectionSettings`);
 * a static one fails fast with a `TypeError` from the credential cell.
 *
 * SECRET-FREE FAILURES. `PlexAuthError` is mapped onto `MediaServerError` here,
 * with `cause` deliberately never attached, so the private client's selective
 * `#getToken` catch rethrows an already-typed, already-redacted error while a
 * plain `Error` still collapses to its fixed configuration message.
 */

import { randomUUID } from "node:crypto";

import { logWarn } from "../../logger.js";
import { PLEX_REFRESH_BACKOFF_CAP_SECONDS } from "../../retry-after.js";
import { MediaServerError } from "../../../types/media-server.js";
import type { MediaServerErrorCode } from "../../../types/media-server.js";

import type {
  PlexAuthFailureAction,
  PlexCredentialRequestOptions,
  PlexTokenProvider,
} from "./auth.js";
import { rotatePlexCredentialCell } from "./credential-cell.js";
import {
  PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS,
  loadPlexAuthStoreSync,
  readStoredCredential,
  readStoredSigningKey,
  resolvePlexAuthStorePath,
  withPlexAuthStoreLock,
} from "./credential-store.js";
import type {
  PlexAuthStoreDependencies,
  PlexAuthStoreHandle,
  PlexStoreMutation,
  PlexStoreMutationOutcome,
} from "./credential-store.js";
import { PlexEnrollmentClient } from "./enrollment-client.js";
import type { PlexAccountProtocol, PlexNonceIssue } from "./enrollment-client.js";
import { PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS, PlexAuthError } from "./errors.js";
import type { PlexAuthErrorCode } from "./errors.js";
import { PLEX_ACCOUNT_ORIGIN, PLEX_NONCE_MAX_AGE_SECONDS, buildRefreshClaims } from "./jwt-wire.js";
import type { PlexAssertionInput, PlexTokenGrant } from "./jwt-wire.js";
import { signCompactJws } from "./jwt.js";
import { getPlexConnectionCredentialCell, getPlexConnectionToken } from "./types.js";
import type { PlexConnectionSettings } from "./types.js";

/**
 * Hard ceiling on one refresh, covering the cross-process lock wait AND both
 * network calls. Design s.6: the refresh budget is `min(callerDeadline,
 * --timeout, 60 s)`; the caller's deadline arrives as an `AbortSignal`.
 *
 * The ceiling is enforced end to end: the lock WAIT gets it as a deadline, and
 * whatever remains of it after acquisition is composed into the signal the
 * account calls run under. That keeps the worst-case lock HOLD under
 * `SECURE_STORE_LOCK_MAX_AGE_MS` (120 s), so a peer can never declare a live
 * holder's lock stale and spend a second nonce against the same budget.
 */
const PLEX_REFRESH_BUDGET_MS = 60_000;

/** Absolute skew, in seconds, past which the local clock is reported as wrong. */
const PLEX_CLOCK_SKEW_WARN_SECONDS = 300;

/** Lifetime of the short-lived device assertion. It never leaves one exchange. */
const PLEX_ASSERTION_LIFETIME_SECONDS = 60;

/** One nonce fetch plus at most one re-fetch when the first arrived stale. */
const PLEX_MAX_NONCE_ATTEMPTS = 2;

/**
 * Width of the nonce budget both refusal mechanisms are sized to.
 *
 * plex.tv's measured budget is ten nonces per 300 s per IP, so a repeatable
 * failure may cost at most {@link PLEX_MAX_FAILED_REFRESHES_PER_PROCESS}
 * doomed refreshes per window per process, and — for a deterministic failure —
 * per host.
 */
const PLEX_REFRESH_FAILURE_WINDOW_SECONDS = 300;

/**
 * Network-spending refresh failures this process repeats for one store inside
 * {@link PLEX_REFRESH_FAILURE_WINDOW_SECONDS} before failing fast with the last
 * error and no network call at all.
 *
 * Counting is CONSECUTIVE: any refresh that yields a credential — issued here
 * or adopted from a peer — clears the count outright, so a transient failure
 * can never poison a later legitimate refresh.
 */
const PLEX_MAX_FAILED_REFRESHES_PER_PROCESS = 2;

/**
 * Failures that will repeat identically until an operator changes something, so
 * a cooperative refusal window is persisted for them exactly as for a 429.
 *
 * Both are reachable in production: the clock skew case whenever this host
 * disagrees with plex.tv by more than the nonce window, and the unrecognized
 * response case whenever a plex.tv wire change outruns this build's mapping.
 */
const PLEX_DETERMINISTIC_REFRESH_FAILURES: ReadonlySet<PlexAuthErrorCode> =
  new Set<PlexAuthErrorCode>(["PLEX_AUTH_CLOCK_SKEW", "PLEX_AUTH_INVALID_RESPONSE"]);

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Layer 1: in-process single-flight, keyed by the RESOLVED store path so two
 * providers over one store share a refresh while two stores stay independent.
 */
const inFlightRefreshes = new Map<string, Promise<string>>();

/** Reactive (post-401) refreshes already STARTED by this process, per store. */
const reactiveRefreshBudget = new Map<string, number>();

/** The failure to replay instead of spending another nonce, plus its count. */
interface PlexFailedRefreshes {
  /** Consecutive network-spending failures inside the current window. */
  readonly count: number;
  /** The most recent failure, replayed verbatim once the cap is reached. */
  readonly error: PlexAuthError;
  /** Epoch milliseconds of that failure, on the provider's injected clock. */
  readonly atEpochMs: number;
}

/** Consecutive failed refreshes STARTED by this process, per store. */
const failedRefreshes = new Map<string, PlexFailedRefreshes>();

/** Stores whose clock skew has already been warned about in this process. */
const skewWarnedStores = new Set<string>();

/**
 * Charges one reactive (post-401) refresh against this process's budget for
 * `storePath`, reporting `false` — and spending nothing — once the cap is hit.
 */
function consumeReactiveRefreshBudget(storePath: string): boolean {
  const started = reactiveRefreshBudget.get(storePath) ?? 0;
  if (started >= PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS) return false;
  reactiveRefreshBudget.set(storePath, started + 1);
  return true;
}

/**
 * Records a refresh whose network attempt failed, for the per-process cap.
 *
 * Cancellation is deliberately not recorded: it is the caller's own decision,
 * not evidence that refreshing again is doomed.
 */
function recordFailedRefresh(storePath: string, error: unknown, nowEpochMs: number): void {
  if (!(error instanceof PlexAuthError) || error.code === "PLEX_AUTH_CANCELLED") return;
  const previous = failedRefreshes.get(storePath);
  const withinWindow =
    previous !== undefined &&
    nowEpochMs - previous.atEpochMs <=
      PLEX_REFRESH_FAILURE_WINDOW_SECONDS * MILLISECONDS_PER_SECOND;
  failedRefreshes.set(storePath, {
    count: withinWindow ? previous.count + 1 : 1,
    error,
    atEpochMs: nowEpochMs,
  });
}

/**
 * Reports the failure to replay instead of starting yet another doomed refresh,
 * or `undefined` while budget remains. A lapsed window is forgotten here rather
 * than on a timer, so the cap self-heals without any background work.
 */
function exhaustedRefreshFailure(storePath: string, nowEpochMs: number): PlexAuthError | undefined {
  const record = failedRefreshes.get(storePath);
  if (record === undefined) return undefined;
  if (
    nowEpochMs - record.atEpochMs >
    PLEX_REFRESH_FAILURE_WINDOW_SECONDS * MILLISECONDS_PER_SECOND
  ) {
    failedRefreshes.delete(storePath);
    return undefined;
  }
  return record.count >= PLEX_MAX_FAILED_REFRESHES_PER_PROCESS ? record.error : undefined;
}

/** How one {@link PlexAuthErrorCode} presents at the media-server boundary. */
interface PlexAuthFailureShape {
  readonly code: MediaServerErrorCode;
  readonly retryable: boolean;
}

/**
 * Frozen `PlexAuthErrorCode` to `MediaServerError` projection, total by
 * construction: the mapped type makes a missing member a compile error.
 *
 * `retryable` is advisory metadata for outer layers; it says whether running the
 * same command again could plausibly succeed, never whether the private client
 * may replay a request.
 */
const PLEX_AUTH_FAILURE_MAP: Readonly<Record<PlexAuthErrorCode, PlexAuthFailureShape>> =
  Object.freeze({
    PLEX_AUTH_NOT_ENROLLED: { code: "configuration", retryable: false },
    PLEX_AUTH_ORIGIN_NOT_AUTHORIZED: { code: "configuration", retryable: false },
    PLEX_AUTH_STORE_UNSAFE_PATH: { code: "configuration", retryable: false },
    PLEX_AUTH_STORE_PERMISSIONS: { code: "configuration", retryable: false },
    PLEX_AUTH_STORE_CORRUPT: { code: "configuration", retryable: false },
    PLEX_AUTH_STORE_VERSION_CONFLICT: { code: "request-failed", retryable: true },
    PLEX_AUTH_REFRESH_BUSY: { code: "request-failed", retryable: true },
    PLEX_AUTH_RATE_LIMITED: { code: "rate-limited", retryable: true },
    PLEX_AUTH_ENROLLMENT_EXPIRED: { code: "authentication", retryable: false },
    PLEX_AUTH_KEY_REJECTED: { code: "authentication", retryable: false },
    PLEX_AUTH_UNREACHABLE: { code: "network", retryable: true },
    PLEX_AUTH_CANCELLED: { code: "request-failed", retryable: false },
    PLEX_AUTH_PMS_REJECTED: { code: "authorization", retryable: false },
    PLEX_AUTH_INVALID_RESPONSE: { code: "invalid-response", retryable: false },
    PLEX_AUTH_CLOCK_SKEW: { code: "configuration", retryable: false },
  } as const);

/**
 * Projects a `PlexAuthError` onto `MediaServerError`, passing anything else
 * through untouched.
 *
 * `cause` is deliberately NEVER attached: the private client's contract is that
 * a provider failure carries no nested original, and both the message and the
 * remediation already come from frozen local literals.
 */
function asMediaServerFailure(error: unknown, operation: string): unknown {
  if (!(error instanceof PlexAuthError)) return error;
  const shape = PLEX_AUTH_FAILURE_MAP[error.code];
  return new MediaServerError(`${error.message} ${error.remediation}`, {
    code: shape.code,
    serverType: "plex",
    operation,
    retryable: shape.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

/** What one refresh attempt produced, decided under the store lock. */
type PlexRefreshOutcome =
  | { readonly kind: "credential"; readonly credential: string }
  | { readonly kind: "failure"; readonly error: PlexAuthError };

/** One credential exchange, plus the timing the store records for it. */
interface PlexIssuedCredential {
  readonly grant: PlexTokenGrant;
  readonly issuedAtEpochSeconds: number;
  readonly observedSkewSeconds: number;
}

/** Everything one refresh needs that is not fixed at construction. */
interface PlexRefreshRequest {
  readonly signal: AbortSignal | undefined;
  /**
   * The credential a Plex Media Server just rejected, on the reactive path only.
   *
   * A re-read that yields this exact value is NOT an adoptable peer refresh — it
   * is the credential that already failed — so the refresh proceeds. Comparing
   * two credentials this process already holds in memory discloses nothing.
   */
  readonly rejectedCredential?: string;
}

/** Construction options for {@link PlexJwtTokenProvider}. */
export interface PlexJwtTokenProviderOptions {
  /** Credential-store path override; `RFMEDIA_PLEX_AUTH_DIR` still wins. */
  readonly storePath: string;
  /** Seconds before expiry at which `getToken` refreshes proactively. */
  readonly refreshMarginSeconds: number;
  /**
   * Device label for the enrollment verbs. Refresh deliberately ignores it: the
   * label recorded at enrollment is authoritative and already lives in the store.
   */
  readonly deviceName?: string;
  /** Epoch milliseconds. Injected for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** plex.tv transport seam; defaults to the real bounded enrollment client. */
  readonly account?: PlexAccountProtocol;
}

/**
 * Rotating provider backed by the enrolled credential store.
 *
 * @example
 * ```
 * const provider = new PlexJwtTokenProvider(connection, {
 *   storePath,
 *   refreshMarginSeconds: 300,
 * });
 * ```
 */
export class PlexJwtTokenProvider implements PlexTokenProvider {
  readonly #connection: PlexConnectionSettings;
  readonly #storePath: string;
  readonly #refreshMarginSeconds: number;
  readonly #now: () => number;
  readonly #account: PlexAccountProtocol;

  /**
   * @param connection - ROTATING connection state whose cell this provider owns.
   * @param options - Store coordinates, refresh policy, and test seams.
   * @throws TypeError when `refreshMarginSeconds` is not a non-negative safe integer.
   */
  constructor(connection: PlexConnectionSettings, options: PlexJwtTokenProviderOptions) {
    if (!Number.isSafeInteger(options.refreshMarginSeconds) || options.refreshMarginSeconds < 0) {
      throw new TypeError("refreshMarginSeconds must be a non-negative safe integer");
    }
    this.#connection = connection;
    this.#refreshMarginSeconds = options.refreshMarginSeconds;
    this.#now = options.now ?? Date.now;
    this.#account = options.account ?? new PlexEnrollmentClient();
    this.#storePath = resolvePlexAuthStorePath({ storePath: options.storePath });
    Object.freeze(this);
  }

  /**
   * Returns a usable credential, refreshing proactively before it is needed.
   *
   * A credential inside {@link PlexJwtTokenProviderOptions.refreshMarginSeconds}
   * of expiry is replaced BEFORE the request is sent, which is why a
   * mutation-heavy session never needs a replay decision.
   *
   * @param options - Optional cooperative-cancellation context.
   * @returns The credential, read back through the origin guard.
   * @throws {MediaServerError} For every typed credential-lifecycle failure.
   */
  async getToken(options?: PlexCredentialRequestOptions): Promise<string> {
    try {
      const handle = this.#requireStore();
      if (handle.credentialState.kind === "fresh") {
        return this.#publish(readStoredCredential(handle, this.#connection.origin));
      }
      return await this.#refresh({ signal: options?.signal });
    } catch (error: unknown) {
      throw asMediaServerFailure(error, "resolve Plex credential");
    }
  }

  /**
   * Decides whether a rejected REPLAYABLE request may be retried once.
   *
   * This path bypasses the proactive freshness gate — a credential the server
   * refuses is not fresh whatever the local clock says — so it is capped at
   * {@link PLEX_MAX_REACTIVE_REFRESHES_PER_PROCESS} STARTED refreshes per store
   * per process. Joining a refresh already in flight spends no budget while it
   * makes no additional network call; a joiner that has to refresh for real
   * because the in-flight one returned the rejected credential pays for it
   * there, in `#joinRefresh`.
   *
   * @param status - HTTP status returned by the Plex Media Server.
   * @param options - Optional cooperative-cancellation context.
   * @returns `"retry"` once a replacement credential is installed.
   * @throws {MediaServerError} When the refresh itself failed, so the user sees
   *   the actionable cause rather than the original bare authentication status.
   */
  async handleAuthFailure(
    status: number,
    options?: PlexCredentialRequestOptions,
  ): Promise<PlexAuthFailureAction> {
    void status;
    if (!inFlightRefreshes.has(this.#storePath) && !consumeReactiveRefreshBudget(this.#storePath)) {
      return "fail";
    }

    try {
      await this.#refresh({
        signal: options?.signal,
        rejectedCredential: getPlexConnectionToken(this.#connection, this.#connection.origin),
      });
      return "retry";
    } catch (error: unknown) {
      throw asMediaServerFailure(error, "refresh Plex credential");
    }
  }

  #storeDependencies(): PlexAuthStoreDependencies {
    return {
      storePath: this.#storePath,
      now: this.#now,
      refreshMarginSeconds: this.#refreshMarginSeconds,
    };
  }

  #nowSeconds(): number {
    return Math.floor(this.#now() / MILLISECONDS_PER_SECOND);
  }

  #requireStore(): PlexAuthStoreHandle {
    const handle = loadPlexAuthStoreSync(this.#storeDependencies());
    if (handle === undefined) throw new PlexAuthError("PLEX_AUTH_NOT_ENROLLED");
    return handle;
  }

  /**
   * Installs `credential` on the connection and reads it back through the origin
   * guard, so this provider's return value and the static provider's come from
   * the same call.
   */
  #publish(credential: string): string {
    rotatePlexCredentialCell(
      getPlexConnectionCredentialCell(this.#connection),
      this.#connection.origin,
      credential,
    );
    return getPlexConnectionToken(this.#connection, this.#connection.origin);
  }

  /**
   * Layer 1's entry point: joins an in-flight refresh whose result is usable,
   * and starts a real one otherwise.
   *
   * Deliberately NOT `async`: the in-flight promise is registered in the same
   * synchronous turn as the call, which is what collapses N concurrent
   * `getToken()` calls onto one refresh.
   */
  #refresh(request: PlexRefreshRequest): Promise<string> {
    const existing = inFlightRefreshes.get(this.#storePath);
    if (existing === undefined) return this.#startRefresh(request);
    return this.#joinRefresh(existing, request);
  }

  /**
   * Awaits an in-flight refresh, refreshing for real when it resolves to the
   * credential the Plex Media Server just rejected.
   *
   * The leader may have ADOPTED a peer's credential with zero network calls, and
   * that credential can be the very one this caller's request failed with —
   * `#planRefresh`'s `held !== rejectedCredential` guard never ran for it.
   * Handing it back would burn the caller's single replay for nothing, so the
   * joiner charges the reactive budget and refreshes instead. Recursing through
   * `#refresh` keeps this bounded: the budget is finite and never refunded.
   */
  async #joinRefresh(existing: Promise<string>, request: PlexRefreshRequest): Promise<string> {
    const joined = await existing;
    if (request.rejectedCredential === undefined || joined !== request.rejectedCredential) {
      return joined;
    }
    if (!consumeReactiveRefreshBudget(this.#storePath)) {
      throw new PlexAuthError("PLEX_AUTH_PMS_REJECTED");
    }
    return await this.#refresh(request);
  }

  /** Registers one real refresh in layer 1's single-flight map and runs it. */
  #startRefresh(request: PlexRefreshRequest): Promise<string> {
    const pending = this.#performRefresh(request).finally(() => {
      // Only ever retract OUR entry: a joiner that fell through may have
      // registered its own refresh while this one was settling.
      if (inFlightRefreshes.get(this.#storePath) === pending) {
        inFlightRefreshes.delete(this.#storePath);
      }
    });
    inFlightRefreshes.set(this.#storePath, pending);
    return pending;
  }

  async #performRefresh(request: PlexRefreshRequest): Promise<string> {
    const replayed = exhaustedRefreshFailure(this.#storePath, this.#now());
    if (replayed !== undefined) throw replayed;

    const deadlineEpochMs = this.#now() + PLEX_REFRESH_BUDGET_MS;
    const outcome = await withPlexAuthStoreLock<PlexRefreshOutcome>(
      this.#storeDependencies(),
      { deadlineEpochMs, signal: request.signal },
      async (current) => this.#planWithinBudget(current, request, deadlineEpochMs),
    );
    if (outcome.kind === "failure") throw outcome.error;
    // Issued here or adopted from a peer: either way the store is healthy again.
    failedRefreshes.delete(this.#storePath);
    return this.#publish(outcome.credential);
  }

  /**
   * Runs the in-lock plan under whatever remains of the refresh budget.
   *
   * `withPlexAuthStoreLock` applies the budget to the lock WAIT only. Without
   * this the worst legal account path — two nonce calls plus one exchange, each
   * with its own timeout and one honoured `Retry-After` — outlasts the 120 s
   * staleness threshold, and a peer steals the lock from a live holder.
   */
  #planWithinBudget(
    current: PlexAuthStoreHandle | undefined,
    request: PlexRefreshRequest,
    deadlineEpochMs: number,
  ): Promise<PlexStoreMutationOutcome<PlexRefreshOutcome>> {
    const budget = AbortSignal.timeout(Math.max(deadlineEpochMs - this.#now(), 0));
    const signal =
      request.signal === undefined ? budget : AbortSignal.any([request.signal, budget]);
    return this.#planRefresh(current, { ...request, signal });
  }

  /**
   * Decides, under the exclusive store lock, what this refresh should do.
   *
   * Ordering matters: adoption is checked first so a peer's work is never
   * duplicated, then the cooperative rate-limit window is honoured with zero
   * network calls, and only then is a nonce spent.
   */
  async #planRefresh(
    current: PlexAuthStoreHandle | undefined,
    request: PlexRefreshRequest,
  ): Promise<PlexStoreMutationOutcome<PlexRefreshOutcome>> {
    if (current === undefined) throw new PlexAuthError("PLEX_AUTH_NOT_ENROLLED");

    const nowSeconds = this.#nowSeconds();
    // Also enforces the authorized-origin allowlist before any nonce is spent.
    const held = readStoredCredential(current, this.#connection.origin);

    if (
      current.credentialState.kind === "fresh" &&
      current.refreshNotBeforeEpochSeconds <= nowSeconds &&
      held !== request.rejectedCredential
    ) {
      return { mutations: [], result: { kind: "credential", credential: held } };
    }

    if (current.refreshNotBeforeEpochSeconds > nowSeconds) {
      throw new PlexAuthError("PLEX_AUTH_RATE_LIMITED", {
        retryAfterSeconds: current.refreshNotBeforeEpochSeconds - nowSeconds,
      });
    }

    let issued: PlexIssuedCredential;
    try {
      issued = await this.#issueCredential(current, request.signal);
    } catch (error: unknown) {
      recordFailedRefresh(this.#storePath, error, this.#now());
      return planCooperativeBackoff(error, nowSeconds);
    }

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

    // Design s.5.8's stronger skew signal: a refresh that SUCCEEDED but whose
    // credential is already expired means the local clock is wrong. Reporting it
    // as "token expired" would send the user into an endless re-enrollment loop.
    const secondsRemaining =
      issued.issuedAtEpochSeconds + issued.grant.lifetimeSeconds - nowSeconds;
    if (secondsRemaining <= -PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS) {
      const error = new PlexAuthError("PLEX_AUTH_CLOCK_SKEW");
      recordFailedRefresh(this.#storePath, error, this.#now());
      // The wrong clock will produce the same doomed exchange on the next call,
      // so the window is written after the issue mutation that would clear it.
      return {
        mutations: [
          ...mutations,
          backOffMutation(nowSeconds + PLEX_REFRESH_FAILURE_WINDOW_SECONDS),
        ],
        result: { kind: "failure", error },
      };
    }

    return { mutations, result: { kind: "credential", credential: issued.grant.token } };
  }

  /**
   * Spends one nonce, signs one device assertion, and exchanges it.
   *
   * `issuedAt` comes from the nonce response's TLS-authenticated HTTP `Date`
   * header rather than the local clock, so expiry arithmetic survives a skewed
   * system clock (design s.5.7). The account transport surfaces no date on the
   * token response, so the nonce response is the nearest authenticated instant.
   */
  async #issueCredential(
    current: PlexAuthStoreHandle,
    signal: AbortSignal | undefined,
  ): Promise<PlexIssuedCredential> {
    const issue = await this.#obtainFreshNonce(current.clientIdentifier, signal);
    const observedSkewSeconds = this.#nowSeconds() - issue.receivedAtEpochSeconds;
    this.#warnOnceOnClockSkew(observedSkewSeconds);

    const assertion: PlexAssertionInput & { readonly nonce: string } = {
      clientIdentifier: current.clientIdentifier,
      kid: current.kid,
      audience: PLEX_ACCOUNT_ORIGIN,
      issuedAtEpochSeconds: issue.receivedAtEpochSeconds,
      lifetimeSeconds: PLEX_ASSERTION_LIFETIME_SECONDS,
      jti: randomUUID(),
      nonce: issue.nonce,
    };

    const grant = await this.#account.exchangeDeviceAssertion({
      deviceJwt: signCompactJws({
        protectedHeader: { kid: current.kid, alg: "EdDSA", typ: "JWT" },
        payload: buildRefreshClaims(assertion),
        privateKeyPkcs8Pem: readStoredSigningKey(current),
      }),
      clientIdentifier: current.clientIdentifier,
      signal,
    });

    return { grant, issuedAtEpochSeconds: issue.receivedAtEpochSeconds, observedSkewSeconds };
  }

  /**
   * Fetches a nonce that is still inside its 300 s window.
   *
   * A lock wait or a slow probe can straddle that window, so a stale nonce is
   * RE-FETCHED rather than signed. A second stale nonce is not a protocol
   * problem: it means this host's clock disagrees with plex.tv by more than the
   * whole window.
   */
  async #obtainFreshNonce(
    clientIdentifier: string,
    signal: AbortSignal | undefined,
  ): Promise<PlexNonceIssue> {
    for (let attempt = 0; attempt < PLEX_MAX_NONCE_ATTEMPTS; attempt += 1) {
      const issue = await this.#account.createNonce({ clientIdentifier, signal });
      if (this.#nowSeconds() - issue.receivedAtEpochSeconds <= PLEX_NONCE_MAX_AGE_SECONDS) {
        return issue;
      }
    }
    throw new PlexAuthError("PLEX_AUTH_CLOCK_SKEW");
  }

  #warnOnceOnClockSkew(observedSkewSeconds: number): void {
    if (Math.abs(observedSkewSeconds) <= PLEX_CLOCK_SKEW_WARN_SECONDS) return;
    if (skewWarnedStores.has(this.#storePath)) return;
    skewWarnedStores.add(this.#storePath);
    logWarn(
      `Local clock appears off by ~${Math.round(observedSkewSeconds)} seconds against plex.tv; check NTP.`,
    );
  }
}

/**
 * Turns a refresh failure that WILL repeat into a cooperative, cross-process
 * refusal window.
 *
 * The refresh path already holds the store lock when the failure arrives, so the
 * `back-off` mutation costs no second acquisition and no contention path. Every
 * other process then declines to refresh with zero network calls, which is what
 * makes the cooperative claim true rather than aspirational.
 *
 * A 429 carries its own advertised delay. A DETERMINISTIC failure — a clock this
 * host will still have wrong on the next call, a wire shape this build will
 * still not recognize — is refused for one nonce-budget window instead, so a
 * doomed refresh cannot be repeated by every sibling process until the whole
 * household IP is locked out. `rfmedia plex auth login` clears the window
 * outright, because `enroll` resets it. Anything else — cancellation, an
 * unreachable network — is rethrown with no mutation, because repeating it can
 * legitimately succeed.
 */
function planCooperativeBackoff(
  error: unknown,
  nowSeconds: number,
): PlexStoreMutationOutcome<PlexRefreshOutcome> {
  if (!(error instanceof PlexAuthError)) throw error;

  if (error.code === "PLEX_AUTH_RATE_LIMITED") {
    const waitSeconds = Math.min(
      error.retryAfterSeconds ?? PLEX_REFRESH_BACKOFF_CAP_SECONDS,
      PLEX_REFRESH_BACKOFF_CAP_SECONDS,
    );
    return {
      mutations: [backOffMutation(nowSeconds + waitSeconds)],
      result: {
        kind: "failure",
        error: new PlexAuthError("PLEX_AUTH_RATE_LIMITED", { retryAfterSeconds: waitSeconds }),
      },
    };
  }

  if (!PLEX_DETERMINISTIC_REFRESH_FAILURES.has(error.code)) throw error;

  return {
    mutations: [backOffMutation(nowSeconds + PLEX_REFRESH_FAILURE_WINDOW_SECONDS)],
    result: { kind: "failure", error },
  };
}

/** The cooperative refusal window, as the single mutation that carries it. */
function backOffMutation(notBeforeEpochSeconds: number): PlexStoreMutation {
  return { kind: "back-off", notBeforeEpochSeconds };
}
