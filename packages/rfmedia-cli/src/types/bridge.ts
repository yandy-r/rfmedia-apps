/**
 * Provider-neutral Plex-to-Lidarr artist identity bridge contracts.
 *
 * These contracts contain projected domain evidence only. Provider wire
 * records, generated Lidarr models, database rows, commands, and presenters
 * must remain behind their owning boundaries.
 */

import type { LidarrArtist } from "./lidarr.js";
import type { MediaArtistIdentity } from "./media-server.js";

/** Stored bridge snapshot document version. */
export const BRIDGE_IDENTITY_SNAPSHOT_VERSION = 2;

/** Artist resolution policy version. */
export const BRIDGE_ARTIST_RESOLVER_VERSION = 1;

/** Artist-name normalization policy version. */
export const BRIDGE_ARTIST_NORMALIZATION_VERSION = 1;

/** Artist-name similarity scoring policy version. */
export const BRIDGE_ARTIST_SCORING_VERSION = 1;

/** Minimum similarity score for a review-only name suggestion. */
export const BRIDGE_ARTIST_SCORE_FLOOR = 0.9;

/** Minimum lead over the runner-up for a review-only name suggestion. */
export const BRIDGE_ARTIST_RUNNER_UP_MARGIN = 0.08;

/** Names shorter than this after normalization are exact-name only. */
export const BRIDGE_ARTIST_MIN_FUZZY_NAME_LENGTH = 4;

/** Maximum candidates retained with one resolution outcome. */
export const BRIDGE_ARTIST_MAX_CANDIDATES = 5;

/** Maximum artists accepted from either side of one resolution run. */
export const BRIDGE_ARTIST_MAX_RECORDS = 10_000;

/** Maximum normalized UTF-8 bytes accepted across one resolution run. */
export const BRIDGE_ARTIST_MAX_NORMALIZED_BYTES = 16 * 1024 * 1024;

/** Maximum pairwise name comparisons allowed in one resolution run. */
export const BRIDGE_ARTIST_MAX_COMPARISONS = 1_000_000;

/** Maximum serialized UTF-8 bytes accepted for one snapshot payload. */
export const BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

/** Maximum UTF-8 bytes allowed in a bounded bridge cache error message. */
export const BRIDGE_IDENTITY_CACHE_ERROR_MAX_MESSAGE_BYTES = 1_024;

/** The sole entity kind supported by the artist identity bridge. */
export type BridgeIdentityKind = "artist";

/** Complete provider-instance scope for one artist identity snapshot. */
export interface BridgeIdentityScope {
  /** Canonical credential-free Plex origin. */
  readonly plexOrigin: string;
  /** Stable opaque Plex instance identifier. */
  readonly plexInstanceId: string;
  /** Stable opaque Plex library section identifier. */
  readonly plexLibraryId: string;
  /** Canonical credential-free Lidarr origin. */
  readonly lidarrOrigin: string;
  /** Entity semantic discriminator. */
  readonly entityKind: BridgeIdentityKind;
}

/**
 * Credential-free selector for discovering compatible cached scopes.
 *
 * This selector deliberately omits the Plex instance identifier. Cache
 * results must retain the complete exact scope so callers can fail closed when
 * more than one provider instance or library is compatible.
 */
export interface BridgeIdentityCompatibleScopeSelector {
  /** Canonical credential-free Plex origin. */
  readonly plexOrigin: string;
  /** Canonical credential-free Lidarr origin. */
  readonly lidarrOrigin: string;
  /** Entity semantic discriminator. */
  readonly entityKind: BridgeIdentityKind;
  /** Optional stable Plex library section identifier used to narrow results. */
  readonly plexLibraryId?: string;
}

/**
 * One compatible cached scope returned by credential-free discovery.
 *
 * Zero, one, or many of these results remain caller-visible; a cache owner must
 * never choose a result merely because it is the newest generation.
 */
export interface BridgeIdentityCompatibleScopeResult {
  /** Complete provider-instance scope required for an exact snapshot read. */
  readonly scope: BridgeIdentityScope;
  /** Canonical ISO timestamp for the completed provider observation. */
  readonly capturedAt: string;
  /** Canonical ISO timestamp for the last live exact-evidence verification. */
  readonly verifiedAt: string;
  /** Non-negative age of the cached observation at selection time. */
  readonly ageSeconds: number;
}

