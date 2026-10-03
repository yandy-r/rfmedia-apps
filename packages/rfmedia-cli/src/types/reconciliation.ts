/**
 * Public contracts for three-plane metadata reconciliation.
 *
 * Reconciliation observes four metadata fields, but V1 requests mutation only
 * for ratings and database stat refreshes. Database stat maintenance is kept
 * separate from metadata fields and from the winner-selected rating strategy.
 */

/** Evidence sources that can participate in reconciliation. */
export type ReconciliationPlane = "file" | "database" | "server";

/** Metadata fields observed by the V1 reconciliation scan. */
export type ReconciliationField = "rating" | "artist" | "genre" | "year";

/** Closed observation states for one plane's field evidence. */
export type ReconciliationObservationState =
  | "present"
  | "missing"
  | "unavailable"
  | "invalid"
  /** @internal Reserved for pure-engine inputs; command acquisition fails before producing a result. */
  | "failed";

/**
 * One plane's evidence for a finding.
 *
 * Missing, unavailable, and failed observations never carry a value. Invalid
 * observations may retain a safe projected value for presentation.
 */
export type ReconciliationValue =
  | {
      readonly plane: ReconciliationPlane;
      readonly state: "present";
      readonly value: string | number;
    }
  | {
      readonly plane: ReconciliationPlane;
      readonly state: "missing" | "unavailable" | "failed";
      readonly value: null;
    }
  | {
      readonly plane: ReconciliationPlane;
      readonly state: "invalid";
      readonly value: string | number | null;
    };

/** Stable finding categories emitted by scan and post-apply verification. */
export type ReconciliationFindingCode =
  | "missing-value"
  | "missing-database-entry"
  | "missing-server-track"
  | "stale-database-entry"
  | "conflicting-value"
  | "ambiguous-database-entry"
  | "ambiguous-server-path"
  | "unsupported-target"
  /** @internal Reserved for pure-engine inputs; the CLI never emits this finding. */
  | "read-failed"
  | "in-sync";

/** A deterministic finding for one exact normalized destination path. */
export interface ReconciliationFinding {
  /** Root-contained normalized absolute path identifying the record. */
  readonly path: string;
  /** Metadata field, or null for a path-level identity/stat finding. */
  readonly field: ReconciliationField | null;
  /** Closed classification for the observed evidence. */
  readonly code: ReconciliationFindingCode;
  /** Plane evidence in deterministic plane order. */
  readonly evidence: readonly ReconciliationValue[];
  /** Inventory operation provenance retained for ambiguity reporting. */
  readonly operationIds: readonly number[];
  /** Server track provenance retained for ambiguity reporting. */
  readonly serverTrackIds: readonly string[];
  /** Whether V1 has a supported repair path for this finding. */
  readonly repairable: boolean;
}

/** Explicit rating authority selected by exactly one apply winner flag. */
export type ReconciliationStrategy = "file-wins" | "db-wins" | "server-wins";

/** Metadata fields requested for mutation by the V1 public contract. */
export type ReconciliationRequestedFields = readonly ["rating"];

/** Requested mutation operations represented by the V1 public contract. */
export type ReconciliationRequestedOperations = readonly ["rating", "database-stat-refresh"];

/** One requested mutation operation. */
export type ReconciliationRequestedOperation = ReconciliationRequestedOperations[number];

/** Closed lifecycle states for a rating target. */
export type RatingTargetOutcomeStatus =
  | "planned"
  | "applied"
  | "skipped"
  | "unsupported"
  | "failed";

interface RatingTargetOutcomeBase {
  readonly kind: "rating";
  readonly path: string;
  readonly target: ReconciliationPlane;
  readonly before: number | null;
  readonly intended: number;
}

/**
 * Planned or executed result for one losing rating plane.
 *
 * The status/code pairing is discriminated so callers can exhaustively handle
 * every public outcome without interpreting free-form strings.
 */
