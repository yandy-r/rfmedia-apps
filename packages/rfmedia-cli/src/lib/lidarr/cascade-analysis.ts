/** Pure deterministic cascade analysis for canonical Lidarr plan facts. */

import { LidarrPlanValidationError } from "../errors.js";
import {
  LIDARR_CASCADE_MODEL_VERSION,
  type LidarrCascadeAnalysis,
  type LidarrCascadeBudgetAssessment,
  type LidarrCascadeMetric,
  type LidarrCascadeMetricUnit,
  type LidarrCascadePolicy,
  type LidarrCascadeRecommendationCode,
  type LidarrCascadeWarning,
} from "../../types/lidarr-plan.js";
import type { LidarrCascadeAnalysisConfigOptions } from "../../types/config.js";

const MAX_POLICY_VALUE = 1_000_000;

interface MonitoringEntryFacts {
  readonly before: { readonly monitored: boolean };
  readonly after: { readonly monitored: boolean };
}

interface ProfileEntryFacts {
  readonly before: {
    readonly qualityProfile?: { readonly id: number };
    readonly metadataProfile?: { readonly id: number };
  };
  readonly after: {
    readonly qualityProfile?: { readonly id: number };
    readonly metadataProfile?: { readonly id: number };
  };
}

interface TagEntryFacts {
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
}

interface ArtistDeleteEntryFacts {
  readonly before: {
    readonly albumCount: number;
    readonly trackFileCount: number;
    readonly sizeOnDisk: number;
  };
}

interface ArtistAddEntryFacts {
  readonly after: { readonly monitored: boolean };
}

interface AlbumEditEntryFacts {
  readonly before: { readonly anyReleaseOk: boolean };
  readonly after: { readonly anyReleaseOk: boolean };
}

interface AlbumDeleteEntryFacts {
  readonly before: {
    readonly trackFileCount: number;
    readonly sizeOnDisk: number;
  };
}

interface TrackFilterEntryFacts {
  readonly before: {
    readonly albumMonitored: boolean;
    readonly deleteCandidates: readonly { readonly size: number }[];
  };
}

/** Minimal canonical, credential-free facts consumed by the estimator. */
export type LidarrCascadePlanFacts =
  | {
      readonly operation: {
        readonly kind: "artist-monitoring";
        readonly desiredMonitored: boolean;
      };
      readonly entries: readonly MonitoringEntryFacts[];
    }
  | {
      readonly operation: {
        readonly kind: "album-monitoring";
        readonly desiredMonitored: boolean;
      };
      readonly entries: readonly MonitoringEntryFacts[];
    }
  | {
      readonly operation: { readonly kind: "artist-profile-assignment" };
      readonly entries: readonly ProfileEntryFacts[];
    }
  | {
      readonly operation: { readonly kind: "artist-tag-mutation" };
      readonly entries: readonly TagEntryFacts[];
    }
  | {
      readonly operation: {
        readonly kind: "artist-delete";
        readonly deleteFiles: boolean;
      };
      readonly entries: readonly ArtistDeleteEntryFacts[];
    }
  | {
      readonly operation: {
        readonly kind: "artist-add";
        readonly monitored: boolean;
        readonly searchForMissingAlbums: false;
      };
      readonly entries: readonly ArtistAddEntryFacts[];
    }
  | {
      readonly operation: { readonly kind: "album-edit" };
      readonly entries: readonly AlbumEditEntryFacts[];
    }
  | {
      readonly operation: {
        readonly kind: "album-delete";
        readonly deleteFiles: boolean;
      };
      readonly entries: readonly AlbumDeleteEntryFacts[];
    }
  | {
      readonly operation: { readonly kind: "track-file-filter" };
      readonly entries: readonly [TrackFilterEntryFacts];
    };

interface OperationImpact {
  readonly acquisitionCandidates: LidarrCascadeMetric;
  readonly newlyMonitored: LidarrCascadeMetric;
  readonly filesAffected: LidarrCascadeMetric;
  readonly bytesAffected: LidarrCascadeMetric;
}

