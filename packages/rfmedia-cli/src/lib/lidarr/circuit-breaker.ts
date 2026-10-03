/**
 * Lidarr circuit breaker (issue #195).
 *
 * A pure, discriminated-union state machine with windowed failure counting
 * (default: 3 failures within 5 minutes), two scopes per origin (`"lidarr"`
 * transport vs `"metadata"` provider), an explicit crashed-probe self-heal
 * rule, and SQLite-persisted state so consecutive CLI invocations share
 * breaker state — the no-daemon recovery story.
 *
 * This module is the SOLE owner of `lidarr_circuit_state` CRUD.
 *
 * Persistence protocol: the pure transition functions never touch the
 * database; the {@link LidarrCircuitBreaker} handle composes them with a
 * {@link CircuitStore} and owns persistence, writing only on state change.
 * Concurrent CLI runs race on single-row UPSERTs under WAL +
 * `busy_timeout=5000`; last-writer-wins is documented and acceptable at CLI
 * cadence (worst case: one redundant probe).
 */

import type { DbConnection, DbLidarrCircuitState } from "../../types/db.js";
import type { LidarrError, LidarrErrorCode } from "./errors.js";

/**
 * Which failure domain a circuit tracks for a given origin.
 *
 * `"lidarr"` covers transport-level outage of the local instance;
 * `"metadata"` covers "Lidarr up but its upstream metadata provider down" so
 * the two outages stay independently routable (#196 lanes, #202
 * `metadataCircuitOpen`).
 */
export type CircuitScope = "lidarr" | "metadata";

/**
 * Persisted circuit state, as a discriminated union.
 *
 * `closed.recentFailures` holds ISO-8601 failure timestamps, pruned to the
 * policy's failure window and bounded to the failure threshold — failures
 * spread across healthy weeks can never trip the circuit.
 */
export type CircuitState =
  | { readonly state: "closed"; readonly recentFailures: readonly string[] }
  | {
      readonly state: "open";
      readonly openedAt: string;
      readonly cooldownMs: number;
      readonly reason: LidarrErrorCode;
    }
  | {
      readonly state: "half-open";
      readonly probeStartedAt: string;
      readonly reason: LidarrErrorCode;
    };

/** Tuning knobs for circuit transitions (config-sourced, defaults applied by the caller). */
export interface CircuitPolicy {
  /** Failures within {@link CircuitPolicy.failureWindowMs} required to trip. Default 3. */
  readonly failureThreshold: number;
  /** Sliding window for failure counting, in milliseconds. Default 300_000 (5 minutes). */
  readonly failureWindowMs: number;
  /** How long an open circuit rejects calls, in milliseconds. Default 60_000. */
  readonly cooldownMs: number;
}

/** Non-configurable: a crashed half-open probe is presumed dead after this long. */
export const HALF_OPEN_PROBE_TIMEOUT_MS = 120_000; // 4x the 30 s default request timeout

/**
 * Outcome of gating a call through the circuit.
 *
 * When `allowed` is `true` and `probe` is `true`, the gated call itself is
 * the half-open recovery probe. When `allowed` is `false`, `retryAtIso` /
 * `retryAfterMs` describe when the circuit will next admit a call.
 */
export type CircuitDecision =
  | { readonly allowed: true; readonly probe: boolean; readonly next: CircuitState }
  | {
      readonly allowed: false;
      readonly next: CircuitState;
      readonly retryAtIso: string;
      readonly retryAfterMs: number;
      readonly reason: LidarrErrorCode;
    };

/**
 * Pure gate transition — no I/O, exhaustive `switch` with `never` checks.
 *
 * PERSISTENCE CONTRACT: the caller MUST persist `decision.next` via
 * {@link CircuitStore.save} whenever it differs from the loaded state, BEFORE
 * dispatching the gated call ({@link createCircuitBreaker} does this).
 *
 * Half-open rule: loaded half-open with
 * `(now - probeStartedAt) <= HALF_OPEN_PROBE_TIMEOUT_MS` is rejected (a probe
 * is presumed in flight elsewhere; `retryAfterMs` is the remaining window);
 * past the timeout the crashed probe is expired and THIS call becomes a fresh
 * probe (`{ allowed: true, probe: true }` with a fresh `probeStartedAt`) —
 * the crashed-probe self-heal rule.
 *
 * @param state - Circuit state loaded from the store.
 * @param policy - Tuning knobs (threshold, window, cooldown).
 * @param nowIso - Current time as an ISO-8601 string (injectable for tests).
 * @returns The gate decision, including the `next` state to persist.
 */
