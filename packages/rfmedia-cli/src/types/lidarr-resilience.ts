/**
 * Command-facing Lidarr resilience projections (issue #195).
 *
 * These types cross the action/command boundary: `lidarr health` surfaces a
 * {@link LidarrResilienceSnapshot} additively on its result, and `lidarr
 * status`/`lidarr list` attach a {@link LidarrCacheStatus} when a stale cache
 * projection was served under `--allow-stale`.
 *
 * The circuit-state primitives (`CircuitScope`, `CircuitState`) are defined
 * by `src/lib/lidarr/circuit-breaker.ts` — the sole owner of circuit-state
 * semantics — and re-used here so command output and breaker persistence can
 * never drift apart.
 */

import type { CircuitScope, CircuitState } from "../lib/lidarr/circuit-breaker.js";

/**
 * Point-in-time view of the resilience layer for one Lidarr origin, surfaced
 * additively on the `lidarr health` result.
 *
 * When the tracking database cannot be opened, each circuit entry reports
 * `{ state: "unknown", reason }` explicitly — surfaced, never silent — and
 * the health command itself still succeeds.
 */
export interface LidarrResilienceSnapshot {
  /** One entry per circuit scope (`"lidarr"` transport, `"metadata"` provider). */
  readonly circuits: readonly {
    /** Which failure domain this circuit tracks. */
    readonly scope: CircuitScope;
    /** Persisted breaker state, or an explicit unknown marker on DB failure. */
    readonly state: CircuitState | { readonly state: "unknown"; readonly reason: string };
    /** When a non-closed circuit next admits a call (ISO-8601), when known. */
    readonly retryAtIso?: string;
  }[];
  /** Deferred-intent queue counts (empty by construction until #202 ships producers). */
  readonly deferredIntents: {
    /** Rows awaiting replay (`status = 'pending'`). */
    readonly pending: number;
    /** Rows that exhausted their attempts (`status = 'failed'`). */
    readonly failed: number;
  };
}

/**
 * Provenance marker attached to a `lidarr status`/`lidarr list` result when a
 * stale cached projection was served under explicit `--allow-stale` consent.
 */
export interface LidarrCacheStatus {
  /** Where the served data came from — always the persistent SQLite cache in #195. */
  readonly source: "stale-cache";
  /** When the served snapshot was originally fetched from Lidarr (ISO-8601). */
  readonly fetchedAt: string;
  /** Age of the served snapshot at serve time, in whole seconds. */
  readonly ageSeconds: number;
}
