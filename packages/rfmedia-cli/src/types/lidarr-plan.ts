/** Versioned contracts for the Lidarr mutation plan/apply workflow. */

import type { LidarrExecutionMetadata } from "../lib/lidarr/scheduler.js";

export const LIDARR_PLAN_VERSION = "rfmedia.lidarr-plan.v1";
/** Exact schema discriminator for newly produced Lidarr mutation plans. */
export const LIDARR_PLAN_VERSION_V2 = "rfmedia.lidarr-plan.v2";
/** Exact schema discriminator for plans carrying sealed cascade analysis. */
export const LIDARR_PLAN_VERSION_V3 = "rfmedia.lidarr-plan.v3";
/** Exact model discriminator for the first deterministic cascade analysis. */
export const LIDARR_CASCADE_MODEL_VERSION = "rfmedia.lidarr-cascade.v1";
export const LIDARR_PLAN_MAX_BYTES = 10 * 1024 * 1024;
export const LIDARR_PLAN_DEFAULT_MAX_BATCH = 25;
export const LIDARR_PLAN_MAX_BATCH = 1_000;
export const LIDARR_PLAN_MAX_ENTRIES = 1_000;
/** Maximum approved discovery candidates sealed into one artist-add plan. */
export const LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES = 25;

export interface LidarrPlanCreatedBy {
  readonly host: string;
  readonly user: string;
  readonly cliVersion: string;
  readonly cwd: string;
}

/** Stable quantity classes assessed against configured per-plan allowances. */
export type LidarrCascadeBudgetMetricName = "indexerQueries" | "acquisitionCandidates";

/** Stable derivation codes stored instead of mutable human prose. */
export type LidarrCascadeBasisCode =
  | "current-operation-no-search"
  | "changed-artist-monitoring"
  | "changed-album-monitoring"
  | "configured-albums-per-artist"
  | "operation-removes-acquisition-scope"
  | "release-automation-evidence-unavailable"
  | "monitored-album-file-removal"
  | "unmonitored-album-file-removal"
  | "configured-indexer-queries-per-candidate"
  | "acquisition-candidates-known-zero"
  | "acquisition-candidates-unknown"
  | "indexer-queries-per-candidate-not-configured"
  | "changed-entries"
  | "track-file-delete-candidates"
  | "affected-file-bytes"
  | "no-file-impact";

export type LidarrCascadeMetricCertainty = "exact" | "modelled" | "unknown";
export type LidarrCascadeMetricHorizon = "immediate" | "conditional" | "none";
export type LidarrCascadeMetricUnit =
  | "artists"
  | "albums"
  | "indexer-queries"
  | "acquisition-candidates"
  | "files"
  | "bytes";

/** One deterministic cascade quantity; `null` is reserved for unknown values. */
export interface LidarrCascadeMetric {
  readonly value: number | null;
  readonly certainty: LidarrCascadeMetricCertainty;
  readonly horizon: LidarrCascadeMetricHorizon;
  readonly unit: LidarrCascadeMetricUnit;
  readonly basis: LidarrCascadeBasisCode;
}

/** Explicit-null plan-time assumptions consumed by the pure estimator. */
export interface LidarrCascadeAssumptions {
  readonly albumsPerArtist: number | null;
  readonly indexerQueriesPerCandidate: number | null;
}

/** Explicit-null configured per-plan allowances consumed by the pure estimator. */
export interface LidarrCascadeBudgetLimits {
  readonly indexerQueries: number | null;
  readonly acquisitionCandidates: number | null;
}

/** Credential-free resolved policy passed to v3 plan builders. */
export interface LidarrCascadePolicy {
  readonly assumptions: LidarrCascadeAssumptions;
  readonly budgets: LidarrCascadeBudgetLimits;
}

export type LidarrCascadeBudgetStatus = "not-configured" | "within" | "exceeded" | "unknown";

/** Advisory comparison against one configured per-plan allowance. */
export interface LidarrCascadeBudgetAssessment {
  readonly status: LidarrCascadeBudgetStatus;
  readonly limit: number | null;
  readonly projected: number | null;
  readonly provenance: "configured-per-plan";
}

export type LidarrCascadeWarningCode =
  | "indexer-query-budget-exceeded"
  | "acquisition-budget-exceeded"
  | "budget-assessment-incomplete";

/** Stable warning evidence derived from one budget assessment. */
export type LidarrCascadeWarning =
  | {
      readonly code: "indexer-query-budget-exceeded";
      readonly metric: "indexerQueries";
      readonly projected: number;
      readonly limit: number;
      readonly overBy: number;
    }
  | {
      readonly code: "acquisition-budget-exceeded";
      readonly metric: "acquisitionCandidates";
      readonly projected: number;
      readonly limit: number;
      readonly overBy: number;
    }
  | {
      readonly code: "budget-assessment-incomplete";
      readonly metric: LidarrCascadeBudgetMetricName;
      readonly projected: null;
      readonly limit: number;
    };

/** Stable operator actions derived from advisory warnings. */
export type LidarrCascadeRecommendationCode = "reduce-scope" | "split-into-batches" | "delay-apply";

/** Strict checksum-sealed output of the deterministic cascade estimator. */
export interface LidarrCascadeAnalysis {
  readonly modelVersion: typeof LIDARR_CASCADE_MODEL_VERSION;
  readonly assumptions: LidarrCascadeAssumptions;
  readonly metrics: {
    readonly immediateIndexerQueries: LidarrCascadeMetric;
    readonly acquisitionCandidates: LidarrCascadeMetric;
    readonly conditionalIndexerQueries: LidarrCascadeMetric;
    readonly newlyMonitored: LidarrCascadeMetric;
    readonly filesAffected: LidarrCascadeMetric;
    readonly bytesAffected: LidarrCascadeMetric;
  };
  readonly budgets: {
    readonly indexerQueries: LidarrCascadeBudgetAssessment;
    readonly acquisitionCandidates: LidarrCascadeBudgetAssessment;
  };
  readonly warnings: readonly LidarrCascadeWarning[];
  readonly recommendations: readonly LidarrCascadeRecommendationCode[];
}