export type RatingTargetOutcome =
  | (RatingTargetOutcomeBase & {
      readonly status: "planned";
      readonly code: "planned";
    })
  | (RatingTargetOutcomeBase & {
      readonly status: "applied";
      readonly code: "applied";
    })
  | (RatingTargetOutcomeBase & {
      readonly status: "skipped";
      readonly code: "already-in-sync" | "not-attempted" | "cancelled" | "prior-target-failed";
    })
  | (RatingTargetOutcomeBase & {
      readonly status: "unsupported";
      readonly code: "unsupported-target";
    })
  | (RatingTargetOutcomeBase & {
      readonly status: "failed";
      readonly code: "read-failed" | "stale-evidence" | "write-failed" | "verification-failed";
    });

/** Closed reason codes for rating target outcomes. */
export type RatingTargetOutcomeCode = RatingTargetOutcome["code"];

/** Integer-millisecond mtime and byte size used for inventory freshness. */
export interface ReconciliationFileStat {
  readonly mtime: number;
  readonly size: number;
}

/** Closed lifecycle states for a database stat-refresh target. */
export type DatabaseStatOutcomeStatus = "planned" | "applied" | "skipped" | "failed";

interface DatabaseStatOutcomeBase {
  readonly kind: "database-stat";
  readonly path: string;
  readonly target: "database";
  readonly inventoryRowId: number;
  readonly before: ReconciliationFileStat;
  readonly intended: ReconciliationFileStat;
}

/**
 * Planned or executed refresh of one uniquely selected inventory row's stat
 * evidence. This is intentionally not a ReconciliationField.
 */
export type DatabaseStatOutcome =
  | (DatabaseStatOutcomeBase & {
      readonly status: "planned";
      readonly code: "planned";
    })
  | (DatabaseStatOutcomeBase & {
      readonly status: "applied";
      readonly code: "applied";
    })
  | (DatabaseStatOutcomeBase & {
      readonly status: "skipped";
      readonly code: "already-current" | "not-attempted" | "cancelled" | "prior-target-failed";
    })
  | (DatabaseStatOutcomeBase & {
      readonly status: "failed";
      readonly code:
        | "missing-destination"
        | "read-failed"
        | "stale-evidence"
        | "write-failed"
        | "verification-failed";
    });

/** Closed reason codes for database stat-refresh outcomes. */
export type DatabaseStatOutcomeCode = DatabaseStatOutcome["code"];

/** Any planned or executed V1 target outcome. */
export type ReconciliationTargetOutcome = RatingTargetOutcome | DatabaseStatOutcome;

/** Closed reasons that can block requested rating work before execution. */
export type RatingReconciliationBlockerCode =
  | "missing-authority"
  | "unavailable-authority"
  | "invalid-authority"
  | "ambiguous-database-entry"
  | "ambiguous-server-path"
  | "read-failed"
  | "unsupported-target"
  | "stale-evidence";

/** Closed reasons that can block a requested database stat refresh. */
export type DatabaseStatReconciliationBlockerCode =
  | "ambiguous-database-entry"
  | "missing-destination"
  | "read-failed"
  | "stale-evidence";

/** A known blocker in winner-selected rating work. */
export interface RatingReconciliationBlocker {
  readonly operation: "rating";
  readonly path: string;
  readonly field: "rating";
  /** Plane selected as the rating authority. */
  readonly authority: ReconciliationPlane;
  /** Target affected by the blocker, or null when the whole record is blocked. */
  readonly target: ReconciliationPlane | null;
  readonly code: RatingReconciliationBlockerCode;
}

/** A known blocker in filesystem-derived database stat maintenance. */
export interface DatabaseStatReconciliationBlocker {
  readonly operation: "database-stat-refresh";
  readonly path: string;
  readonly field: null;
  readonly target: "database";
  readonly inventoryRowId: number | null;
  readonly code: DatabaseStatReconciliationBlockerCode;
}

/** Any known blocker in the requested V1 rating/stat plan. */
export type ReconciliationBlocker = RatingReconciliationBlocker | DatabaseStatReconciliationBlocker;

/** Closed invocation-level failure reasons. */
export type ReconciliationFailureCode =
  | "validation-failed"
  | "file-acquisition-failed"
  | "database-acquisition-failed"
  | "server-acquisition-failed"
  | "read-failed"
  | "stale-evidence"
  | "write-failed"
  | "verification-failed"
  | "cancelled";