/** Resolution methods are evidence and never imply review state by themselves. */
export type BridgeArtistResolutionMethod = "exact-mbid" | "normalized-name" | "fuzzy-name" | "none";

/** Stable reasons emitted by artist identity resolution. */
export type BridgeArtistResolutionReason =
  | "unique-exact-mbid"
  | "unique-normalized-name"
  | "unique-fuzzy-name"
  | "normalized-name-collision"
  | "insufficient-score"
  | "insufficient-margin"
  | "no-candidate"
  | "missing-source-mbid"
  | "malformed-source-mbid"
  | "conflicting-source-mbids"
  | "duplicate-source-mbid"
  | "malformed-target-mbid"
  | "duplicate-target-mbid"
  | "contradictory-mbid"
  | "missing-compatible-snapshot"
  | "stale-snapshot"
  | "incompatible-snapshot"
  | "invalid-response";

/** Minimal source artist evidence retained by the bridge. */
export interface BridgeSourceArtist {
  /** Opaque Plex-local artist identifier. */
  readonly plexId: string;
  /** Bounded terminal-safe artist title. */
  readonly title: string;
  /** Bounded MusicBrainz evidence; the resolver validates canonical artist UUID semantics. */
  readonly artistMbids: readonly string[];
}

/**
 * One bounded, deterministically ranked Lidarr candidate.
 *
 * A score is similarity evidence, not a probability or confidence value.
 */
export interface BridgeArtistCandidate {
  /** Stable one-based order after score and tie-break sorting. */
  readonly rank: number;
  /** Positive Lidarr-local artist identifier. */
  readonly lidarrId: number;
  /** Canonical lowercase artist MBID, or null when Lidarr supplied no usable MBID. */
  readonly artistMbid: string | null;
  /** Bounded terminal-safe artist title. */
  readonly title: string;
  /** Normalized title used as deterministic ordering evidence. */
  readonly normalizedTitle: string;
  /** Name comparison method used for this candidate. */
  readonly method: "normalized-name" | "fuzzy-name";
  /** Similarity score in the closed interval from zero to one. */
  readonly score: number;
}

/** Authoritative target selected only by a unique one-to-one artist MBID join. */
export interface BridgeResolvedArtistTarget {
  /** Positive Lidarr-local artist identifier. */
  readonly lidarrId: number;
  /** Canonical lowercase MusicBrainz artist UUID. */
  readonly artistMbid: string;
  /** Bounded terminal-safe artist title. */
  readonly title: string;
}

/** Minimal immutable Lidarr artist retained for complete reverse-gap analysis. */
export interface BridgeTargetArtist {
  /** Unique positive Lidarr-local artist identifier. */
  readonly lidarrId: number;
  /** Bounded terminal-safe artist title. */
  readonly title: string;
  /** Canonical lowercase artist MBID, or null when Lidarr supplied no usable MBID. */
  readonly artistMbid: string | null;
}

interface BridgeArtistResolutionBase {
  /** Opaque Plex-local artist identifier. */
  readonly plexId: string;
  /** Bounded terminal-safe Plex artist title. */
  readonly title: string;
  /** Stable machine-readable outcome reason. */
  readonly reason: BridgeArtistResolutionReason;
  /** Bounded candidates in deterministic order. */
  readonly candidates: readonly BridgeArtistCandidate[];
}

/** Unique authoritative MBID resolution. */
export interface BridgeArtistResolvedOutcome extends BridgeArtistResolutionBase {
  readonly state: "resolved";
  readonly reason: "unique-exact-mbid";
  readonly method: "exact-mbid";
  /** Canonical source MBID that authorized the join. */
  readonly sourceMbid: string;
  readonly target: BridgeResolvedArtistTarget;
}

/** Review-only name suggestion. */
export interface BridgeArtistSuggestedOutcome extends BridgeArtistResolutionBase {
  readonly state: "suggested";
  readonly reason: "unique-normalized-name" | "unique-fuzzy-name";
  readonly method: "normalized-name" | "fuzzy-name";
  /** The first candidate; review is still required. */
  readonly target: BridgeArtistCandidate;
  /** Difference between the winner and runner-up scores. */
  readonly runnerUpMargin: number;
}

