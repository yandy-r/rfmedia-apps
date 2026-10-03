import {
  reduceReconciliationStatus,
  type ReconciliationEnginePlan,
  type ReconciliationEngineReport,
} from "../../lib/reconciliation.js";
import type {
  DatabaseStatOutcome,
  RatingTargetOutcome,
  ReconciliationCounts,
  ReconciliationFailureCode,
  ReconciliationPostApply,
  ReconciliationResult,
  ReconciliationTargetOutcome,
} from "../../types/reconciliation.js";
import type { ReconciliationAcquisition } from "./acquisition.js";
import type { ReconciliationActionOptions } from "./contracts.js";

function ratingOutcomeCounts(
  outcomes: readonly ReconciliationTargetOutcome[],
): ReconciliationCounts["ratingOutcomes"] {
  const ratings = outcomes.filter(
    (outcome): outcome is RatingTargetOutcome => outcome.kind === "rating",
  );
  return {
    total: ratings.length,
    planned: ratings.filter((outcome) => outcome.status === "planned").length,
    applied: ratings.filter((outcome) => outcome.status === "applied").length,
    skipped: ratings.filter((outcome) => outcome.status === "skipped").length,
    unsupported: ratings.filter((outcome) => outcome.status === "unsupported").length,
    failed: ratings.filter((outcome) => outcome.status === "failed").length,
  };
}

function databaseStatOutcomeCounts(
  outcomes: readonly ReconciliationTargetOutcome[],
): ReconciliationCounts["databaseStatOutcomes"] {
  const stats = outcomes.filter(
    (outcome): outcome is DatabaseStatOutcome => outcome.kind === "database-stat",
  );
  return {
    total: stats.length,
    planned: stats.filter((outcome) => outcome.status === "planned").length,
    applied: stats.filter((outcome) => outcome.status === "applied").length,
    skipped: stats.filter((outcome) => outcome.status === "skipped").length,
    failed: stats.filter((outcome) => outcome.status === "failed").length,
  };
}

function buildCounts(
  report: ReconciliationEngineReport,
  blockers: ReconciliationEnginePlan["blockers"],
  outcomes: readonly ReconciliationTargetOutcome[],
): ReconciliationCounts {
  return {
    paths: report.records.length,
    findings: report.findings.length,
    inSync: report.findings.filter((finding) => finding.code === "in-sync").length,
    observedResiduals: report.observedResiduals.length,
    blockers: blockers.length,
    ratingOutcomes: ratingOutcomeCounts(outcomes),
    databaseStatOutcomes: databaseStatOutcomeCounts(outcomes),
  };
}

interface ResultFacts {
  readonly acquisition: ReconciliationAcquisition;
  readonly options: ReconciliationActionOptions;
  readonly strategy: ReconciliationResult["strategy"];
  readonly executed: boolean;
  readonly executable: boolean;
  readonly allowPartial: boolean;
  readonly blockers?: ReconciliationEnginePlan["blockers"];
  readonly outcomes?: readonly ReconciliationTargetOutcome[];
  readonly failureCodes?: readonly ReconciliationFailureCode[];
  readonly postApply?: ReconciliationPostApply | null;
  readonly declined?: boolean;
}

export function buildReconciliationResult(facts: ResultFacts): ReconciliationResult {
  const blockers = facts.blockers ?? [];
  const outcomes = facts.outcomes ?? [];
  const failureCodes = facts.failureCodes ?? [];
  const postApply = facts.postApply ?? null;
  const aggregate = reduceReconciliationStatus({
    mode: facts.options.mode,
    executed: facts.executed,
    executable: facts.executable,
    declined: facts.declined,
    blockers,
    outcomes,
    failureCodes,
    postApply,
  });
  return {
    schema: "rfmedia.reconcile.v1",
    ...aggregate,
    mode: facts.options.mode,
    strategy: facts.strategy,
    sourceRoot: facts.acquisition.report.sourceRoot,
    library: facts.acquisition.library,
    databasePath: facts.acquisition.databasePath,
    operationId: facts.options.operationId ?? null,
    requestedFields: ["rating"],
    requestedOperations: ["rating", "database-stat-refresh"],
    executed: facts.executed,
    executable: facts.executable,
    allowPartial: facts.allowPartial,
    counts: buildCounts(facts.acquisition.report, blockers, outcomes),
    findings: facts.acquisition.report.findings,
    observedResiduals: facts.acquisition.report.observedResiduals,
    blockers,
    failureCodes,
    outcomes,
    postApply,
  };
}