/** Aggregate counts for rating target outcomes. */
export interface ReconciliationRatingOutcomeCounts {
  readonly total: number;
  readonly planned: number;
  readonly applied: number;
  readonly skipped: number;
  readonly unsupported: number;
  readonly failed: number;
}

/** Aggregate counts for database stat-refresh outcomes. */
export interface ReconciliationDatabaseStatOutcomeCounts {
  readonly total: number;
  readonly planned: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Stable aggregate counts for a reconciliation result. */
export interface ReconciliationCounts {
  readonly paths: number;
  readonly findings: number;
  readonly inSync: number;
  readonly observedResiduals: number;
  readonly blockers: number;
  readonly ratingOutcomes: ReconciliationRatingOutcomeCounts;
  readonly databaseStatOutcomes: ReconciliationDatabaseStatOutcomeCounts;
}

/** Closed states for fresh post-apply verification. */
export type ReconciliationPostApplyStatus = "verified" | "incomplete" | "failed" | "cancelled";

interface ReconciliationPostApplyBase {
  readonly checkedPaths: number;
  readonly requestedRatingDrift: number;
  readonly pendingDatabaseStatRefreshes: number;
  readonly findings: readonly ReconciliationFinding[];
  readonly blockers: readonly ReconciliationBlocker[];
}

/**
 * Fresh verification of touched records after an apply attempt.
 *
 * Only the verified arm proves that no requested rating drift or database stat
 * refresh remains. Non-rating findings may remain in its findings array.
 */
export type ReconciliationPostApply =
  | (ReconciliationPostApplyBase & {
      readonly status: "verified";
      readonly failureCodes: readonly [];
    })
  | (ReconciliationPostApplyBase & {
      readonly status: "incomplete";
      readonly failureCodes: readonly ReconciliationFailureCode[];
    })
  | (ReconciliationPostApplyBase & {
      readonly status: "failed";
      readonly failureCodes: readonly ReconciliationFailureCode[];
    })
  | (ReconciliationPostApplyBase & {
      readonly status: "cancelled";
      readonly failureCodes: readonly ["cancelled"];
    });

/** Closed aggregate status for scan, preview, and executed apply. */
export type ReconciliationStatus =
  | "scanned"
  | "preview"
  | "declined"
  | "blocked"
  | "applied"
  | "partial"
  | "failed"
  | "cancelled";

/** Command mode represented by a reconciliation result. */
export type ReconciliationMode = "scan" | "apply";

/** Stable schema identifier for the public V1 result. */
export type ReconciliationSchema = "rfmedia.reconcile.v1";

/**
 * Versioned machine and action result for metadata reconciliation.
 *
 * Scan drift and a computed preview are successful report data. An executed
 * apply is successful only after every requested rating/stat operation is
 * freshly verified.
 */
export interface ReconciliationResult {
  readonly schema: ReconciliationSchema;
  readonly status: ReconciliationStatus;
  readonly success: boolean;
  readonly exitCode: 0 | 1 | 130 | 143;
  readonly mode: ReconciliationMode;
  readonly strategy: ReconciliationStrategy | null;
  readonly sourceRoot: string;
  readonly library: string;
  readonly databasePath: string;
  readonly operationId: number | null;
  readonly requestedFields: ReconciliationRequestedFields;
  readonly requestedOperations: ReconciliationRequestedOperations;
  readonly executed: boolean;
  readonly executable: boolean;
  readonly allowPartial: boolean;
  readonly counts: ReconciliationCounts;
  readonly findings: readonly ReconciliationFinding[];
  readonly observedResiduals: readonly ReconciliationFinding[];
  readonly blockers: readonly ReconciliationBlocker[];
  readonly failureCodes: readonly ReconciliationFailureCode[];
  readonly outcomes: readonly ReconciliationTargetOutcome[];
  readonly postApply: ReconciliationPostApply | null;
}

/** Explicitly named alias for consumers that pin the V1 result contract. */
export type ReconciliationResultV1 = ReconciliationResult;