/** Multiple viable name candidates with no selected target. */
export interface BridgeArtistAmbiguousOutcome extends BridgeArtistResolutionBase {
  readonly state: "ambiguous";
  readonly reason: "normalized-name-collision" | "insufficient-margin";
  readonly method: "normalized-name" | "fuzzy-name" | "none";
}

/** Complete live evidence produced no qualifying candidate. */
export interface BridgeArtistUnmatchedOutcome extends BridgeArtistResolutionBase {
  readonly state: "unmatched";
  readonly reason: "insufficient-score" | "no-candidate" | "missing-source-mbid";
  readonly method: "fuzzy-name" | "none";
}

interface BridgeArtistConflictOutcomeBase extends BridgeArtistResolutionBase {
  readonly state: "conflict";
  readonly method: "none";
}

/** Authoritative source or target evidence was malformed or contradictory. */
export type BridgeArtistConflictOutcome =
  | (BridgeArtistConflictOutcomeBase & {
      readonly reason: "duplicate-source-mbid";
      /** Canonical MBID duplicated across one or more Plex artists. */
      readonly sourceMbid: string;
    })
  | (BridgeArtistConflictOutcomeBase & {
      readonly reason:
        | "malformed-source-mbid"
        | "conflicting-source-mbids"
        | "malformed-target-mbid"
        | "duplicate-target-mbid"
        | "contradictory-mbid";
    });

/** Compatible evidence was not available, distinct from a complete unmatched result. */
export interface BridgeArtistUnavailableOutcome extends BridgeArtistResolutionBase {
  readonly state: "unavailable";
  readonly reason:
    | "missing-compatible-snapshot"
    | "stale-snapshot"
    | "incompatible-snapshot"
    | "invalid-response";
  readonly method: "none";
}

/** Complete immutable resolution state for one Plex artist. */
export type BridgeArtistResolutionOutcome =
  | BridgeArtistResolvedOutcome
  | BridgeArtistSuggestedOutcome
  | BridgeArtistAmbiguousOutcome
  | BridgeArtistUnmatchedOutcome
  | BridgeArtistConflictOutcome
  | BridgeArtistUnavailableOutcome;

/** Where and how a complete snapshot was observed. */
export interface BridgeIdentityProvenance {
  readonly source: "live" | "sqlite-cache";
  readonly mode: "online" | "offline";
  readonly freshness: "fresh" | "stale";
  /** Non-negative age for cached evidence, when known. */
  readonly ageSeconds?: number;
}

/**
 * Completeness is orthogonal to individual identity state.
 *
 * A complete snapshot may contain unresolved or conflicting artists.
 */
export interface BridgeIdentityCompleteness {
  /** Whether the source artist enumeration completed. */
  readonly sourceComplete: boolean;
  /** Whether the target artist enumeration completed. */
  readonly targetComplete: boolean;
  /** Whether every enumerated source artist received an outcome. */
  readonly resolutionsComplete: boolean;
  /** Derived conjunction of all completeness dimensions. */
  readonly complete: boolean;
  readonly sourceArtistCount: number;
  readonly targetArtistCount: number;
  readonly resolutionCount: number;
}

/** Pure resolver input over already projected provider-neutral values. */
export interface BridgeArtistResolutionInput {
  readonly scope: BridgeIdentityScope;
  readonly sourceArtists: readonly MediaArtistIdentity[];
  readonly targetArtists: readonly LidarrArtist[];
  /** Whether the source artist enumeration completed. */
  readonly sourceComplete: boolean;
  /** Whether the target artist enumeration completed. */
  readonly targetComplete: boolean;
  /** Canonical ISO timestamp for the completed provider observation. */
  readonly capturedAt: string;
  /** Canonical ISO timestamp for the last live exact-evidence verification. */
  readonly verifiedAt: string;
}

/** Complete, versioned artist identity snapshot for one provider scope. */
export interface BridgeArtistIdentitySnapshot {
  readonly snapshotVersion: typeof BRIDGE_IDENTITY_SNAPSHOT_VERSION;
  readonly resolverVersion: typeof BRIDGE_ARTIST_RESOLVER_VERSION;
  readonly normalizationVersion: typeof BRIDGE_ARTIST_NORMALIZATION_VERSION;
  readonly scoringVersion: typeof BRIDGE_ARTIST_SCORING_VERSION;
  readonly scope: BridgeIdentityScope;
  readonly capturedAt: string;
  readonly verifiedAt: string;
  readonly provenance: BridgeIdentityProvenance;
  readonly completeness: BridgeIdentityCompleteness;
  readonly outcomes: readonly BridgeArtistResolutionOutcome[];
  /** Complete minimal Lidarr catalog in deterministic order. */
  readonly targetArtists: readonly BridgeTargetArtist[];
}