function validationError(message: string): LidarrPlanValidationError {
  return new LidarrPlanValidationError(message);
}

function requirePolicyValue(value: number | undefined, path: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_POLICY_VALUE) {
    throw validationError(`${path} must be a positive safe integer no greater than 1000000`);
  }
  return value;
}

/** Resolves optional config into a deeply frozen policy with explicit nulls. */
export function resolveLidarrCascadePolicy(
  config: LidarrCascadeAnalysisConfigOptions | undefined,
): LidarrCascadePolicy {
  return Object.freeze({
    assumptions: Object.freeze({
      albumsPerArtist: requirePolicyValue(
        config?.assumptions?.albumsPerArtist,
        "lidarr.cascadeAnalysis.assumptions.albumsPerArtist",
      ),
      indexerQueriesPerCandidate: requirePolicyValue(
        config?.assumptions?.indexerQueriesPerCandidate,
        "lidarr.cascadeAnalysis.assumptions.indexerQueriesPerCandidate",
      ),
    }),
    budgets: Object.freeze({
      indexerQueries: requirePolicyValue(
        config?.budgets?.indexerQueries,
        "lidarr.cascadeAnalysis.budgets.indexerQueries",
      ),
      acquisitionCandidates: requirePolicyValue(
        config?.budgets?.acquisitionCandidates,
        "lidarr.cascadeAnalysis.budgets.acquisitionCandidates",
      ),
    }),
  });
}

/** Adds two non-negative safe integers or fails before artifact construction. */
export function checkedLidarrCascadeAdd(left: number, right: number): number {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    !Number.isSafeInteger(result)
  ) {
    throw validationError("cascade analysis arithmetic overflow");
  }
  return result;
}

/** Multiplies two non-negative safe integers or fails before artifact construction. */
export function checkedLidarrCascadeMultiply(left: number, right: number): number {
  const result = left * right;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    !Number.isSafeInteger(result)
  ) {
    throw validationError("cascade analysis arithmetic overflow");
  }
  return result;
}

function metric(
  value: number | null,
  certainty: LidarrCascadeMetric["certainty"],
  horizon: LidarrCascadeMetric["horizon"],
  unit: LidarrCascadeMetricUnit,
  basis: LidarrCascadeMetric["basis"],
): LidarrCascadeMetric {
  return Object.freeze({ value, certainty, horizon, unit, basis });
}

function exactZero(
  unit: LidarrCascadeMetricUnit,
  basis: LidarrCascadeMetric["basis"],
): LidarrCascadeMetric {
  return metric(0, "exact", "none", unit, basis);
}

function countNewlyMonitored(entries: readonly MonitoringEntryFacts[]): number {
  return entries.reduce(
    (count, entry) =>
      !entry.before.monitored && entry.after.monitored ? checkedLidarrCascadeAdd(count, 1) : count,
    0,
  );
}

function sumBy<T>(entries: readonly T[], select: (entry: T) => number): number {
  return entries.reduce((total, entry) => checkedLidarrCascadeAdd(total, select(entry)), 0);
}

function modelArtistCandidates(
  changedMonitoredArtists: number,
  policy: LidarrCascadePolicy,
): LidarrCascadeMetric {
  if (changedMonitoredArtists === 0) {
    return exactZero("acquisition-candidates", "changed-artist-monitoring");
  }
  if (policy.assumptions.albumsPerArtist === null) {
    return metric(
      null,
      "unknown",
      "conditional",
      "acquisition-candidates",
      "acquisition-candidates-unknown",
    );
  }
  return metric(
    checkedLidarrCascadeMultiply(changedMonitoredArtists, policy.assumptions.albumsPerArtist),
    "modelled",
    "conditional",
    "acquisition-candidates",
    "configured-albums-per-artist",
  );
}