/** Apply/presentation evidence distinguishes sealed v3 analysis from legacy absence. */
export type LidarrCascadeAnalysisEvidence =
  | {
      readonly status: "recorded";
      readonly analysis: LidarrCascadeAnalysis;
    }
  | {
      readonly status: "not-recorded";
    };

export interface LidarrArtistMonitoringOperation {
  readonly kind: "artist-monitoring";
  readonly desiredMonitored: boolean;
}

export interface LidarrAlbumMonitoringOperation {
  readonly kind: "album-monitoring";
  readonly desiredMonitored: boolean;
  /** Canonical selector tokens (sorted, deduped); `[]` in explicit-ID mode. */
  readonly selectors: readonly string[];
}

export type LidarrMutationOperation =
  | LidarrArtistMonitoringOperation
  | LidarrAlbumMonitoringOperation;

export interface LidarrArtistMonitoringPlanEntry {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: { readonly monitored: boolean };
  readonly after: { readonly monitored: boolean };
  readonly idempotencyKey: string;
}

/**
 * One album target; a structural superset of the artist entry so shared code
 * can read `artistId`/`artistName` on the union without narrowing. No `kind`
 * discriminant field exists (the exact-allowlist validator forbids new keys on
 * artist shapes); narrow structurally via `"albumId" in entry`.
 */
export interface LidarrAlbumMonitoringPlanEntry {
  readonly id: string;
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly albumType?: string;
  readonly before: { readonly monitored: boolean };
  readonly after: { readonly monitored: boolean };
  readonly idempotencyKey: string;
}

export type LidarrMutationPlanEntry =
  | LidarrArtistMonitoringPlanEntry
  | LidarrAlbumMonitoringPlanEntry;

/** Stable ID and review label for a referenced Lidarr profile. */
export interface LidarrPlanResourceReference {
  readonly id: number;
  readonly name: string;
}

/** Stable ID and exact path for a referenced Lidarr root folder. */
export interface LidarrPlanRootFolderReference {
  readonly id: number;
  readonly path: string;
}

/** Stable ID and review label for a referenced Lidarr tag. */
export interface LidarrPlanTagReference {
  readonly id: number;
  readonly label: string;
}

/** Canonical, mutually exclusive selection context sealed into a v2 plan. */
export type LidarrPlanSelectionV2 =
  | {
      readonly kind: "ids";
      readonly artistIds: readonly number[];
    }
  | {
      readonly kind: "filters";
      readonly monitored?: boolean;
      readonly qualityProfile?: LidarrPlanResourceReference;
      readonly metadataProfile?: LidarrPlanResourceReference;
      readonly tags?: readonly LidarrPlanTagReference[];
    }
  | {
      readonly kind: "all";
    };

/** Desired managed profile dimensions for a profile-assignment plan. */
export interface LidarrArtistProfileAssignmentOperation {
  readonly kind: "artist-profile-assignment";
  readonly qualityProfile?: LidarrPlanResourceReference;
  readonly metadataProfile?: LidarrPlanResourceReference;
}

/** Explicit tag mutation modes supported by strict v2 plans. */
export type LidarrArtistTagMutationMode = "add" | "remove" | "set" | "clear";

/** Desired tag mutation and its resolved tag references. */
export interface LidarrArtistTagMutationOperation {
  readonly kind: "artist-tag-mutation";
  readonly mode: LidarrArtistTagMutationMode;
  readonly tags: readonly LidarrPlanTagReference[];
}

/** Plan-wide file handling policy for one artist deletion cohort. */
export interface LidarrArtistDeleteOperation {
  readonly kind: "artist-delete";
  readonly deleteFiles: boolean;
}

/** Exact operation discriminant supported by a v2 plan. */
export type LidarrMutationOperationV2 =
  | LidarrArtistMonitoringOperation
  | LidarrArtistProfileAssignmentOperation
  | LidarrArtistTagMutationOperation
  | LidarrArtistDeleteOperation;

/** Managed profile state captured before or after planning. */
export interface LidarrArtistProfilePlanState {
  readonly qualityProfile?: LidarrPlanResourceReference;
  readonly metadataProfile?: LidarrPlanResourceReference;
}

/** Per-artist profile assignment evidence sealed into a plan. */
export interface LidarrArtistProfilePlanEntry {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: LidarrArtistProfilePlanState;
  readonly after: LidarrArtistProfilePlanState;
  readonly idempotencyKey: string;
}

/** Normalized full tag set captured before or after planning. */
export interface LidarrArtistTagPlanState {
  readonly tags: readonly LidarrPlanTagReference[];
}

/** Per-artist tag mutation evidence and normalized deltas. */
export interface LidarrArtistTagMutationPlanEntry {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: LidarrArtistTagPlanState;
  readonly after: LidarrArtistTagPlanState;
  readonly added: readonly LidarrPlanTagReference[];
  readonly removed: readonly LidarrPlanTagReference[];
  readonly retained: readonly LidarrPlanTagReference[];
  readonly idempotencyKey: string;
}

/** Complete Lidarr-reported file-impact evidence sealed before artist deletion. */
export interface LidarrArtistDeleteEvidence {
  readonly path: string;
  readonly albumCount: number;
  readonly trackFileCount: number;
  readonly sizeOnDisk: number;
}

/** Exact immutable postcondition for an artist deletion. */
export interface LidarrArtistDeletePlanState {
  readonly exists: false;
}

/** Per-artist deletion evidence and immutable absence postcondition. */
export interface LidarrArtistDeletePlanEntry {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: LidarrArtistDeleteEvidence;
  readonly after: LidarrArtistDeletePlanState;
  readonly idempotencyKey: string;
}

/** Exact operation-specific entry shapes accepted by a v2 plan. */
export type LidarrMutationPlanEntryV2 =
  | LidarrArtistMonitoringPlanEntry
  | LidarrArtistProfilePlanEntry
  | LidarrArtistTagMutationPlanEntry
  | LidarrArtistDeletePlanEntry;

export type LidarrRiskLevel = "low" | "medium" | "high";

export interface LidarrPlanRiskSummary {
  readonly level: LidarrRiskLevel;
  readonly destructive: boolean;
  readonly cascade: readonly string[];
}