/** Stable classifications emitted by the reconciliation report. */
export type ReconciliationCategory =
  | "authoritative"
  | "review-normalized-name"
  | "review-fuzzy-name"
  | "ambiguous"
  | "unmatched"
  | "conflict"
  | "unavailable";

/** Stable reasons emitted by reconciliation projection. */
export type ReconciliationReason = BridgeArtistResolutionReason | "no-authoritative-source-match";

/** Safe provider-local Plex identity projected into a report. */
export interface ReconciliationSourceIdentity {
  readonly plexId: string;
  readonly title: string;
  /** Canonical artist MBID, or null when exact identity is absent or conflicting. */
  readonly artistMbid: string | null;
}

/** Safe provider-local Lidarr identity projected into a report. */
export interface ReconciliationTargetIdentity {
  readonly lidarrId: number;
  readonly title: string;
  /** Canonical artist MBID, or null when exact identity is absent. */
  readonly artistMbid: string | null;
}

/**
 * One bounded review candidate.
 *
 * The score is name-similarity evidence in the closed interval from zero to
 * one. It is not a probability or confidence value.
 */
export interface ReconciliationCandidate {
  readonly rank: number;
  readonly target: ReconciliationTargetIdentity;
  readonly method: "normalized-name" | "fuzzy-name";
  readonly score: number;
}

interface ReconciliationItemBase {
  readonly category: ReconciliationCategory;
  readonly reason: ReconciliationReason;
  readonly method: BridgeArtistResolutionMethod;
  readonly source: ReconciliationSourceIdentity | null;
  readonly target: ReconciliationTargetIdentity | null;
  /**
   * Name-similarity evidence in the closed interval from zero to one, or null
   * when no single candidate score applies. Never interpret as probability.
   */
  readonly score: number | null;
  /** Winner-to-runner-up score difference, or null when it does not apply. */
  readonly runnerUpMargin: number | null;
  /** Bounded candidates in deterministic rank order. */
  readonly candidates: readonly ReconciliationCandidate[];
}

/** The only authoritative report item: one unique exact artist-MBID join. */
export interface ReconciliationAuthoritativeItem extends ReconciliationItemBase {
  readonly category: "authoritative";
  readonly reason: "unique-exact-mbid";
  readonly method: "exact-mbid";
  readonly source: ReconciliationSourceIdentity;
  readonly target: ReconciliationTargetIdentity & { readonly artistMbid: string };
  readonly score: null;
  readonly runnerUpMargin: null;
  readonly candidates: readonly [];
}

/** Unique normalized-name evidence that always requires operator review. */
export interface ReconciliationNormalizedNameReviewItem extends ReconciliationItemBase {
  readonly category: "review-normalized-name";
  readonly reason: "unique-normalized-name";
  readonly method: "normalized-name";
  readonly source: ReconciliationSourceIdentity;
  readonly target: ReconciliationTargetIdentity;
  readonly score: number;
  readonly runnerUpMargin: number;
}

/** Threshold-and-margin-qualified fuzzy evidence that always requires review. */
export interface ReconciliationFuzzyNameReviewItem extends ReconciliationItemBase {
  readonly category: "review-fuzzy-name";
  readonly reason: "unique-fuzzy-name";
  readonly method: "fuzzy-name";
  readonly source: ReconciliationSourceIdentity;
  readonly target: ReconciliationTargetIdentity;
  readonly score: number;
  readonly runnerUpMargin: number;
}

/** Multiple or insufficiently separated candidates with no selected target. */
export interface ReconciliationAmbiguousItem extends ReconciliationItemBase {
  readonly category: "ambiguous";
  readonly reason: "normalized-name-collision" | "insufficient-margin";
  readonly method: "normalized-name" | "fuzzy-name" | "none";
  readonly source: ReconciliationSourceIdentity;
  readonly target: null;
}