function fileMetrics(
  count: number,
  bytes: number,
  basis: "track-file-delete-candidates" | "operation-removes-acquisition-scope",
): Pick<OperationImpact, "filesAffected" | "bytesAffected"> {
  return {
    filesAffected:
      count === 0
        ? exactZero("files", "no-file-impact")
        : metric(count, "exact", "immediate", "files", basis),
    bytesAffected:
      bytes === 0
        ? exactZero("bytes", "no-file-impact")
        : metric(bytes, "exact", "immediate", "bytes", "affected-file-bytes"),
  };
}

function noFileImpact(): Pick<OperationImpact, "filesAffected" | "bytesAffected"> {
  return {
    filesAffected: exactZero("files", "no-file-impact"),
    bytesAffected: exactZero("bytes", "no-file-impact"),
  };
}

function analyzeOperation(
  facts: LidarrCascadePlanFacts,
  policy: LidarrCascadePolicy,
): OperationImpact {
  const operationKind = facts.operation.kind;
  switch (operationKind) {
    case "artist-monitoring": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "artist-monitoring" } }
      >;
      const newlyMonitored = countNewlyMonitored(current.entries);
      return {
        acquisitionCandidates: current.operation.desiredMonitored
          ? modelArtistCandidates(newlyMonitored, policy)
          : exactZero("acquisition-candidates", "operation-removes-acquisition-scope"),
        newlyMonitored:
          newlyMonitored === 0
            ? exactZero("artists", "changed-artist-monitoring")
            : metric(newlyMonitored, "exact", "immediate", "artists", "changed-artist-monitoring"),
        ...noFileImpact(),
      };
    }
    case "album-monitoring": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "album-monitoring" } }
      >;
      const newlyMonitored = countNewlyMonitored(current.entries);
      return {
        acquisitionCandidates: current.operation.desiredMonitored
          ? newlyMonitored === 0
            ? exactZero("acquisition-candidates", "changed-album-monitoring")
            : metric(
                newlyMonitored,
                "exact",
                "conditional",
                "acquisition-candidates",
                "changed-album-monitoring",
              )
          : exactZero("acquisition-candidates", "operation-removes-acquisition-scope"),
        newlyMonitored:
          newlyMonitored === 0
            ? exactZero("albums", "changed-album-monitoring")
            : metric(newlyMonitored, "exact", "immediate", "albums", "changed-album-monitoring"),
        ...noFileImpact(),
      };
    }
    case "artist-profile-assignment": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "artist-profile-assignment" } }
      >;
      const changed = current.entries.some(
        (entry) =>
          entry.before.qualityProfile?.id !== entry.after.qualityProfile?.id ||
          entry.before.metadataProfile?.id !== entry.after.metadataProfile?.id,
      );
      return {
        acquisitionCandidates: changed
          ? metric(
              null,
              "unknown",
              "conditional",
              "acquisition-candidates",
              "release-automation-evidence-unavailable",
            )
          : exactZero("acquisition-candidates", "changed-entries"),
        newlyMonitored: exactZero("artists", "changed-entries"),
        ...noFileImpact(),
      };
    }
    case "artist-tag-mutation": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "artist-tag-mutation" } }
      >;
      const changed = current.entries.some(
        (entry) => entry.added.length > 0 || entry.removed.length > 0,
      );
      return {
        acquisitionCandidates: changed
          ? metric(
              null,
              "unknown",
              "conditional",
              "acquisition-candidates",
              "release-automation-evidence-unavailable",
            )
          : exactZero("acquisition-candidates", "changed-entries"),
        newlyMonitored: exactZero("artists", "changed-entries"),
        ...noFileImpact(),
      };
    }
    case "artist-delete": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "artist-delete" } }
      >;
      const files = current.operation.deleteFiles
        ? sumBy(current.entries, (entry) => entry.before.trackFileCount)
        : 0;
      const bytes = current.operation.deleteFiles
        ? sumBy(current.entries, (entry) => entry.before.sizeOnDisk)
        : 0;
      return {
        acquisitionCandidates: exactZero(
          "acquisition-candidates",
          "operation-removes-acquisition-scope",
        ),
        newlyMonitored: exactZero("artists", "operation-removes-acquisition-scope"),
        ...fileMetrics(files, bytes, "operation-removes-acquisition-scope"),
      };
    }
    case "artist-add": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "artist-add" } }
      >;
      const monitored = current.entries.reduce(
        (count, entry) => (entry.after.monitored ? checkedLidarrCascadeAdd(count, 1) : count),
        0,
      );
      return {
        acquisitionCandidates: current.operation.monitored
          ? modelArtistCandidates(monitored, policy)
          : exactZero("acquisition-candidates", "operation-removes-acquisition-scope"),
        newlyMonitored:
          monitored === 0
            ? exactZero("artists", "changed-entries")
            : metric(monitored, "exact", "immediate", "artists", "changed-entries"),
        ...noFileImpact(),
      };
    }
    case "album-edit": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "album-edit" } }
      >;
      const changed = current.entries.some(
        (entry) => entry.before.anyReleaseOk !== entry.after.anyReleaseOk,
      );
      return {
        acquisitionCandidates: changed
          ? metric(
              null,
              "unknown",
              "conditional",
              "acquisition-candidates",
              "release-automation-evidence-unavailable",
            )
          : exactZero("acquisition-candidates", "changed-entries"),
        newlyMonitored: exactZero("albums", "changed-entries"),
        ...noFileImpact(),
      };
    }
    case "album-delete": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "album-delete" } }
      >;
      const files = current.operation.deleteFiles
        ? sumBy(current.entries, (entry) => entry.before.trackFileCount)
        : 0;
      const bytes = current.operation.deleteFiles
        ? sumBy(current.entries, (entry) => entry.before.sizeOnDisk)
        : 0;
      return {
        acquisitionCandidates: exactZero(
          "acquisition-candidates",
          "operation-removes-acquisition-scope",
        ),
        newlyMonitored: exactZero("albums", "operation-removes-acquisition-scope"),
        ...fileMetrics(files, bytes, "operation-removes-acquisition-scope"),
      };
    }
    case "track-file-filter": {
      const current = facts as Extract<
        LidarrCascadePlanFacts,
        { readonly operation: { readonly kind: "track-file-filter" } }
      >;
      const entry = current.entries[0];
      const files = entry.before.deleteCandidates.length;
      const bytes = sumBy(entry.before.deleteCandidates, (candidate) => candidate.size);
      const exposed = files > 0 && entry.before.albumMonitored ? 1 : 0;
      return {
        acquisitionCandidates:
          exposed === 0
            ? exactZero(
                "acquisition-candidates",
                entry.before.albumMonitored
                  ? "monitored-album-file-removal"
                  : "unmonitored-album-file-removal",
              )
            : metric(
                1,
                "exact",
                "conditional",
                "acquisition-candidates",
                "monitored-album-file-removal",
              ),
        newlyMonitored: exactZero("albums", "changed-entries"),
        ...fileMetrics(files, bytes, "track-file-delete-candidates"),
      };
    }
    default: {
      const exhaustive: never = operationKind;
      throw validationError(`unsupported cascade operation: ${String(exhaustive)}`);
    }
  }
}