export interface LidarrPlanReviewSummary {
  readonly requested: number;
  readonly changed: number;
  readonly unchanged: number;
}

/** Aggregate Lidarr-reported impact sealed into an artist-delete plan. */
export interface LidarrArtistDeleteSummary {
  readonly kind: "artist-delete";
  readonly artists: number;
  readonly albums: number;
  readonly trackFiles: number;
  readonly sizeOnDisk: number;
}

/** Operation-specific aggregate evidence sealed into a v2 plan. */
export type LidarrPlanOperationSummaryV2 =
  | {
      readonly kind: "artist-monitoring";
      readonly monitoredBefore: number;
      readonly monitoredAfter: number;
    }
  | {
      readonly kind: "artist-profile-assignment";
      readonly qualityProfileChanged: number;
      readonly metadataProfileChanged: number;
    }
  | {
      readonly kind: "artist-tag-mutation";
      readonly added: number;
      readonly removed: number;
      readonly retained: number;
    }
  | LidarrArtistDeleteSummary;

export interface LidarrMutationPlanV1 {
  readonly version: typeof LIDARR_PLAN_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: LidarrPlanCreatedBy;
  readonly command: "lidarr";
  readonly target: { readonly origin: string };
  readonly operation: LidarrMutationOperation;
  readonly maxBatch: number;
  readonly entries: readonly LidarrMutationPlanEntry[];
  readonly review: LidarrPlanReviewSummary;
  readonly risk: LidarrPlanRiskSummary;
  readonly payloadChecksum: string;
}

interface LidarrMutationPlanV2Base<
  TOperation extends LidarrMutationOperationV2,
  TEntry extends LidarrMutationPlanEntryV2,
  TSummary extends LidarrPlanOperationSummaryV2,
> {
  readonly version: typeof LIDARR_PLAN_VERSION_V2;
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: LidarrPlanCreatedBy;
  readonly command: "lidarr";
  readonly target: { readonly origin: string };
  readonly selection: LidarrPlanSelectionV2;
  readonly operation: TOperation;
  readonly maxBatch: number;
  readonly entries: readonly TEntry[];
  readonly review: LidarrPlanReviewSummary;
  readonly summary: TSummary;
  readonly risk: LidarrPlanRiskSummary;
  readonly payloadChecksum: string;
}

/** Strict operation-discriminated version 2 Lidarr mutation plan. */
export type LidarrMutationPlanV2 =
  | LidarrMutationPlanV2Base<
      LidarrArtistMonitoringOperation,
      LidarrArtistMonitoringPlanEntry,
      Extract<LidarrPlanOperationSummaryV2, { readonly kind: "artist-monitoring" }>
    >
  | LidarrMutationPlanV2Base<
      LidarrArtistProfileAssignmentOperation,
      LidarrArtistProfilePlanEntry,
      Extract<LidarrPlanOperationSummaryV2, { readonly kind: "artist-profile-assignment" }>
    >
  | LidarrMutationPlanV2Base<
      LidarrArtistTagMutationOperation,
      LidarrArtistTagMutationPlanEntry,
      Extract<LidarrPlanOperationSummaryV2, { readonly kind: "artist-tag-mutation" }>
    >
  | LidarrMutationPlanV2Base<
      LidarrArtistDeleteOperation,
      LidarrArtistDeletePlanEntry,
      Extract<LidarrPlanOperationSummaryV2, { readonly kind: "artist-delete" }>
    >;

/** Every supported immutable Lidarr plan artifact version. */
export type LidarrMutationPlan = LidarrMutationPlanV1 | LidarrMutationPlanV2;

// ---------------------------------------------------------------------------
// Foreign-ID artist-add lane.
//
// This is a parallel v2 family because existing artist operations are keyed by
// a present numeric Lidarr artist ID. Artist creation is keyed by an expected-
// absent MusicBrainz ID and must be routed by operation kind first.
// ---------------------------------------------------------------------------

/** Legacy fixed policy retained for exact parsing and checksum compatibility. */
export interface LidarrArtistAddLegacyOperationV2 {
  readonly kind: "artist-add";
  readonly rootFolder: LidarrPlanRootFolderReference;
  readonly qualityProfile: LidarrPlanResourceReference;
  readonly metadataProfile: LidarrPlanResourceReference;
  readonly monitored: false;
  readonly monitorNewItems: "none";
  readonly searchForMissingAlbums: false;
}

/** Extended resolved policy sealed by newly produced artist-add plans. */
export interface LidarrArtistAddExtendedOperationV2 {
  readonly kind: "artist-add";
  readonly rootFolder: LidarrPlanRootFolderReference;
  readonly qualityProfile: LidarrPlanResourceReference;
  readonly metadataProfile: LidarrPlanResourceReference;
  readonly monitored: boolean;
  readonly monitorNewItems: "none";
  readonly searchForMissingAlbums: false;
  /** Canonical album-type selectors to unmonitor after creation. */
  readonly postAddUnmonitorSelectors: readonly string[];
}

/** Every exact artist-add operation shape accepted by the v2 parser. */
export type LidarrArtistAddOperationV2 =
  | LidarrArtistAddLegacyOperationV2
  | LidarrArtistAddExtendedOperationV2;

/** Last.fm evidence explaining one selected add recommendation. */
export interface LidarrArtistAddProvenanceV2 {
  readonly source: "lastfm";
  readonly method: "artist.getSimilar";
  readonly seedArtist: string;
  readonly similarity: number;
  readonly candidateUrl: string;
  readonly discoveredAt: string;
  /** Invocation-local visible rank explicitly approved by the operator. */
  readonly selectedRank?: number;
  /** First parent whose response exposed this candidate. */
  readonly parentArtist?: string;
  /** Breadth-first depth of the retained first path. */
  readonly depth?: number;
  /** One-based rank in the retained provider response. */
  readonly providerRank?: number;
  /** Stable first-seen sequence used as a deterministic ranking tie-breaker. */
  readonly firstSeenSequence?: number;
  /** Seed-to-candidate artist-name path retained for review. */
  readonly firstPath?: readonly string[];
  /** Policy-adjusted score kept separate from immutable `similarity`. */
  readonly adjustedScore?: number;
  /** Number of provider paths that exposed this candidate. */
  readonly exposureCount?: number;
  /** Evidence basis disclosed when popularity dampening affected ranking. */
  readonly popularityEvidence?: "graph-exposure";
}