export function evaluateCircuit(
  state: CircuitState,
  policy: CircuitPolicy,
  nowIso: string,
): CircuitDecision {
  const nowMs = Date.parse(nowIso);
  switch (state.state) {
    case "closed":
      return { allowed: true, probe: false, next: state };
    case "open": {
      const retryAtMs = Date.parse(state.openedAt) + state.cooldownMs;
      if (nowMs < retryAtMs) {
        return {
          allowed: false,
          next: state,
          retryAtIso: new Date(retryAtMs).toISOString(),
          retryAfterMs: retryAtMs - nowMs,
          reason: state.reason,
        };
      }
      // Cooldown elapsed: this call becomes the half-open probe.
      return {
        allowed: true,
        probe: true,
        next: { state: "half-open", probeStartedAt: nowIso, reason: state.reason },
      };
    }
    case "half-open": {
      const probeExpiresAtMs = Date.parse(state.probeStartedAt) + HALF_OPEN_PROBE_TIMEOUT_MS;
      if (nowMs <= probeExpiresAtMs) {
        return {
          allowed: false,
          next: state,
          retryAtIso: new Date(probeExpiresAtMs).toISOString(),
          retryAfterMs: probeExpiresAtMs - nowMs,
          reason: state.reason,
        };
      }
      // Crashed-probe self-heal: the stale probe expired; this call re-probes.
      return {
        allowed: true,
        probe: true,
        next: { state: "half-open", probeStartedAt: nowIso, reason: state.reason },
      };
    }
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled circuit state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Pure success transition: any state collapses to closed with an empty
 * failure window (a half-open probe success closes the circuit).
 *
 * @param _state - Current circuit state (ignored; success always closes).
 * @returns The closed state with `recentFailures` cleared.
 */
export function recordCircuitSuccess(_state: CircuitState): CircuitState {
  return { state: "closed", recentFailures: [] };
}

/**
 * Pure failure transition.
 *
 * Closed: prunes `recentFailures` older than `failureWindowMs`, appends
 * `nowIso`, and trips to open at `failureThreshold` with
 * `cooldownMs = max(policy.cooldownMs, (error.retryAfterSeconds ?? 0) * 1000)`
 * — server Retry-After hints are honored as a cooldown floor. Half-open: the
 * probe failed, so the circuit re-opens with a fresh `openedAt`. Open: stays
 * open unchanged (local-only calls execute while open and only feed
 * counters).
 *
 * @param state - Current circuit state.
 * @param error - The classified failure feeding this scope.
 * @param policy - Tuning knobs (threshold, window, cooldown).
 * @param nowIso - Current time as an ISO-8601 string (injectable for tests).
 * @returns The next circuit state to persist.
 */
export function recordCircuitFailure(
  state: CircuitState,
  error: Pick<LidarrError, "code" | "retryable" | "retryAfterSeconds">,
  policy: CircuitPolicy,
  nowIso: string,
): CircuitState {
  const nowMs = Date.parse(nowIso);
  const cooldownMs = Math.max(policy.cooldownMs, (error.retryAfterSeconds ?? 0) * 1000);
  switch (state.state) {
    case "closed": {
      const withinWindow = state.recentFailures.filter(
        (timestamp) => nowMs - Date.parse(timestamp) < policy.failureWindowMs,
      );
      const recentFailures = [...withinWindow, nowIso].slice(-policy.failureThreshold);
      if (recentFailures.length >= policy.failureThreshold) {
        return { state: "open", openedAt: nowIso, cooldownMs, reason: error.code };
      }
      return { state: "closed", recentFailures };
    }
    case "open":
      return state;
    case "half-open":
      return { state: "open", openedAt: nowIso, cooldownMs, reason: error.code };
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled circuit state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Persistence seam for circuit state, keyed by credential-free canonical
 * origin and {@link CircuitScope} — never the API key.
 */
export interface CircuitStore {
  /**
   * Load the persisted state for an origin/scope pair.
   *
   * @param origin - Credential-free canonical Lidarr origin.
   * @param scope - Which failure domain to load.
   * @returns The persisted state; a missing row yields the closed state.
   * @throws Error when the persisted `state_json` is malformed.
   */
  load(origin: string, scope: CircuitScope): CircuitState;
  /**
   * Persist the state for an origin/scope pair via a single-row UPSERT.
   *
   * @param origin - Credential-free canonical Lidarr origin.
   * @param scope - Which failure domain to save.
   * @param state - The circuit state to persist.
   */
  save(origin: string, scope: CircuitScope, state: CircuitState): void;
}

/** All known error codes, kept in lockstep with {@link LidarrErrorCode} via `satisfies`. */
const LIDARR_ERROR_CODE_FLAGS = {
  "lidarr-unreachable": true,
  "metadata-provider-unavailable": true,
  "rate-limited": true,
  validation: true,
  authentication: true,
  authorization: true,
  "not-found": true,
  "invalid-response": true,
  timeout: true,
  configuration: true,
} satisfies Record<LidarrErrorCode, true>;

const KNOWN_LIDARR_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(LIDARR_ERROR_CODE_FLAGS));

function isLidarrErrorCode(value: unknown): value is LidarrErrorCode {
  return typeof value === "string" && KNOWN_LIDARR_ERROR_CODES.has(value);
}

function isCircuitState(value: unknown): value is CircuitState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate["state"]) {
    case "closed":
      return (
        Array.isArray(candidate["recentFailures"]) &&
        candidate["recentFailures"].every((entry) => typeof entry === "string")
      );
    case "open":
      return (
        typeof candidate["openedAt"] === "string" &&
        typeof candidate["cooldownMs"] === "number" &&
        isLidarrErrorCode(candidate["reason"])
      );
    case "half-open":
      return (
        typeof candidate["probeStartedAt"] === "string" && isLidarrErrorCode(candidate["reason"])
      );
    default:
      return false;
  }
}

function parseCircuitStateJson(
  stateJson: string,
  origin: string,
  scope: CircuitScope,
): CircuitState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch (cause) {
    throw new Error(`Malformed circuit state JSON for ${origin} [${scope}]: not valid JSON`, {
      cause,
    });
  }
  if (!isCircuitState(parsed)) {
    throw new Error(
      `Malformed circuit state JSON for ${origin} [${scope}]: not a valid CircuitState`,
    );
  }
  return parsed;
}