function conditionalIndexerQueries(
  candidates: LidarrCascadeMetric,
  policy: LidarrCascadePolicy,
): LidarrCascadeMetric {
  if (candidates.value === null) {
    return metric(
      null,
      "unknown",
      "conditional",
      "indexer-queries",
      "acquisition-candidates-unknown",
    );
  }
  if (candidates.value === 0) {
    return exactZero("indexer-queries", "acquisition-candidates-known-zero");
  }
  if (policy.assumptions.indexerQueriesPerCandidate === null) {
    return metric(
      null,
      "unknown",
      "conditional",
      "indexer-queries",
      "indexer-queries-per-candidate-not-configured",
    );
  }
  return metric(
    checkedLidarrCascadeMultiply(candidates.value, policy.assumptions.indexerQueriesPerCandidate),
    "modelled",
    "conditional",
    "indexer-queries",
    "configured-indexer-queries-per-candidate",
  );
}

function assessBudget(
  projected: number | null,
  limit: number | null,
): LidarrCascadeBudgetAssessment {
  if (limit === null) {
    return Object.freeze({
      status: "not-configured",
      limit: null,
      projected,
      provenance: "configured-per-plan",
    });
  }
  if (projected === null) {
    return Object.freeze({
      status: "unknown",
      limit,
      projected: null,
      provenance: "configured-per-plan",
    });
  }
  return Object.freeze({
    status: projected > limit ? "exceeded" : "within",
    limit,
    projected,
    provenance: "configured-per-plan",
  });
}