/** Legacy expected-absent target retained without changing checksum material. */
export interface LidarrArtistAddLegacyPlanEntryV2 {
  readonly id: string;
  readonly artistName: string;
  readonly foreignArtistId: string;
  readonly before: { readonly exists: false };
  readonly after: {
    readonly exists: true;
    readonly rootFolder: LidarrPlanRootFolderReference;
    readonly qualityProfile: LidarrPlanResourceReference;
    readonly metadataProfile: LidarrPlanResourceReference;
    readonly monitored: false;
    readonly monitorNewItems: "none";
    readonly searchForMissingAlbums: false;
  };
  readonly provenance: LidarrArtistAddProvenanceV2;
  readonly idempotencyKey: string;
}

/** Extended expected-absent target with the complete reviewed add policy. */
export interface LidarrArtistAddExtendedPlanEntryV2 {
  readonly id: string;
  readonly artistName: string;
  readonly foreignArtistId: string;
  readonly before: { readonly exists: false };
  readonly after: {
    readonly exists: true;
    readonly rootFolder: LidarrPlanRootFolderReference;
    readonly qualityProfile: LidarrPlanResourceReference;
    readonly metadataProfile: LidarrPlanResourceReference;
    readonly monitored: boolean;
    readonly monitorNewItems: "none";
    readonly searchForMissingAlbums: false;
    /** Canonical album-type selectors whose matches must be unmonitored. */
    readonly postAddUnmonitorSelectors: readonly string[];
  };
  readonly provenance: LidarrArtistAddProvenanceV2;
  readonly idempotencyKey: string;
}

/** Every exact artist-add entry shape accepted by the v2 parser. */
export type LidarrArtistAddPlanEntryV2 =
  | LidarrArtistAddLegacyPlanEntryV2
  | LidarrArtistAddExtendedPlanEntryV2;

/** Exact foreign-ID selection accepted for legacy and multi-entry artist-add plans. */
export type LidarrArtistAddPlanSelectionV2 =
  | {
      readonly kind: "foreign-artist-id";
      readonly foreignArtistId: string;
    }
  | {
      readonly kind: "foreign-artist-ids";
      readonly foreignArtistIds: readonly [string, ...string[]];
    };

/** Aggregate evidence for the bounded artist-add family. */
export interface LidarrArtistAddPlanSummaryV2 {
  readonly kind: "artist-add";
  readonly artists: number;
}

interface LidarrArtistAddPlanV2Base<
  TOperation extends LidarrArtistAddOperationV2,
  TEntry extends LidarrArtistAddPlanEntryV2,
> {
  readonly version: typeof LIDARR_PLAN_VERSION_V2;
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: LidarrPlanCreatedBy;
  readonly command: "lidarr";
  readonly target: { readonly origin: string };
  readonly selection: LidarrArtistAddPlanSelectionV2;
  readonly operation: TOperation;
  readonly maxBatch: number;
  readonly entries: readonly [TEntry, ...TEntry[]];
  readonly review: LidarrPlanReviewSummary;
  readonly summary: LidarrArtistAddPlanSummaryV2;
  readonly risk: LidarrPlanRiskSummary;
  readonly payloadChecksum: string;
}

/** Exact legacy artist-add artifact retained for checksum-stable parsing. */
export type LidarrArtistAddLegacyPlanV2 = LidarrArtistAddPlanV2Base<
  LidarrArtistAddLegacyOperationV2,
  LidarrArtistAddLegacyPlanEntryV2
>;

/** Extended artist-add artifact carrying reviewed monitoring and normalization policy. */
export type LidarrArtistAddExtendedPlanV2 = LidarrArtistAddPlanV2Base<
  LidarrArtistAddExtendedOperationV2,
  LidarrArtistAddExtendedPlanEntryV2
>;

/** Bounded, non-empty artist-add plan sharing the existing v2 discriminator. */
export type LidarrArtistAddPlanV2 = LidarrArtistAddLegacyPlanV2 | LidarrArtistAddExtendedPlanV2;

// ---------------------------------------------------------------------------
// Album mutation lanes (album-edit / album-delete).
//
// Union decision (design §12.3): the album kinds are exposed through PARALLEL
// widened "Extended" unions instead of adding members to
// LidarrMutationOperationV2, LidarrMutationPlanEntryV2, LidarrPlanSelectionV2,
// LidarrPlanOperationSummaryV2, or LidarrPlanObservedState in place. The
// exhaustive artist switches stay untouched at compile time
// (getLidarrMutationOperationDefinition in plan-operation-definitions.ts,
// canonicalizeSelection/canonicalizeSummary in plan-engine.ts, and the
// presenter kind switches), and existing sealed artist artifacts keep
// validating byte-for-byte. Album plans reuse the exact v2 version string;
// dispatch is by `plan.operation.kind`, never by version.
// ---------------------------------------------------------------------------

/** Desired release-policy (`anyReleaseOk`) state sealed into an album-edit plan. */
export interface LidarrAlbumEditOperationV2 {
  readonly kind: "album-edit";
  readonly desiredAnyReleaseOk: boolean;
  /** Canonical selector tokens (sorted, deduped); `[]` in explicit-ID mode. */
  readonly selectors: readonly string[];
}

/** Destructive removal directives sealed into an album-delete plan. */
export interface LidarrAlbumDeleteOperationV2 {
  readonly kind: "album-delete";
  readonly deleteFiles: boolean;
  readonly addImportListExclusion: boolean;
  readonly includeMonitored: boolean;
  /** Canonical selector tokens (sorted, deduped); `[]` in explicit-ID mode. */
  readonly selectors: readonly string[];
}

/** Exact operation discriminant supported by an album v2 plan. */
export type LidarrAlbumMutationOperationV2 =
  | LidarrAlbumEditOperationV2
  | LidarrAlbumDeleteOperationV2;