/** Complete source evidence that produced no authoritative target. */
export interface ReconciliationSourceUnmatchedItem extends ReconciliationItemBase {
  readonly category: "unmatched";
  readonly reason: "insufficient-score" | "no-candidate" | "missing-source-mbid";
  readonly method: "fuzzy-name" | "none";
  readonly source: ReconciliationSourceIdentity;
  readonly target: null;
}

/** Complete target evidence that was not consumed by an authoritative source match. */
export interface ReconciliationTargetUnmatchedItem extends ReconciliationItemBase {
  readonly category: "unmatched";
  readonly reason: "no-authoritative-source-match";
  readonly method: "none";
  readonly source: null;
  readonly target: ReconciliationTargetIdentity;
  readonly score: null;
  readonly runnerUpMargin: null;
  readonly candidates: readonly [];
}

/** Malformed, duplicate, or contradictory source/target identity evidence. */
export interface ReconciliationConflictItem extends ReconciliationItemBase {
  readonly category: "conflict";
  readonly reason:
    | "malformed-source-mbid"
    | "conflicting-source-mbids"
    | "duplicate-source-mbid"
    | "malformed-target-mbid"
    | "duplicate-target-mbid"
    | "contradictory-mbid";
  readonly method: "none";
  readonly source: ReconciliationSourceIdentity;
  readonly target: null;
  readonly score: null;
  readonly runnerUpMargin: null;
}

/** Required compatible evidence that could not be trusted. */
export interface ReconciliationUnavailableItem extends ReconciliationItemBase {
  readonly category: "unavailable";
  readonly reason:
    | "missing-compatible-snapshot"
    | "stale-snapshot"
    | "incompatible-snapshot"
    | "invalid-response";
  readonly method: "none";
  readonly source: ReconciliationSourceIdentity;
  readonly target: null;
  readonly score: null;
  readonly runnerUpMargin: null;
}

/** One immutable reconciliation classification or directional-gap row. */
export type ReconciliationItem =
  | ReconciliationAuthoritativeItem
  | ReconciliationNormalizedNameReviewItem
  | ReconciliationFuzzyNameReviewItem
  | ReconciliationAmbiguousItem
  | ReconciliationSourceUnmatchedItem
  | ReconciliationTargetUnmatchedItem
  | ReconciliationConflictItem
  | ReconciliationUnavailableItem;

/** One report row that requires operator review before any target is trusted. */
export type ReconciliationReviewSuggestedItem =
  | ReconciliationNormalizedNameReviewItem
  | ReconciliationFuzzyNameReviewItem;

/** One source-side directional gap that lacks an authoritative exact match. */
export type ReconciliationPlexOnlyItem =
  | ReconciliationReviewSuggestedItem
  | ReconciliationAmbiguousItem
  | ReconciliationSourceUnmatchedItem
  | ReconciliationConflictItem
  | ReconciliationUnavailableItem;

/** Bridge-owned duplicate evidence codes. */
export type ReconciliationDuplicateCode =
  | "duplicate-source-mbid"
  | "duplicate-target-mbid"
  | "source-normalized-name-collision"
  | "target-normalized-name-collision"
  | "contradictory-name-mbid";

/** One bounded safe identity participating in a duplicate finding. */
export type ReconciliationDuplicateMember =
  | {
      readonly side: "plex";
      readonly plexId: string;
      readonly title: string;
      readonly artistMbid: string | null;
    }
  | {
      readonly side: "lidarr";
      readonly lidarrId: number;
      readonly title: string;
      readonly artistMbid: string | null;
    };

/** Optional bridge-owned duplicate identity finding. */
export interface ReconciliationDuplicate {
  readonly code: ReconciliationDuplicateCode;
  readonly artistMbid: string | null;
  readonly normalizedTitle: string | null;
  readonly members: readonly ReconciliationDuplicateMember[];
}

/** Stable inert remediation action codes. */
export type ReconciliationSuggestionCode =
  | "refresh-source-metadata"
  | "correct-target-metadata"
  | "inspect-target"
  | "run-duplicate-audit";

/**
 * Inert remediation data.
 *
 * `argv` is a machine argument vector, never executable shell text. It must not
 * name `rfmedia lidarr apply` or contain provider wire data.
 */
