/**
 * Composes the policy evaluator with the existing strict-v3 plan producers.
 *
 * This action acquires no scheduler slot of its own: evaluation and both
 * producers already own their `local-only` scheduling. Recommend mode is a
 * complete review with no artifact writes, while plan mode performs a global
 * projection preflight before sealing any producer output.
 */

import { PolicyPlanProjectionError, projectPolicyPlan } from "../../lib/bridge/policy-plan.js";
import { POLICY_PRODUCER_IDS } from "../../types/lidarr-policy.js";
import { POLICY_PLAN_SCHEMA } from "../../types/lidarr-policy-plan.js";
import { executeLidarrPlan } from "./plan.js";
import { executeLidarrArtistProfilePlan } from "./plan-artist-profiles.js";
import { executeLidarrPolicyEvaluate } from "./policy-evaluate.js";
import type { PolicyPlanProjection } from "../../lib/bridge/policy-plan.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { PolicyEvaluationReport, PolicyRuleId } from "../../types/lidarr-policy.js";
import type {
  LidarrPolicyPlanReport,
  PolicyPlanCohort,
  PolicyPlanMode,
  PolicyPlanOutcome,
  PolicyPlanRefusal,
  PolicyPlanSummary,
} from "../../types/lidarr-policy-plan.js";

/** Barrel-symmetry metadata; this composer schedules no work itself. */
export const TIER: LidarrTier = "local-only";

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
type EmptyReadonlyArray = readonly [];
type ProducerFailure = Extract<
  NonNullable<LidarrPolicyPlanReport["failure"]>,
  { readonly stage: "producer" }
>;

const EMPTY: EmptyReadonlyArray = Object.freeze([]);

/** Inputs for one policy review or artifact-sealing pass. */
export interface LidarrPolicyPlanActionOptions {
  readonly mode: PolicyPlanMode;
  readonly rules?: readonly PolicyRuleId[];
  readonly maxProposals?: number;
  readonly plexLibrary?: string;
  /** Runs after the single evaluation and before projection or producer dispatch. */
  readonly validateEvaluation?: (report: PolicyEvaluationReport) => void;
  /** Emitted immediately after an artifact is sealed and before the next producer runs. */
  readonly onPlanSealed?: (outcome: PolicyPlanOutcome) => void;
  /** Forwarded raw so the Plex cross-origin credential guard remains authoritative. */
  readonly plexUrl?: string;
  /** Forwarded raw so the Plex cross-origin credential guard remains authoritative. */
  readonly plexToken?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}

/** Action result. Rendering and exit-code ownership remain in the command layer. */
export interface LidarrPolicyPlanActionResult {
  readonly report: LidarrPolicyPlanReport;
  /** Metadata from the single evaluation pass; no wrapper slot is acquired. */
  readonly execution: LidarrExecutionSuccessMetadata;
}

/** Injectable I/O and projection seams used by focused orchestration tests. */
export interface LidarrPolicyPlanDependencies {
  readonly executeEvaluate: typeof executeLidarrPolicyEvaluate;
  readonly projectPlan: typeof projectPolicyPlan;
  readonly executeArtistProfilePlan: typeof executeLidarrArtistProfilePlan;
  readonly executeMonitoringPlan: typeof executeLidarrPlan;
}

const DEFAULT_DEPENDENCIES: LidarrPolicyPlanDependencies = Object.freeze({
  executeEvaluate: executeLidarrPolicyEvaluate,
  projectPlan: projectPolicyPlan,
  executeArtistProfilePlan: executeLidarrArtistProfilePlan,
  executeMonitoringPlan: executeLidarrPlan,
});

function asNonEmpty<T>(values: readonly T[]): NonEmptyReadonlyArray<T> {
  const first = values[0];
  if (first === undefined) {
    throw new TypeError("expected a non-empty policy-plan collection");
  }
  return Object.freeze([first, ...values.slice(1)]);
}

function summaryWithArtifacts(
  projection: PolicyPlanProjection,
  artifacts: number,
): PolicyPlanSummary {
  return Object.freeze({ ...projection.summary, artifacts });
}

function orderCohorts(cohorts: readonly PolicyPlanCohort[]): readonly PolicyPlanCohort[] {
  return Object.freeze(
    POLICY_PRODUCER_IDS.flatMap((producer) =>
      cohorts.filter((cohort) => cohort.producer === producer),
    ),
  );
}