/** Exact retention criteria sealed for one album trackfile cleanup. */
export interface LidarrTrackFileFilterOperationV2 {
  readonly kind: "track-file-filter";
  readonly explicitKeepTrackIds: readonly number[];
  readonly minStars?: number;
}

/** Artist and album v2 operations combined for shared plan consumers. */
export type LidarrMutationOperationV2Extended =
  | LidarrMutationOperationV2
  | LidarrAlbumMutationOperationV2
  | LidarrTrackFileFilterOperationV2;

/**
 * One album-edit target. Entries carry NO kind discriminant (primary dispatch
 * is `plan.operation.kind`); narrow structurally: `"albumId" in entry` selects
 * the album family and `"anyReleaseOk" in entry.before` selects album-edit.
 */
export interface LidarrAlbumEditPlanEntryV2 {
  /** Validator-enforced stable entry id: `album:${albumId}`. */
  readonly id: string;
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly albumType?: string;
  readonly before: { readonly anyReleaseOk: boolean };
  readonly after: { readonly anyReleaseOk: boolean };
  readonly idempotencyKey: string;
}

/**
 * One album-delete target. Entries carry NO kind discriminant (primary
 * dispatch is `plan.operation.kind`); narrow structurally: `"albumId" in
 * entry` selects the album family and `"deleted" in entry.after` selects
 * album-delete.
 */
export interface LidarrAlbumDeletePlanEntryV2 {
  /** Validator-enforced stable entry id: `album:${albumId}`. */
  readonly id: string;
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  /** Wrong-target drift guard captured at plan time. */
  readonly foreignAlbumId?: string;
  readonly albumType?: string;
  readonly before: {
    readonly monitored: boolean;
    readonly trackFileCount: number;
    readonly sizeOnDisk: number;
  };
  readonly after: { readonly deleted: true };
  /**
   * sha256 over {origin, operation, albumId, deleteFiles,
   * addImportListExclusion, foreignAlbumId ?? null}.
   */
  readonly idempotencyKey: string;
}

/** Exact operation-specific entry shapes accepted by an album v2 plan. */
export type LidarrAlbumMutationPlanEntryV2 =
  | LidarrAlbumEditPlanEntryV2
  | LidarrAlbumDeletePlanEntryV2;

/** One exact managed file selected for deletion by a reviewed filter plan. */
export interface LidarrTrackFileDeleteCandidateV2 {
  readonly trackId: number;
  readonly trackTitle: string;
  readonly trackFileId: number;
  readonly path: string;
  readonly size: number;
  readonly mediumNumber?: number;
  readonly absoluteTrackNumber?: number;
  readonly rating?: number;
}

/** Stable warning explaining why a track was retained. */
export interface LidarrTrackFilterWarningV2 {
  readonly code:
    | "missing-file"
    | "unmapped-file"
    | "ambiguous-file"
    | "cross-album-file"
    | "unrated-or-unreadable";
  readonly trackId?: number;
  readonly trackFileId?: number;
  readonly path?: string;
  readonly message: string;
}

/** Single album-scoped entry carrying exact pre-delete evidence. */
export interface LidarrTrackFileFilterPlanEntryV2 {
  readonly id: string;
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: {
    readonly deleteCandidates: readonly LidarrTrackFileDeleteCandidateV2[];
  };
  readonly after: {
    readonly deletedTrackFileIds: readonly number[];
  };
  readonly keptTrackIds: readonly number[];
  readonly warnings: readonly LidarrTrackFilterWarningV2[];
  readonly idempotencyKey: string;
}

/** Artist and album v2 entries combined for shared plan consumers. */
export type LidarrMutationPlanEntryV2Extended =
  | LidarrMutationPlanEntryV2
  | LidarrAlbumMutationPlanEntryV2
  | LidarrTrackFileFilterPlanEntryV2;

/** Canonical, mutually exclusive selection context sealed into an album v2 plan. */
export type LidarrAlbumPlanSelectionV2 =
  | {
      readonly kind: "album-ids";
      readonly albumIds: readonly number[];
    }
  | {
      readonly kind: "album-filters";
      readonly artistIds?: readonly number[];
      readonly selectors: readonly string[];
      readonly includeMonitored?: boolean;
    };

/** Exact parent selection for one trackfile-filter plan. */
export interface LidarrTrackFilterPlanSelectionV2 {
  readonly kind: "album-track-filter";
  readonly albumId: number;
}

/** Artist and album selection contexts combined for shared plan consumers. */
export type LidarrPlanSelectionV2Extended =
  | LidarrPlanSelectionV2
  | LidarrAlbumPlanSelectionV2
  | LidarrTrackFilterPlanSelectionV2;

/** Operation-specific aggregate evidence sealed into an album v2 plan. */
export type LidarrAlbumPlanOperationSummaryV2 =
  | {
      readonly kind: "album-edit";
      readonly changedToTrue: number;
      readonly changedToFalse: number;
    }
  | {
      readonly kind: "album-delete";
      readonly albums: number;
      readonly withFiles: number;
      readonly totalTrackFiles: number;
      readonly totalSizeOnDisk: number;
      readonly deleteFiles: boolean;
      readonly importListExclusions: boolean;
    };

/** Aggregate retention evidence sealed into a trackfile-filter plan. */
export interface LidarrTrackFilterPlanSummaryV2 {
  readonly kind: "track-file-filter";
  readonly tracks: number;
  readonly kept: number;
  readonly deleteCandidates: number;
  readonly warnings: number;
  readonly totalDeleteBytes: number;
}

/** Artist and album plan summaries combined for shared plan consumers. */
export type LidarrPlanOperationSummaryV2Extended =
  | LidarrPlanOperationSummaryV2
  | LidarrAlbumPlanOperationSummaryV2
  | LidarrTrackFilterPlanSummaryV2;

interface LidarrAlbumMutationPlanV2Base<
  TOperation extends LidarrAlbumMutationOperationV2,
  TEntry extends LidarrAlbumMutationPlanEntryV2,
  TSummary extends LidarrAlbumPlanOperationSummaryV2,