/**
 * Create the SQLite-backed {@link CircuitStore} over `lidarr_circuit_state`.
 *
 * A missing row loads as the closed state; malformed `state_json` throws
 * (fail fast — no silent reset of breaker state). Saves are single-row
 * UPSERTs on `UNIQUE(origin, scope)` that also maintain the queryable
 * `state` summary column.
 *
 * @param db - Open tracking database connection (schema v10+).
 * @returns A store bound to the connection's `lidarr_circuit_state` table.
 */
export function createSqliteCircuitStore(db: DbConnection): CircuitStore {
  const selectStmt = db.prepare(
    "SELECT state_json FROM lidarr_circuit_state WHERE origin = ? AND scope = ?",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO lidarr_circuit_state (origin, scope, state, state_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(origin, scope) DO UPDATE SET
      state = excluded.state,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);
  return {
    load(origin: string, scope: CircuitScope): CircuitState {
      const row = selectStmt.get(origin, scope) as
        | Pick<DbLidarrCircuitState, "state_json">
        | undefined;
      if (row === undefined) {
        return { state: "closed", recentFailures: [] };
      }
      return parseCircuitStateJson(row.state_json, origin, scope);
    },
    save(origin: string, scope: CircuitScope, state: CircuitState): void {
      upsertStmt.run(origin, scope, state.state, JSON.stringify(state), new Date().toISOString());
    },
  };
}

/**
 * Store-backed breaker handle: composes the pure transition functions and
 * OWNS persistence (writes only on state change).
 */
export interface LidarrCircuitBreaker {
  /** Credential-free canonical Lidarr origin this breaker guards. */
  readonly origin: string;
  /** Which failure domain this breaker tracks. */
  readonly scope: CircuitScope;
  /**
   * Gate a call: load, evaluate, persist `next` if changed, return.
   *
   * @returns The gate decision for the caller to honor.
   */
  gate(): CircuitDecision;
  /** Record a successful call: the circuit closes and the window clears. */
  recordSuccess(): void;
  /**
   * Record a failed call. No-op unless `error.code` feeds this breaker's
   * scope (`lidarr-unreachable`/`timeout` feed `"lidarr"`;
   * `metadata-provider-unavailable` feeds `"metadata"`; everything else
   * feeds no circuit).
   *
   * @param error - The classified failure.
   */
  recordFailure(error: LidarrError): void;
  /**
   * Read the current persisted state without transitioning.
   *
   * @returns The persisted circuit state.
   */
  getState(): CircuitState;
}

/** Map an error code to the circuit scope it feeds, if any (design #195 §8). */
function scopeFedByErrorCode(code: LidarrErrorCode): CircuitScope | undefined {
  switch (code) {
    case "lidarr-unreachable":
    case "timeout":
      return "lidarr";
    case "metadata-provider-unavailable":
      return "metadata";
    case "rate-limited":
    case "validation":
    case "authentication":
    case "authorization":
    case "not-found":
    case "invalid-response":
    case "configuration":
      return undefined;
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled Lidarr error code: ${String(exhaustive)}`);
    }
  }
}

/** Structural equality over the {@link CircuitState} union (write-only-on-change guard). */
function circuitStatesEqual(a: CircuitState, b: CircuitState): boolean {
  switch (a.state) {
    case "closed":
      return (
        b.state === "closed" &&
        a.recentFailures.length === b.recentFailures.length &&
        a.recentFailures.every((timestamp, index) => timestamp === b.recentFailures[index])
      );
    case "open":
      return (
        b.state === "open" &&
        a.openedAt === b.openedAt &&
        a.cooldownMs === b.cooldownMs &&
        a.reason === b.reason
      );
    case "half-open":
      return (
        b.state === "half-open" && a.probeStartedAt === b.probeStartedAt && a.reason === b.reason
      );
    default: {
      const exhaustive: never = a;
      throw new Error(`Unhandled circuit state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Create a store-backed {@link LidarrCircuitBreaker} handle.
 *
 * `gate()` persists the `next` state (when it changed) BEFORE returning, so
 * the half-open probe claim is durable before the gated call is dispatched
 * — a crashed probe is then recoverable via the
 * {@link HALF_OPEN_PROBE_TIMEOUT_MS} self-heal rule.
 *
 * @param deps - Store, identity (origin/scope), policy, and an optional
 *   deterministic clock seam for tests.
 * @returns A frozen breaker handle bound to one origin/scope pair.
 */
export function createCircuitBreaker(deps: {
  readonly store: CircuitStore;
  readonly origin: string;
  readonly scope: CircuitScope;
  readonly policy: CircuitPolicy;
  readonly now?: () => Date;
}): LidarrCircuitBreaker {
  const { store, origin, scope, policy } = deps;
  const now = deps.now ?? ((): Date => new Date());

  const persistIfChanged = (previous: CircuitState, next: CircuitState): void => {
    if (!circuitStatesEqual(previous, next)) {
      store.save(origin, scope, next);
    }
  };

  return Object.freeze({
    origin,
    scope,
    gate(): CircuitDecision {
      const current = store.load(origin, scope);
      const decision = evaluateCircuit(current, policy, now().toISOString());
      persistIfChanged(current, decision.next);
      return decision;
    },
    recordSuccess(): void {
      const current = store.load(origin, scope);
      persistIfChanged(current, recordCircuitSuccess(current));
    },
    recordFailure(error: LidarrError): void {
      if (scopeFedByErrorCode(error.code) !== scope) {
        return;
      }
      const current = store.load(origin, scope);
      persistIfChanged(current, recordCircuitFailure(current, error, policy, now().toISOString()));
    },
    getState(): CircuitState {
      return store.load(origin, scope);
    },
  });
}