function producerFailure(producer: PolicyPlanCohort["producer"]): ProducerFailure {
  return Object.freeze({
    stage: "producer",
    producer,
    detail: `${producer} plan producer failed`,
  });
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

function assertSafePlanRuleOutcomes(report: PolicyEvaluationReport): void {
  for (const rule of report.rules) {
    if (
      rule.status === "skipped" &&
      rule.skipReason !== "not-selected" &&
      rule.skipReason !== "disabled"
    ) {
      throw new PolicyPlanProjectionError(
        rule.id,
        `rule outcome ${rule.skipReason} blocks artifact planning`,
      );
    }
  }
}

async function sealCohort(
  cohort: PolicyPlanCohort,
  options: LidarrPolicyPlanActionOptions,
  dependencies: LidarrPolicyPlanDependencies,
): Promise<PolicyPlanOutcome> {
  const connection = {
    lidarrUrl: options.lidarrUrl,
    lidarrApiKey: options.lidarrApiKey,
  };
  const decisionKeys = asNonEmpty(cohort.changes.map((change) => change.decisionKey));
  const maxBatch = cohort.artistIds.length;

  switch (cohort.producer) {
    case "artist-profile-assignment": {
      const generated = await dependencies.executeArtistProfilePlan({
        artistIds: cohort.artistIds,
        qualityProfile: String(cohort.qualityProfileId),
        maxBatch,
        ...connection,
      });
      return Object.freeze({ producer: cohort.producer, decisionKeys, generated });
    }
    case "artist-monitoring": {
      const generated = await dependencies.executeMonitoringPlan({
        artistIds: cohort.artistIds,
        monitored: cohort.monitored,
        maxBatch,
        ...connection,
      });
      return Object.freeze({ producer: cohort.producer, decisionKeys, generated });
    }
  }
}

function noChangesReport(
  mode: PolicyPlanMode,
  evaluation: LidarrPolicyPlanReport["evaluation"],
  projection: PolicyPlanProjection,
): LidarrPolicyPlanReport {
  return Object.freeze({
    schema: POLICY_PLAN_SCHEMA,
    mode,
    status: "no-changes",
    evaluation,
    cohorts: EMPTY,
    refusals: EMPTY,
    outcomes: EMPTY,
    summary: summaryWithArtifacts(projection, 0),
  });
}

function reviewedReport(
  evaluation: LidarrPolicyPlanReport["evaluation"],
  projection: PolicyPlanProjection,
): LidarrPolicyPlanReport {
  const base = {
    schema: POLICY_PLAN_SCHEMA,
    mode: "recommend" as const,
    status: "reviewed" as const,
    evaluation,
    outcomes: EMPTY,
    summary: summaryWithArtifacts(projection, 0),
  };
  if (projection.cohorts.length > 0) {
    return Object.freeze({
      ...base,
      cohorts: asNonEmpty(projection.cohorts),
      refusals: projection.refusals,
    });
  }
  return Object.freeze({
    ...base,
    cohorts: EMPTY,
    refusals: asNonEmpty(projection.refusals),
  });
}

function refusedReport(
  evaluation: LidarrPolicyPlanReport["evaluation"],
  projection: PolicyPlanProjection,
): LidarrPolicyPlanReport {
  return Object.freeze({
    schema: POLICY_PLAN_SCHEMA,
    mode: "plan",
    status: "refused",
    evaluation,
    cohorts: projection.cohorts,
    refusals: asNonEmpty<PolicyPlanRefusal>(projection.refusals),
    outcomes: EMPTY,
    summary: summaryWithArtifacts(projection, 0),
  });
}

/**
 * Evaluates policy once, projects the complete report, and optionally seals
 * supported cohorts through the unchanged existing plan producers.
 *
 * Projection errors propagate unchanged so the command can render its normal
 * redacted failure envelope. Producer errors become typed reports with stable,
 * credential-free descriptors; cancellation throws only before any artifact
 * has been sealed.
 */
export async function executeLidarrPolicyPlan(
  options: LidarrPolicyPlanActionOptions,
  dependencies: LidarrPolicyPlanDependencies = DEFAULT_DEPENDENCIES,
): Promise<LidarrPolicyPlanActionResult> {
  options.signal?.throwIfAborted();
  const evaluation = await dependencies.executeEvaluate({
    rules: options.rules,
    maxProposals: options.maxProposals,
    plexLibrary: options.plexLibrary,
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
    lidarrUrl: options.lidarrUrl,
    lidarrApiKey: options.lidarrApiKey,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  options.validateEvaluation?.(evaluation.report);

  const projection = dependencies.projectPlan(evaluation.report);
  options.signal?.throwIfAborted();

  if (options.mode === "plan") {
    assertSafePlanRuleOutcomes(evaluation.report);
  }

  if (projection.cohorts.length === 0 && projection.refusals.length === 0) {
    return Object.freeze({
      report: noChangesReport(options.mode, evaluation.report, projection),
      execution: evaluation.execution,
    });
  }
  if (options.mode === "recommend") {
    return Object.freeze({
      report: reviewedReport(evaluation.report, projection),
      execution: evaluation.execution,
    });
  }
  if (projection.refusals.length > 0) {
    return Object.freeze({
      report: refusedReport(evaluation.report, projection),
      execution: evaluation.execution,
    });
  }

  const cohorts = asNonEmpty(orderCohorts(projection.cohorts));
  const outcomes: PolicyPlanOutcome[] = [];
  for (const cohort of cohorts) {
    let outcome: PolicyPlanOutcome;
    try {
      options.signal?.throwIfAborted();
      outcome = await sealCohort(cohort, options, dependencies);
    } catch (error) {
      if ((options.signal?.aborted === true || isAbortError(error)) && outcomes.length === 0) {
        throw options.signal?.reason ?? error;
      }
      const failure = producerFailure(cohort.producer);
      const summary = summaryWithArtifacts(projection, outcomes.length);
      const report: LidarrPolicyPlanReport =
        outcomes.length === 0
          ? Object.freeze({
              schema: POLICY_PLAN_SCHEMA,
              mode: "plan",
              status: "failed",
              evaluation: evaluation.report,
              cohorts,
              refusals: EMPTY,
              outcomes: EMPTY,
              failure,
              summary,
            })
          : Object.freeze({
              schema: POLICY_PLAN_SCHEMA,
              mode: "plan",
              status: "partial",
              evaluation: evaluation.report,
              cohorts,
              refusals: EMPTY,
              outcomes: asNonEmpty(outcomes),
              failure,
              summary,
            });
      return Object.freeze({ report, execution: evaluation.execution });
    }
    outcomes.push(outcome);
    options.onPlanSealed?.(outcome);
  }

  return Object.freeze({
    report: Object.freeze({
      schema: POLICY_PLAN_SCHEMA,
      mode: "plan",
      status: "sealed",
      evaluation: evaluation.report,
      cohorts,
      refusals: EMPTY,
      outcomes: asNonEmpty(outcomes),
      summary: summaryWithArtifacts(projection, outcomes.length),
    }),
    execution: evaluation.execution,
  });
}