> {
  readonly version: typeof LIDARR_PLAN_VERSION_V2;
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: LidarrPlanCreatedBy;
  readonly command: "lidarr";
  readonly target: { readonly origin: string };
  readonly selection: LidarrAlbumPlanSelectionV2;
  readonly operation: TOperation;
  readonly maxBatch: number;
  readonly entries: readonly TEntry[];
  readonly review: LidarrPlanReviewSummary;
  readonly summary: TSummary;
  readonly risk: LidarrPlanRiskSummary;
  readonly payloadChecksum: string;
}

/**
 * Strict operation-discriminated album variant of {@link LidarrMutationPlanV2}.
 * Shares the exact `"rfmedia.lidarr-plan.v2"` version string with artist
 * plans; consumers dispatch on `plan.operation.kind`.
 */
export type LidarrAlbumMutationPlanV2 =
  | LidarrAlbumMutationPlanV2Base<
      LidarrAlbumEditOperationV2,
      LidarrAlbumEditPlanEntryV2,
      Extract<LidarrAlbumPlanOperationSummaryV2, { readonly kind: "album-edit" }>
    >
  | LidarrAlbumMutationPlanV2Base<
      LidarrAlbumDeleteOperationV2,
      LidarrAlbumDeletePlanEntryV2,
      Extract<LidarrAlbumPlanOperationSummaryV2, { readonly kind: "album-delete" }>
    >;

/** Strict single-album trackfile-filter plan sharing the v2 envelope. */
export interface LidarrTrackFileFilterPlanV2 {
  readonly version: typeof LIDARR_PLAN_VERSION_V2;
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: LidarrPlanCreatedBy;
  readonly command: "lidarr";
  readonly target: { readonly origin: string };
  readonly selection: LidarrTrackFilterPlanSelectionV2;
  readonly operation: LidarrTrackFileFilterOperationV2;
  readonly maxBatch: number;
  readonly entries: readonly [LidarrTrackFileFilterPlanEntryV2];
  readonly review: LidarrPlanReviewSummary;
  readonly summary: LidarrTrackFilterPlanSummaryV2;
  readonly risk: LidarrPlanRiskSummary;
  readonly payloadChecksum: string;
}

// ---------------------------------------------------------------------------
// Version 3 cascade-analysis families.
//
// V3 is additive: every v1/v2 declaration above remains unchanged. The
// distributive mapping preserves each source union's operation/entry/summary
// correlation while replacing only the envelope version and checksum seal.
// ---------------------------------------------------------------------------

/** Adds required cascade evidence to one exact legacy family without widening it. */
export type LidarrPlanV3From<TPlan extends { readonly version: string }> = TPlan extends unknown
  ? Omit<TPlan, "version" | "payloadChecksum"> & {
      readonly version: typeof LIDARR_PLAN_VERSION_V3;
      readonly cascadeAnalysis: LidarrCascadeAnalysis;
      readonly payloadChecksum: string;
    }
  : never;

/** Correlated legacy album-monitoring facts used only as the source of its v3 family. */
type LidarrAlbumMonitoringPlanFacts = Omit<LidarrMutationPlanV1, "operation" | "entries"> & {
  readonly operation: LidarrAlbumMonitoringOperation;
  readonly entries: readonly LidarrAlbumMonitoringPlanEntry[];
};

/** Strict v3 album-monitoring family migrated from the existing v1 producer. */
export type LidarrAlbumMonitoringPlanV3 = LidarrPlanV3From<LidarrAlbumMonitoringPlanFacts>;

/** Strict operation-correlated v3 ordinary artist plan families. */
export type LidarrMutationPlanV3 =
  | LidarrPlanV3From<LidarrMutationPlanV2>
  | LidarrAlbumMonitoringPlanV3;

/** Strict operation-correlated v3 expected-absent artist-add families. */
export type LidarrArtistAddPlanV3 = LidarrPlanV3From<LidarrArtistAddPlanV2>;

/** Strict operation-correlated v3 album edit/delete families. */
export type LidarrAlbumMutationPlanV3 = LidarrPlanV3From<LidarrAlbumMutationPlanV2>;

/**
 * V3-only track-filter evidence needed to recompute whether reviewed file
 * removal creates one possible monitored-album reacquisition candidate.
 */
export interface LidarrTrackFileFilterPlanEntryV3 extends Omit<
  LidarrTrackFileFilterPlanEntryV2,
  "before"
> {
  readonly before: {
    readonly albumMonitored: boolean;
    readonly deleteCandidates: readonly LidarrTrackFileDeleteCandidateV2[];
  };
}

type LidarrTrackFileFilterPlanFactsV3 = Omit<LidarrTrackFileFilterPlanV2, "entries"> & {
  readonly entries: readonly [LidarrTrackFileFilterPlanEntryV3];
};

/** Strict single-album v3 trackfile-filter family with sealed monitoring evidence. */
export type LidarrTrackFileFilterPlanV3 = LidarrPlanV3From<LidarrTrackFileFilterPlanFactsV3>;

/** Every correlated v3 plan family accepted by shared artifact consumers. */
export type LidarrPlanV3 =
  | LidarrMutationPlanV3
  | LidarrArtistAddPlanV3
  | LidarrAlbumMutationPlanV3
  | LidarrTrackFileFilterPlanV3;

export type LidarrPlanStalenessCode =
  | "artist-missing"
  | "artist-state-drift"
  | "album-missing"
  | "album-state-drift"
  | "resource-missing"
  | "resource-renamed";

export interface LidarrArtistPlanStalenessFinding {
  readonly code: LidarrPlanStalenessCode;
  readonly entryId: string;
  readonly artistId: number;
  readonly message: string;
}

export interface LidarrAlbumPlanStalenessFinding {
  readonly code: LidarrPlanStalenessCode;
  readonly entryId: string;
  readonly albumId: number;
  readonly message: string;
}

export type LidarrPlanStalenessFinding =
  | LidarrArtistPlanStalenessFinding
  | LidarrAlbumPlanStalenessFinding;

