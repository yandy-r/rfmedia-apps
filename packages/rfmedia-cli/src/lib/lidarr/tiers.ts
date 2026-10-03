/**
 * Reliability-tier encoding for Lidarr operations.
 *
 * Reliability tiers are the *execution lane* axis, orthogonal to feature
 * "layers". This module encodes the tier as a first-class, declarative
 * attribute that every Lidarr action exports, plus the `runHealthGate` scaffold
 * that #194/#196 build on to gate Tier-3 (metadata-dependent) operations. The
 * baseline read commands are all `local-only` and never invoke the gate.
 */

import type { LidarrClientApi } from "./client.js";
import type { LidarrHealthCheck } from "../../types/lidarr.js";
import { LidarrUnreachableError } from "./errors.js";

/**
 * Execution / reliability lane a command runs in. Orthogonal to feature layers.
 *
 * - `local-only`: Lidarr local DB only; never touches `api.lidarr.audio`.
 *   Always reliable.
 * - `metadata-dependent`: lookup/add/refresh/search; best-effort — failure is
 *   expected, not exceptional.
 * - `discovery`: external open APIs (Last.fm / ListenBrainz / MusicBrainz) with
 *   multi-source fallback.
 * - `destructive`: bulk delete / file-mutating ops; gated behind explicit flags
 *   plus dry-run.
 */
export type LidarrTier = "local-only" | "metadata-dependent" | "discovery" | "destructive";

/** Static, declarative metadata attached to every Lidarr action. */
export interface LidarrTierDescriptor {
  /** The tier this descriptor describes. */
  readonly tier: LidarrTier;
  /** True when the op can run while `api.lidarr.audio` is unavailable. */
  readonly metadataServerRequired: boolean;
  /** True when a pre-flight health gate must run before executing. */
  readonly requiresHealthGate: boolean;
}

/**
 * Frozen descriptor record keyed by tier.
 *
 * The `satisfies` clause guarantees exhaustive coverage of every
 * {@link LidarrTier} member at compile time.
 */
export const LIDARR_TIER_DESCRIPTORS = Object.freeze({
  "local-only": {
    tier: "local-only",
    metadataServerRequired: false,
    requiresHealthGate: false,
  },
  "metadata-dependent": {
    tier: "metadata-dependent",
    metadataServerRequired: true,
    requiresHealthGate: true,
  },
  discovery: {
    tier: "discovery",
    metadataServerRequired: false,
    requiresHealthGate: false,
  },
  destructive: {
    tier: "destructive",
    metadataServerRequired: false,
    requiresHealthGate: false,
  },
}) satisfies Record<LidarrTier, LidarrTierDescriptor>;

/**
 * Pre-flight health gate for metadata-dependent operations.
 *
 * Baseline read commands do NOT call this; it exists so #194/#196 can gate
 * Tier-3 operations (lookup/add/refresh/search) without new plumbing. It
 * returns only the error-level health checks and leaves the proceed/abort
 * decision to the caller.
 *
 * @deprecated Superseded by `runHealthProbe`/`ensureTierHealthy` in
 * `./health.js` (#195). Kept as a compatible scaffold: the parameter is
 * widened to {@link LidarrClientApi} and the implementation delegates to
 * `runHealthProbe`, preserving the original contract (error-level checks on
 * success; a thrown error when the instance is unreachable).
 *
 * @param client - Lidarr client used to fetch current health checks.
 * @param signal - Optional abort signal forwarded to the health request.
 * @returns The subset of health checks whose severity is `error`.
 * @throws {LidarrError} Propagated from the health probe (transport-level
 *   probe failures are re-raised as `LidarrUnreachableError`).
 */
export async function runHealthGate(
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<readonly LidarrHealthCheck[]> {
  // Lazy import: health.ts statically imports LIDARR_TIER_DESCRIPTORS from
  // this module, so the reverse edge must stay dynamic to keep the static
  // module graph acyclic (and barrel-order safe).
  const { runHealthProbe } = await import("./health.js");
  const report = await runHealthProbe(client, signal);
  if (report.status === "unreachable") {
    throw new LidarrUnreachableError(
      "lidarr health gate",
      "Lidarr health probe found the instance unreachable",
    );
  }
  return report.errors;
}