function warningFor(
  metricName: "indexerQueries" | "acquisitionCandidates",
  assessment: LidarrCascadeBudgetAssessment,
): LidarrCascadeWarning | undefined {
  if (assessment.status === "not-configured" || assessment.status === "within") {
    return undefined;
  }
  if (assessment.status === "unknown") {
    return Object.freeze({
      code: "budget-assessment-incomplete",
      metric: metricName,
      projected: null,
      limit: assessment.limit as number,
    });
  }
  const projected = assessment.projected as number;
  const limit = assessment.limit as number;
  return metricName === "indexerQueries"
    ? Object.freeze({
        code: "indexer-query-budget-exceeded",
        metric: "indexerQueries",
        projected,
        limit,
        overBy: projected - limit,
      })
    : Object.freeze({
        code: "acquisition-budget-exceeded",
        metric: "acquisitionCandidates",
        projected,
        limit,
        overBy: projected - limit,
      });
}

function recommendationsFor(
  warnings: readonly LidarrCascadeWarning[],
): readonly LidarrCascadeRecommendationCode[] {
  if (warnings.some((warning) => warning.code.endsWith("-budget-exceeded"))) {
    return Object.freeze(["reduce-scope", "split-into-batches", "delay-apply"]);
  }
  if (warnings.length > 0) {
    return Object.freeze(["reduce-scope"]);
  }
  return Object.freeze([]);
}

/** Derives a deeply frozen cascade analysis in one synchronous pass over entries. */
export function analyzeLidarrCascade(
  facts: LidarrCascadePlanFacts,
  policy: LidarrCascadePolicy,
): LidarrCascadeAnalysis {
  const impact = analyzeOperation(facts, policy);
  const conditionalQueries = conditionalIndexerQueries(impact.acquisitionCandidates, policy);
  const indexerBudget = assessBudget(conditionalQueries.value, policy.budgets.indexerQueries);
  const acquisitionBudget = assessBudget(
    impact.acquisitionCandidates.value,
    policy.budgets.acquisitionCandidates,
  );
  const warnings = [
    warningFor("indexerQueries", indexerBudget),
    warningFor("acquisitionCandidates", acquisitionBudget),
  ].filter((warning): warning is LidarrCascadeWarning => warning !== undefined);

  return Object.freeze({
    modelVersion: LIDARR_CASCADE_MODEL_VERSION,
    assumptions: Object.freeze({
      albumsPerArtist: policy.assumptions.albumsPerArtist,
      indexerQueriesPerCandidate: policy.assumptions.indexerQueriesPerCandidate,
    }),
    metrics: Object.freeze({
      immediateIndexerQueries: metric(
        0,
        "exact",
        "immediate",
        "indexer-queries",
        "current-operation-no-search",
      ),
      acquisitionCandidates: impact.acquisitionCandidates,
      conditionalIndexerQueries: conditionalQueries,
      newlyMonitored: impact.newlyMonitored,
      filesAffected: impact.filesAffected,
      bytesAffected: impact.bytesAffected,
    }),
    budgets: Object.freeze({
      indexerQueries: indexerBudget,
      acquisitionCandidates: acquisitionBudget,
    }),
    warnings: Object.freeze(warnings),
    recommendations: recommendationsFor(warnings),
  });
}