export function reportSignature(acquisition: ReconciliationAcquisition): string {
  return JSON.stringify({
    serverContentVersion: acquisition.serverContentVersion,
    serverTrackIdentities: acquisition.serverTracks
      .map((track) => [track.id, track.filePath])
      .sort(),
    records: acquisition.report.records.map((record) => ({
      path: record.path,
      file: record.file,
      databaseRows: record.databaseRows,
      serverTracks: record.serverTracks,
      evidence: record.evidence,
      fingerprint: acquisition.fingerprints.get(record.path),
    })),
    scale: acquisition.report.serverNativeRatingScale,
    writable: acquisition.report.serverRatingWritable,
  });
}

export function planSignature(plan: ReconciliationEnginePlan): string {
  return JSON.stringify({
    strategy: plan.strategy,
    executable: plan.executable,
    blockers: plan.blockers,
    outcomes: plan.outcomes,
  });
}

export function stalePlanOutcomes(
  outcomes: readonly ReconciliationTargetOutcome[],
): ReconciliationTargetOutcome[] {
  let failed = false;
  return outcomes.map((outcome): ReconciliationTargetOutcome => {
    if (!failed) {
      failed = true;
      return outcome.kind === "rating"
        ? { ...outcome, status: "failed", code: "stale-evidence" }
        : { ...outcome, status: "failed", code: "stale-evidence" };
    }
    return { ...outcome, status: "skipped", code: "prior-target-failed" };
  });
}

export function makePostApply(
  report: ReconciliationEngineReport,
  plan: ReconciliationEnginePlan,
  touchedPaths: ReadonlySet<string>,
  failureCodes: readonly ReconciliationFailureCode[],
): ReconciliationPostApply {
  if (failureCodes.includes("cancelled")) {
    return {
      status: "cancelled",
      checkedPaths: touchedPaths.size,
      requestedRatingDrift: 0,
      pendingDatabaseStatRefreshes: 0,
      findings: [],
      blockers: [],
      failureCodes: ["cancelled"],
    };
  }

  const blockers = plan.blockers.filter((blocker) => touchedPaths.has(blocker.path));
  const requestedRatingDrift =
    plan.outcomes.filter((outcome) => touchedPaths.has(outcome.path) && outcome.kind === "rating")
      .length + blockers.filter((blocker) => blocker.operation === "rating").length;
  const pendingDatabaseStatRefreshes =
    plan.outcomes.filter(
      (outcome) => touchedPaths.has(outcome.path) && outcome.kind === "database-stat",
    ).length + blockers.filter((blocker) => blocker.operation === "database-stat-refresh").length;
  const unresolvedRatingPaths = new Set([
    ...plan.outcomes.filter((outcome) => outcome.kind === "rating").map((outcome) => outcome.path),
    ...blockers.filter((blocker) => blocker.operation === "rating").map((blocker) => blocker.path),
  ]);
  const findings = report.findings.filter(
    (finding) =>
      touchedPaths.has(finding.path) &&
      !(
        finding.field === "rating" &&
        finding.code === "conflicting-value" &&
        !unresolvedRatingPaths.has(finding.path)
      ),
  );
  const incomplete =
    requestedRatingDrift > 0 ||
    pendingDatabaseStatRefreshes > 0 ||
    blockers.length > 0 ||
    failureCodes.length > 0;

  return incomplete
    ? {
        status: "incomplete",
        checkedPaths: touchedPaths.size,
        requestedRatingDrift,
        pendingDatabaseStatRefreshes,
        findings,
        blockers,
        failureCodes,
      }
    : {
        status: "verified",
        checkedPaths: touchedPaths.size,
        requestedRatingDrift: 0,
        pendingDatabaseStatRefreshes: 0,
        findings,
        blockers,
        failureCodes: [],
      };
}

export function failedPostApply(
  failureCodes: readonly ReconciliationFailureCode[],
  touchedPaths: ReadonlySet<string>,
): ReconciliationPostApply {
  return {
    status: "failed",
    checkedPaths: touchedPaths.size,
    requestedRatingDrift: 0,
    pendingDatabaseStatRefreshes: 0,
    findings: [],
    blockers: [],
    failureCodes,
  };
}
