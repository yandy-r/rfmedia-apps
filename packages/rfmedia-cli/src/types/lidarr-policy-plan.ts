/**
 * The `rfmedia lidarr policy plan` contract (issue #311).
 *
 * ZERO VALUE IMPORTS. Every import in this module is type-only and erased at
 * compile time. The command imports the mode and option vocabularies statically,
 * so a value import here would pull the evaluator or plan-producer graph into
 * every CLI cold start.
 */

import type { LidarrMutationPlanV3, LidarrPlanGenerationResultV3 } from "./lidarr-plan.js";
import type {
  PolicyDecisionKey,
  PolicyEvaluationReport,
  PolicyProducerId,
  PolicyProposal,
  PolicyRuleId,
} from "./lidarr-policy.js";

type EmptyReadonlyArray = readonly [];
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/* ── Version and mode vocabulary ───────────────────────────────── */

export const POLICY_PLAN_SCHEMA = "rfmedia.lidarr-policy-plan.v1" as const;

/** The review-first safety ladder. Planning seals artifacts but never applies them. */
export const POLICY_PLAN_MODES = ["recommend", "plan"] as const;
export type PolicyPlanMode = (typeof POLICY_PLAN_MODES)[number];

/**
 * Narrows one raw `--mode` token without installing a throwing Commander parser.
 *
 * @param value - A raw `--mode` token.
 * @returns True when the token names a declared policy-plan mode.
 */
export function isPolicyPlanMode(value: string): value is PolicyPlanMode {
  return (POLICY_PLAN_MODES as readonly string[]).includes(value);
}

/* ── Projection ─────────────────────────────────────────── */

/** One proposal projected verbatim into a producer-ready cohort. */
export interface PolicyPlanChange {
  readonly decisionKey: PolicyDecisionKey;
  readonly ruleId: PolicyRuleId;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: PolicyProposal["before"];
  readonly after: PolicyProposal["after"];
  readonly checks: PolicyProposal["checks"];
  readonly summary: string;
}

/**
 * One homogeneous producer cohort.
 *
 * The producer discriminant keeps the numeric profile target and boolean
 * monitoring target non-nullable and impossible to confuse at call sites.
 */
export type PolicyPlanCohort =
  | {
      readonly producer: "artist-profile-assignment";
      readonly qualityProfileId: number;
      readonly artistIds: NonEmptyReadonlyArray<number>;
      readonly changes: NonEmptyReadonlyArray<PolicyPlanChange>;
    }
  | {
      readonly producer: "artist-monitoring";
      readonly monitored: boolean;
      readonly artistIds: NonEmptyReadonlyArray<number>;
      readonly changes: NonEmptyReadonlyArray<PolicyPlanChange>;
    };

/** Stable expected-refusal codes. Broken proposal invariants are failures, not refusals. */
export const POLICY_PLAN_REFUSAL_CODES = ["unsupported-producer", "conflicting-intent"] as const;
export type PolicyPlanRefusalCode = (typeof POLICY_PLAN_REFUSAL_CODES)[number];

interface PolicyPlanRefusalBase {
  readonly decisionKey: PolicyDecisionKey;
  readonly detail: string;
  readonly remedy: string | null;
}

/** One proposal withheld from every artifact, never silently omitted. */
export type PolicyPlanRefusal = PolicyPlanRefusalBase &
  (
    | {
        readonly code: "unsupported-producer";
        readonly producer: "discovery";
        readonly artistId: null;
      }
    | {
        readonly code: "conflicting-intent";
        readonly producer: PolicyProducerId;
        readonly artistId: number;
      }
  );

/* ── Artifact outcomes ───────────────────────────────────────── */

/** The unchanged strict-v3 profile-assignment plan family. */
export type PolicyPlanProfileArtifact = Extract<
  LidarrMutationPlanV3,
  {
    readonly operation: {
      readonly kind: "artist-profile-assignment";
    };
  }
>;

/** The unchanged strict-v3 artist-monitoring plan family. */
export type PolicyPlanMonitoringArtifact = Extract<
  LidarrMutationPlanV3,
  {
    readonly operation: {
      readonly kind: "artist-monitoring";
    };
  }
>;

/** The two unchanged strict-v3 plan families this command may seal. */
export type PolicyPlanArtifact = PolicyPlanProfileArtifact | PolicyPlanMonitoringArtifact;

/** One sealed artifact correlated to every proposal that contributed to it. */
export type PolicyPlanOutcome =
  | {
      readonly producer: "artist-profile-assignment";
      readonly decisionKeys: NonEmptyReadonlyArray<PolicyDecisionKey>;
      readonly generated: LidarrPlanGenerationResultV3<PolicyPlanProfileArtifact>;
    }
  | {
      readonly producer: "artist-monitoring";
      readonly decisionKeys: NonEmptyReadonlyArray<PolicyDecisionKey>;
      readonly generated: LidarrPlanGenerationResultV3<PolicyPlanMonitoringArtifact>;
    };