/** Operation-specific live state observed during apply. */
export type LidarrPlanObservedState =
  | {
      readonly kind: "artist-monitoring";
      readonly monitored: boolean;
    }
  | ({
      readonly kind: "artist-profile-assignment";
    } & LidarrArtistProfilePlanState)
  | {
      readonly kind: "artist-tag-mutation";
      readonly tags: readonly LidarrPlanTagReference[];
    }
  | LidarrArtistDeleteObservedState;

/** Typed targeted existence state used to classify and verify artist deletion. */
export type LidarrArtistDeleteObservedState =
  | {
      readonly kind: "artist-delete";
      readonly exists: true;
      readonly evidence: LidarrArtistDeleteEvidence;
    }
  | {
      readonly kind: "artist-delete";
      readonly exists: false;
    };

/** Operation-specific live album state observed during apply. */
export type LidarrAlbumPlanObservedState =
  | {
      readonly kind: "album-edit";
      readonly anyReleaseOk: boolean;
    }
  | {
      readonly kind: "album-delete";
      readonly present: boolean;
    };

/** Artist and album observed states combined for shared apply consumers. */
export type LidarrPlanObservedStateExtended =
  | LidarrPlanObservedState
  | LidarrAlbumPlanObservedState;

/** Terminal history outcomes that may also be exposed as apply-entry results. */
export type LidarrPlanTerminalHistoryOutcome =
  | "succeeded"
  | "satisfied"
  | "failed"
  | "deferred"
  | "uncertain";

/** Durable history lifecycle, including the pre-dispatch deletion boundary. */
export type LidarrPlanHistoryOutcome =
  | LidarrPlanTerminalHistoryOutcome
  | "possibly-dispatched"
  | "creation-verified-normalization-pending"
  | "normalization-verification-pending";

export interface LidarrArtistPlanHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly artistId: number;
  readonly recordedAt: string;
  readonly outcome: LidarrPlanTerminalHistoryOutcome;
  readonly errorCode?: string;
  readonly message?: string;
}

/** Structural superset of the artist record so union `artistId` reads stay valid. */
export interface LidarrAlbumPlanHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly albumId: number;
  readonly artistId: number;
  readonly recordedAt: string;
  readonly outcome: LidarrPlanTerminalHistoryOutcome;
  readonly errorCode?: string;
  readonly message?: string;
}

/**
 * Durable evidence written while the claim is owned, before a deletion request
 * can reach Lidarr. It never represents a terminal apply outcome.
 */
export interface LidarrArtistDeletePossibleDispatchHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly artistId: number;
  readonly recordedAt: string;
  readonly outcome: "possibly-dispatched";
  readonly idempotencyKey: string;
}

/** Terminal history for an artist-add target without a fabricated Lidarr ID. */
export interface LidarrArtistAddPlanHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly foreignArtistId: string;
  readonly recordedAt: string;
  readonly outcome: LidarrPlanTerminalHistoryOutcome;
  readonly errorCode?: string;
  readonly message?: string;
}

/** Durable pre-dispatch evidence for a non-idempotent artist creation. */
export interface LidarrArtistAddPossibleDispatchHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly foreignArtistId: string;
  /** Validated create-response identity when the POST returned successfully. */
  readonly lidarrId?: number;
  readonly recordedAt: string;
  readonly outcome: "possibly-dispatched";
  readonly idempotencyKey: string;
}

/** Artist creation is verified; the sealed album normalization remains pending. */
export interface LidarrArtistAddNormalizationPendingHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly foreignArtistId: string;
  readonly lidarrId: number;
  readonly recordedAt: string;
  readonly outcome: "creation-verified-normalization-pending";
  readonly idempotencyKey: string;
}

/** Album monitoring was dispatched and the exact targets require fresh verification. */
export interface LidarrArtistAddNormalizationVerificationPendingHistoryRecord {
  readonly planId: string;
  readonly planChecksum: string;
  readonly entryId: string;
  readonly foreignArtistId: string;
  readonly lidarrId: number;
  readonly recordedAt: string;
  readonly outcome: "normalization-verification-pending";
  readonly albumIds: readonly number[];
  readonly idempotencyKey: string;
}

export type LidarrPlanHistoryRecord =
  | LidarrArtistPlanHistoryRecord
  | LidarrAlbumPlanHistoryRecord
  | LidarrArtistDeletePossibleDispatchHistoryRecord
  | LidarrArtistAddPlanHistoryRecord
  | LidarrArtistAddPossibleDispatchHistoryRecord
  | LidarrArtistAddNormalizationPendingHistoryRecord
  | LidarrArtistAddNormalizationVerificationPendingHistoryRecord;

/** Stable lifecycle stage at which one apply entry stopped making progress. */
export type LidarrPlanApplyFailureStage =
  | "preflight"
  | "admission"
  | "dispatch"
  | "verification"
  | "history"
  | "resume";

/** Whether the one-artist editor request may have reached Lidarr. */
export type LidarrPlanApplyDispatchState = "not-dispatched" | "dispatched" | "dispatch-unknown";

/** Whether a fresh targeted read established the managed postcondition. */
export type LidarrPlanApplyVerificationState =
  | "not-started"
  | "verified"
  | "failed"
  | "inconclusive";

/** Credential-free recovery guidance for a structured apply-entry failure. */
export type LidarrPlanApplySafeNextAction =
  | "resume-plan"
  | "review-failure-and-resume"
  | "review-staleness-and-replan";

/** Allowlisted machine code emitted by one apply-entry failure. */
export type LidarrPlanApplyFailureCode =
  | "admission-stopped"
  | "artist-missing"
  | "artist-state-drift"
  | "resource-missing"
  | "resource-renamed"
  | "plan-stale"
  | "target-read-failed"
  | "history-write-failed"
  | "possible-dispatch-pending"
  | "verification-failed"
  | "verification-inconclusive"
  | "post-dispatch-cancelled"
  | "deferred-replay-failed"
  | "deferred-not-due"
  | "lidarr-unreachable"
  | "metadata-provider-unavailable"
  | "rate-limited"
  | "validation"
  | "authentication"
  | "authorization"
  | "not-found"
  | "invalid-response"
  | "timeout"
  | "configuration";

/**
 * Stable, credential-free failure evidence for machine consumers.
 *
 * This is optional on the entry result so existing v1 consumers retain their
 * exact success shape while all new failure paths can expose the lifecycle
 * decision without parsing a human message.
 */
