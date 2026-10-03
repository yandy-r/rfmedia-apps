/**
 * Public, generated-independent contracts for similar-artist discovery.
 *
 * Provider responses must be validated and projected into these immutable
 * values before they cross the discovery transport boundary.
 */

import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";

/** Default number of similar artists requested from Last.fm. */
export const LIDARR_DISCOVER_DEFAULT_LIMIT = 15;
/** Maximum number of similar artists accepted by discovery. */
export const LIDARR_DISCOVER_MAX_LIMIT = 100;
/** Default inclusive raw-similarity threshold. */
export const LIDARR_DISCOVER_DEFAULT_MIN_SIMILARITY = 0;
/** Maximum inclusive raw-similarity threshold. */
export const LIDARR_DISCOVER_MAX_MIN_SIMILARITY = 1;
/** Default number of candidates admitted from one seed. */
export const LIDARR_DISCOVER_DEFAULT_MAX_PER_SEED = 10;
/** Maximum number of candidates admitted from one seed. */
export const LIDARR_DISCOVER_MAX_PER_SEED = 100;
/** Default one-hop traversal depth. */
export const LIDARR_DISCOVER_DEFAULT_DEPTH = 1;
/** Maximum fixed deep-discovery traversal depth. */
export const LIDARR_DISCOVER_MAX_DEPTH = 2;
/** Maximum provider requests made by one discovery invocation. */
export const LIDARR_DISCOVER_MAX_REQUESTS = 25;
/** Maximum candidate exposures across every bounded provider response. */
export const LIDARR_DISCOVER_MAX_EXPOSURE_COUNT =
  LIDARR_DISCOVER_MAX_REQUESTS * LIDARR_DISCOVER_MAX_LIMIT;
/** Maximum seed identities visited by one discovery invocation. */
export const LIDARR_DISCOVER_MAX_VISITED_SEEDS = 25;
/** Maximum visible candidates returned by one discovery invocation. */
export const LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES = 100;
/** Default diversity score weight. */
export const LIDARR_DISCOVER_DEFAULT_DIVERSITY_BOOST = 0;
/** Default graph-exposure dampening weight. */
export const LIDARR_DISCOVER_DEFAULT_POPULARITY_DAMPENING = 0;
/** Maximum diversity or graph-exposure score weight. */
export const LIDARR_DISCOVER_MAX_SCORE_WEIGHT = 1;
/** Default candidate-approval ceiling. */
export const LIDARR_DISCOVER_DEFAULT_MAX_ADD = 1;
/** Maximum candidate-approval ceiling. */
export const LIDARR_DISCOVER_MAX_ADD = 25;

const CANONICAL_MUSICBRAINZ_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Whether a value is a structurally canonical MusicBrainz UUID. */
export function isCanonicalMusicBrainzId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_MUSICBRAINZ_ID_PATTERN.test(value);
}

/** Stable classification codes emitted by a discovery provider boundary. */
export type DiscoveryProviderFailureCode =
  | "discovery-provider-unavailable"
  | "rate-limited"
  | "validation"
  | "authentication"
  | "authorization"
  | "invalid-response"
  | "timeout"
  | "configuration";

/** Narrow structural failure view consumed by the shared scheduler. */
export interface DiscoveryProviderFailure {
  readonly code: DiscoveryProviderFailureCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;
}

/** One request to Last.fm's fixed similar-artist method. */
export interface LastFmSimilarArtistQuery {
  readonly artist: string;
  readonly limit: number;
  readonly autocorrect: boolean;
  readonly signal?: AbortSignal;
}

/** One validated provider recommendation before action-owned ranking. */
export interface LastFmSimilarArtist {
  readonly name: string;
  readonly similarity: number;
  readonly musicBrainzId?: string;
  readonly sourceUrl: string;
}

/** Mandatory Last.fm attribution carried by every successful result. */
export interface DiscoveryAttribution {
  readonly provider: "lastfm";
  readonly method: "artist.getSimilar";
  readonly attribution: "Recommendations provided by Last.fm";
  readonly url: "https://www.last.fm/";
  readonly fetchedAt: string;
}

/** Complete validated result returned by the fixed Last.fm boundary. */
export interface LastFmSimilarArtistResult {
  readonly requestedName: string;
  readonly resolvedName: string;
  readonly autocorrected: boolean;
  readonly recommendations: readonly LastFmSimilarArtist[];
  readonly source: DiscoveryAttribution;
}

/** Narrow public seam for the sole supported discovery provider. */
export interface LastFmClient {
  getSimilarArtists(query: LastFmSimilarArtistQuery): Promise<LastFmSimilarArtistResult>;
}

/** Fully resolved discovery policy reported for every invocation. */
export interface LidarrDiscoverResolvedPolicy {
  readonly minSimilarity: number;
  readonly maxPerSeed: number;
  readonly deep: boolean;
  readonly cascade: boolean;
  readonly maxDepth: number;
  readonly diversityBoost: number;
  readonly popularityDampening: number;
  readonly maxAdd: number;
}

/** Non-configurable safety ceilings enforced by discovery. */
export interface LidarrDiscoverHardBounds {
  readonly providerLimit: number;
  readonly maxMinSimilarity: number;
  readonly maxPerSeed: number;
  readonly maxDepth: number;
  readonly maxRequests: number;
  readonly maxVisitedSeeds: number;
  readonly maxVisibleCandidates: number;
  readonly maxScoreWeight: number;
  readonly maxAdd: number;
}