/* ── Versioned result ──────────────────────────────────────────── */

export const POLICY_PLAN_STATUSES = [
  "reviewed",
  "no-changes",
  "refused",
  "sealed",
  "partial",
  "failed",
] as const;
export type PolicyPlanStatus = (typeof POLICY_PLAN_STATUSES)[number];

/** Total proposal and artifact accounting for one run. */
export interface PolicyPlanSummary {
  readonly proposals: number;
  readonly projectable: number;
  readonly refused: number;
  readonly artifacts: number;
}

/** Structured failure evidence retained alongside the completed review. */
export type PolicyPlanFailure =
  | {
      readonly stage: "projection";
      readonly producer: null;
      readonly detail: string;
    }
  | {
      readonly stage: "producer";
      readonly producer: PolicyProducerId;
      readonly detail: string;
    };

interface LidarrPolicyPlanReportBase {
  readonly schema: typeof POLICY_PLAN_SCHEMA;
  /** The original, complete evaluator result; policy evidence never enters the v3 artifact. */
  readonly evaluation: PolicyEvaluationReport;
  readonly summary: PolicyPlanSummary;
}

type PolicyPlanReviewedState =
  | {
      readonly mode: "recommend";
      readonly status: "reviewed";
      readonly cohorts: NonEmptyReadonlyArray<PolicyPlanCohort>;
      readonly refusals: readonly PolicyPlanRefusal[];
      readonly outcomes: EmptyReadonlyArray;
      readonly failure?: never;
    }
  | {
      readonly mode: "recommend";
      readonly status: "reviewed";
      readonly cohorts: EmptyReadonlyArray;
      readonly refusals: NonEmptyReadonlyArray<PolicyPlanRefusal>;
      readonly outcomes: EmptyReadonlyArray;
      readonly failure?: never;
    };

/**
 * One complete policy-plan result.
 *
 * `partial` retains every completed outcome when a later producer fails.
 * `failed` represents a run with no completed artifact, while `refused` is an
 * expected plan-mode preflight result rather than an internal failure.
 */
export type LidarrPolicyPlanReport = LidarrPolicyPlanReportBase &
  (
    | PolicyPlanReviewedState
    | {
        readonly mode: PolicyPlanMode;
        readonly status: "no-changes";
        readonly cohorts: EmptyReadonlyArray;
        readonly refusals: EmptyReadonlyArray;
        readonly outcomes: EmptyReadonlyArray;
        readonly failure?: never;
      }
    | {
        readonly mode: "plan";
        readonly status: "refused";
        readonly cohorts: readonly PolicyPlanCohort[];
        readonly refusals: NonEmptyReadonlyArray<PolicyPlanRefusal>;
        readonly outcomes: EmptyReadonlyArray;
        readonly failure?: never;
      }
    | {
        readonly mode: "plan";
        readonly status: "sealed";
        readonly cohorts: NonEmptyReadonlyArray<PolicyPlanCohort>;
        readonly refusals: EmptyReadonlyArray;
        readonly outcomes: NonEmptyReadonlyArray<PolicyPlanOutcome>;
        readonly failure?: never;
      }
    | {
        readonly mode: "plan";
        readonly status: "partial";
        readonly cohorts: NonEmptyReadonlyArray<PolicyPlanCohort>;
        readonly refusals: EmptyReadonlyArray;
        readonly outcomes: NonEmptyReadonlyArray<PolicyPlanOutcome>;
        readonly failure: Extract<PolicyPlanFailure, { readonly stage: "producer" }>;
      }
    | {
        readonly mode: PolicyPlanMode;
        readonly status: "failed";
        readonly cohorts: EmptyReadonlyArray;
        readonly refusals: EmptyReadonlyArray;
        readonly outcomes: EmptyReadonlyArray;
        readonly failure: Extract<PolicyPlanFailure, { readonly stage: "projection" }>;
      }
    | {
        readonly mode: "plan";
        readonly status: "failed";
        readonly cohorts: NonEmptyReadonlyArray<PolicyPlanCohort>;
        readonly refusals: EmptyReadonlyArray;
        readonly outcomes: EmptyReadonlyArray;
        readonly failure: Extract<PolicyPlanFailure, { readonly stage: "producer" }>;
      }
  );

/* ── CLI option surface ───────────────────────────────────────────── */

/**
 * Every long option `rfmedia lidarr policy plan` declares, in Commander order.
 * Root machine-output options are inherited and deliberately absent here.
 */
export const LIDARR_POLICY_PLAN_OPTION_LONGS = [
  "--plex-library",
  "--rule",
  "--max-proposals",
  "--mode",
  "--explain",
  "--verbose",
  "--plex-url",
  "--plex-token",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;