export interface LidarrPlanApplyFailure {
  readonly code: LidarrPlanApplyFailureCode;
  readonly stage: LidarrPlanApplyFailureStage;
  readonly operation: LidarrMutationOperationV2Extended["kind"];
  readonly planId: string;
  readonly planChecksum: string;
  readonly targetIds: readonly number[];
  readonly dispatchState: LidarrPlanApplyDispatchState;
  readonly verificationState: LidarrPlanApplyVerificationState;
  readonly retryable: boolean;
  readonly safeNextAction: LidarrPlanApplySafeNextAction;
}

/** Foreign-ID failure evidence for artist creation; never contains a fake numeric ID. */
export interface LidarrArtistAddPlanApplyFailure extends Omit<
  LidarrPlanApplyFailure,
  "operation" | "targetIds"
> {
  readonly operation: "artist-add";
  readonly targetForeignArtistIds: readonly string[];
}

export type LidarrPlanApplyOutcome =
  | LidarrPlanTerminalHistoryOutcome
  | "skipped-resume"
  | "would-apply"
  | "blocked-stale"
  | "not-attempted";

export interface LidarrArtistPlanApplyEntryResult {
  readonly entryId: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly outcome: LidarrPlanApplyOutcome;
  readonly errorCode?: string;
  readonly message?: string;
  readonly before?: LidarrPlanObservedState;
  readonly after?: LidarrPlanObservedState;
  readonly observed?: LidarrPlanObservedState;
  readonly failure?: LidarrPlanApplyFailure;
}

/** Structural superset of the artist result so union `artistId` reads stay valid. */
export interface LidarrAlbumPlanApplyEntryResult {
  readonly entryId: string;
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly outcome: LidarrPlanApplyOutcome;
  readonly errorCode?: string;
  readonly message?: string;
  /** Additive-only: results are output-only, never artifact-validated. */
  readonly failure?: LidarrPlanApplyFailure;
}

interface LidarrArtistAddPlanApplyEntryResultBase {
  readonly entryId: string;
  readonly foreignArtistId: string;
  readonly artistName: string;
  readonly outcome: LidarrPlanApplyOutcome;
  readonly lidarrId?: number;
  readonly errorCode?: string;
  readonly message?: string;
  readonly failure?: LidarrArtistAddPlanApplyFailure;
}

/** Stable composite-apply stage reported for extended artist-add entries. */
export type LidarrArtistAddPlanApplyStage =
  | "create-pending"
  | "creation-verified-normalization-pending"
  | "normalization-verification-pending"
  | "completed";

/** Legacy artist-add result retained for existing machine consumers. */
export type LidarrArtistAddLegacyPlanApplyEntryResult = LidarrArtistAddPlanApplyEntryResultBase;

/** Extended artist-add result exposing the composite entry's current stage. */
export interface LidarrArtistAddExtendedPlanApplyEntryResult extends LidarrArtistAddPlanApplyEntryResultBase {
  readonly stage: LidarrArtistAddPlanApplyStage;
}

/** Apply result for an artist-add target, with an optional extended stage shape. */
export type LidarrArtistAddPlanApplyEntryResult =
  | LidarrArtistAddLegacyPlanApplyEntryResult
  | LidarrArtistAddExtendedPlanApplyEntryResult;

export type LidarrPlanApplyEntryResult =
  | LidarrArtistPlanApplyEntryResult
  | LidarrAlbumPlanApplyEntryResult
  | LidarrArtistAddPlanApplyEntryResult;

export interface LidarrPlanApplySummary {
  readonly total: number;
  readonly succeeded: number;
  readonly satisfied: number;
  readonly failed: number;
  readonly deferred: number;
  readonly uncertain: number;
  readonly blockedStale: number;
  readonly notAttempted: number;
  readonly skippedResume: number;
  readonly wouldApply: number;
}

export type LidarrPlanApplyStatus = "checked" | "completed" | "partial" | "failed";

/** Invocation-scoped destructive authority; never persisted in plan or history. */
export interface LidarrArtistDeleteAuthorization {
  readonly allowArtistDelete: boolean;
  readonly allowFileDelete: boolean;
}

/** Best-effort apply-time scan result, isolated from deletion outcomes. */
export interface LidarrApplyScanResult {
  readonly requested: boolean;
  readonly attempted: boolean;
  readonly status: "not-requested" | "skipped" | "succeeded" | "failed" | "unavailable";
  readonly message?: string;
}

export interface LidarrPlanApplyResult {
  readonly planId: string;
  readonly planChecksum: string;
  readonly planPath: string;
  readonly status: LidarrPlanApplyStatus;
  readonly dryRun: boolean;
  readonly resumed: boolean;
  readonly risk: LidarrPlanRiskSummary;
  readonly summary: LidarrPlanApplySummary;
  readonly entries: readonly LidarrPlanApplyEntryResult[];
  readonly cascadeAnalysis: LidarrCascadeAnalysisEvidence;
  readonly execution?: LidarrExecutionMetadata;
  readonly scan?: LidarrApplyScanResult;
}

export interface LidarrPlanGenerationResult {
  readonly planPath: string;
  readonly plan: LidarrMutationPlanV1;
}

/** Result returned by a producer that writes a strict v2 plan. */
export interface LidarrPlanGenerationResultV2 {
  readonly planPath: string;
  readonly plan: LidarrMutationPlanV2;
}

/** Result returned by a producer that writes a strict v3 plan family. */
export interface LidarrPlanGenerationResultV3<TPlan extends LidarrPlanV3 = LidarrMutationPlanV3> {
  readonly planPath: string;
  readonly plan: TPlan;
}

/** Result returned by the single-entry foreign-ID artist-add producer. */
export interface LidarrArtistAddPlanGenerationResult {
  readonly planPath: string;
  readonly plan: LidarrArtistAddPlanV2;
}

/** Result returned by an artist-add producer after migration to v3. */
export type LidarrArtistAddPlanGenerationResultV3 =
  LidarrPlanGenerationResultV3<LidarrArtistAddPlanV3>;
