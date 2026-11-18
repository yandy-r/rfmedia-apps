/**
 * Reliability-tier encoding for Lidarr operations.
 *
 * Reliability tiers are the *execution lane* axis, orthogonal to feature
 * "layers". This module encodes the tier as a first-class, declarative
 * attribute that every Lidarr action exports.
 */

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