/** Stable invocation-scoped lifecycle of a discovered candidate. */
export type DiscoveryCandidateLifecycle = "filtered" | "visited" | "quarantined" | "approved";

/** Stable explanation for a candidate lifecycle decision. */
export type DiscoveryCandidateReason =
  | "below-threshold"
  | "per-seed-cap"
  | "depth-cap"
  | "request-budget"
  | "visited-budget"
  | "visible-budget"
  | "duplicate-identity"
  | "back-edge"
  | "not-selected"
  | "identity-required"
  | "selected";

/** First-path provider evidence retained for one candidate. */
export interface DiscoveryCandidateProvenance {
  readonly seedArtist: string;
  readonly parentArtist: string;
  readonly depth: number;
  readonly providerRank: number;
  readonly firstSeenSequence: number;
  readonly firstPath: readonly string[];
  readonly discoveredAt: string;
}

/** Graph-exposure evidence used by optional score adjustment. */
export interface DiscoveryCandidateExposure {
  readonly exposureCount: number;
  readonly popularityEvidence?: "graph-exposure";
}

/** Ranked recommendation exposed by the discovery action. */
export interface SimilarArtistRecommendation
  extends LastFmSimilarArtist, DiscoveryCandidateExposure {
  readonly rank: number;
  readonly addEligibility: "exact-id" | "requires-resolution";
  readonly status: DiscoveryCandidateLifecycle;
  readonly reason: DiscoveryCandidateReason;
  /** Compatibility alias for the immutable provider similarity. */
  readonly rawSimilarity: number;
  readonly adjustedScore: number;
  readonly provenance: DiscoveryCandidateProvenance;
}

/** Aggregate breadth-first traversal evidence for one invocation. */
export interface LidarrDiscoverTraversalSummary {
  readonly seedsRequested: number;
  readonly requestsMade: number;
  readonly maximumDepthReached: number;
  readonly visited: number;
  readonly visible: number;
  readonly filtered: number;
  readonly duplicatePaths: number;
}

/** Aggregate candidate-handoff counts for one invocation. */
export interface LidarrDiscoverHandoffCounts {
  readonly approved: number;
  readonly alreadyPresent: number;
  readonly planned: number;
  readonly failed: number;
}

/** Per-rank outcome retained in visible-rank approval order. */
export type LidarrDiscoverApproval =
  | {
      readonly status: "planned";
      readonly selectedRank: number;
      readonly musicBrainzId: string;
    }
  | {
      readonly status: "already-present";
      readonly selectedRank: number;
      readonly musicBrainzId: string;
      readonly lidarrId: number;
    }
  | {
      readonly status: "failed";
      readonly selectedRank: number;
      readonly musicBrainzId?: string;
      readonly code: "candidate-not-found" | "identity-required" | "lidarr-plan-failed";
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Outcome of the optional bounded multi-rank Lidarr add-plan handoff.
 *
 * A failed requested handoff remains part of the one successful discovery
 * document so machine output never needs a second error document.
 */
export type LidarrDiscoverHandoff =
  | {
      readonly status: "not-requested";
      readonly approvals: readonly [];
      readonly counts: LidarrDiscoverHandoffCounts;
    }
  | {
      readonly status: "plan-created";
      /** First selected rank retained for single-rank output compatibility. */
      readonly selectedRank: number;
      readonly selectedRanks: readonly number[];
      /** First selected MBID retained for single-rank output compatibility. */
      readonly musicBrainzId: string;
      readonly approvals: readonly LidarrDiscoverApproval[];
      readonly counts: LidarrDiscoverHandoffCounts;
      readonly planId: string;
      readonly planChecksum: string;
      readonly planPath: string;
      readonly nextCommand: string;
    }
  | {
      readonly status: "already-present";
      /** First selected rank retained for single-rank output compatibility. */
      readonly selectedRank: number;
      readonly selectedRanks: readonly number[];
      /** First selected MBID retained for single-rank output compatibility. */
      readonly musicBrainzId: string;
      readonly lidarrId: number;
      readonly approvals: readonly LidarrDiscoverApproval[];
      readonly counts: LidarrDiscoverHandoffCounts;
    }
  | {
      readonly status: "failed";
      readonly selectedRank: number;
      readonly selectedRanks: readonly number[];
      readonly code: "candidate-not-found" | "identity-required" | "lidarr-plan-failed";
      readonly message: string;
      readonly retryable: boolean;
      readonly approvals: readonly LidarrDiscoverApproval[];
      readonly counts: LidarrDiscoverHandoffCounts;
    };

/** Complete attributed result exposed by `rfmedia lidarr discover`. */
export interface LidarrDiscoverResult {
  readonly seed: {
    readonly requestedName: string;
    readonly resolvedName: string;
    readonly autocorrected: boolean;
  };
  readonly request: {
    readonly limit: number;
    readonly autocorrect: boolean;
  };
  readonly policy: LidarrDiscoverResolvedPolicy;
  readonly hardBounds: LidarrDiscoverHardBounds;
  readonly traversal: LidarrDiscoverTraversalSummary;
  readonly recommendations: readonly SimilarArtistRecommendation[];
  readonly returned: number;
  readonly source: DiscoveryAttribution;
  readonly execution: LidarrExecutionSuccessMetadata;
  readonly handoff: LidarrDiscoverHandoff;
}