export interface ReconciliationSuggestion {
  readonly code: ReconciliationSuggestionCode;
  readonly source: ReconciliationSourceIdentity | null;
  readonly target: ReconciliationTargetIdentity | null;
  readonly argv: readonly string[];
}

/**
 * Aggregate counts for one report.
 *
 * Primary outcome, gap, duplicate, and suggestion counts are intentionally not
 * disjoint and must not be summed into a catalog total.
 */
export interface ReconciliationSummary {
  readonly sourceArtistCount: number;
  readonly targetArtistCount: number;
  readonly primaryOutcomeCount: number;
  readonly matchedExactCount: number;
  readonly reviewSuggestedCount: number;
  readonly reviewAmbiguousCount: number;
  readonly plexOnlyCount: number;
  readonly lidarrOnlyCount: number;
  readonly conflictCount: number;
  readonly unavailableCount: number;
  readonly duplicatesIncluded: boolean;
  readonly duplicateFindingCount: number;
  readonly suggestionCount: number;
}

/** Frozen public reconciliation report contract. */
export interface PlexLidarrReconciliationResultV1 {
  readonly schema: "rfmedia.plex-lidarr-reconciliation.v1";
  readonly scope: BridgeIdentityScope;
  readonly provenance: BridgeIdentityProvenance;
  readonly capturedAt: string;
  readonly verifiedAt: string;
  readonly completeness: BridgeIdentityCompleteness;
  readonly summary: ReconciliationSummary;
  readonly matchedExact: readonly ReconciliationAuthoritativeItem[];
  readonly reviewSuggested: readonly ReconciliationReviewSuggestedItem[];
  readonly reviewAmbiguous: readonly ReconciliationAmbiguousItem[];
  readonly plexOnly: readonly ReconciliationPlexOnlyItem[];
  readonly lidarrOnly: readonly ReconciliationTargetUnmatchedItem[];
  readonly conflicts: readonly ReconciliationConflictItem[];
  readonly unavailable: readonly ReconciliationUnavailableItem[];
  readonly duplicates: readonly ReconciliationDuplicate[];
  readonly suggestions: readonly ReconciliationSuggestion[];
}

/** Stable low-level bridge cache failure codes. */
export type BridgeIdentityCacheErrorCode =
  | "invalid-scope"
  | "invalid-snapshot"
  | "incompatible-version"
  | "corrupt-payload"
  | "payload-too-large"
  | "database";

/** Structured context for a bounded bridge cache failure. */
export interface BridgeIdentityCacheErrorOptions {
  readonly code: BridgeIdentityCacheErrorCode;
  readonly operation: "read" | "replace" | "purge";
  readonly cause?: unknown;
}

/**
 * Typed failure raised by low-level bridge cache operations.
 *
 * Callers must supply a bounded sanitized message without origins, raw
 * payloads, provider responses, credentials, or candidate data.
 */
export class BridgeIdentityCacheError extends Error {
  override readonly name = "BridgeIdentityCacheError";
  readonly code: BridgeIdentityCacheErrorCode;
  readonly operation: BridgeIdentityCacheErrorOptions["operation"];

  constructor(message: string, options: BridgeIdentityCacheErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.operation = options.operation;
  }
}

/** Target-album evidence used by pure expansion calculation. */
export interface BridgeExpansionTargetAlbum {
  /** Opaque Lidarr-local album identifier. */
  readonly id: string;
  /** Distinct track total, or null when the provider did not supply it. */
  readonly trackCount: number | null;
}

/** Pure checked expansion input over already projected identifiers and counts. */
export interface BridgeExpansionInput {
  /** Opaque selected Plex track identifiers. */
  readonly sourceTrackIds: readonly string[];
  /** Affected Lidarr albums; duplicate IDs are counted once. */
  readonly targetAlbums: readonly BridgeExpansionTargetAlbum[];
}

/** Fail-closed track-to-album expansion evidence for a later workflow. */
export interface BridgeExpansionImpact {
  readonly sourceTrackCount: number;
  readonly targetAlbumCount: number;
  readonly knownTargetTrackCount: number;
  readonly unknownTargetAlbumCount: number;
  /** Target tracks per source track, or null when required evidence is incomplete. */
  readonly trackExpansionRatio: number | null;
  readonly complete: boolean;
  /** True for every non-empty cross-granularity target scope. */
  readonly requiresConfirmation: boolean;
}
