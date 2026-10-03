/**
 * The `rfmedia lidarr sync-ratings` contract (issue #221).
 *
 * ZERO VALUE IMPORTS. Every `import` in this module carries the `type` keyword
 * and is erased at compile time; nothing here may import a value from
 * `../lib/**`, `../actions/**`, or any sibling type module.
 *
 * Why it is a hard rule: `src/commands/lidarr-sync-ratings.ts` imports this
 * module *statically* for the decision vocabulary
 * ({@link SYNC_RATINGS_DECISIONS}), the mode vocabulary
 * ({@link SYNC_RATINGS_MODES}), the numeric bounds, and the declared option-long
 * list ({@link LIDARR_SYNC_RATINGS_OPTION_LONGS}). A single value import here
 * would drag the evaluator graph — and through it the Plex adapter, the Lidarr
 * client, and the tracking database — into every cold start of the CLI.
 *
 * The command never invents its own decision surface: every decision resolves
 * through {@link SYNC_RATINGS_DECISION_BINDING} to a shipped policy rule and the
 * shipped producer that seals it, so this command and `lidarr policy evaluate`
 * cannot disagree about what a rating means.
 */

import type {
  LidarrMutationPlanV3,
  LidarrPlanApplyResult,
  LidarrPlanGenerationResultV3,
} from "./lidarr-plan.js";
import type {
  PolicyDecisionKey,
  PolicyEvaluationReport,
  PolicyProducerId,
  PolicyRuleId,
  PolicyRuleSkipReason,
  PolicyThresholdCheck,
} from "./lidarr-policy.js";

/* ── Version ─────────────────────────────────────────────────────────────── */

export const SYNC_RATINGS_SCHEMA = "rfmedia.lidarr-ratings-sync.v1" as const;

/* ── Decision vocabulary ─────────────────────────────────────────────────── */

/**
 * The two rating-driven decisions, named after the plan `operation.kind` they
 * seal into so the flag value and the artifact kind are the same word.
 *
 * `discovery-seed` is deliberately absent: its descriptor `producer` is `null`,
 * so it can never be sealed into a plan artifact.
 */
export const SYNC_RATINGS_DECISIONS = ["quality-profile", "monitoring"] as const;
export type SyncRatingsDecision = (typeof SYNC_RATINGS_DECISIONS)[number];

/**
 * Narrowing guard for `--decision` parsing inside the action handler.
 *
 * @param value - A raw `--decision` token.
 * @returns True when the token names a sealable decision.
 */
export function isSyncRatingsDecision(value: string): value is SyncRatingsDecision {
  return (SYNC_RATINGS_DECISIONS as readonly string[]).includes(value);
}

/* ── Mode vocabulary ─────────────────────────────────────────────────────── */

/**
 * The three rungs of the safety ladder, in ascending order of consequence.
 *
 * A single value-taking `--mode` rather than sibling boolean flags: `--apply` is
 * already a *file-valued* option elsewhere in this CLI (`copy --apply <plan>`),
 * and one flag name may not carry two incompatible types.
 */
export const SYNC_RATINGS_MODES = ["recommend", "plan", "apply"] as const;
export type LidarrSyncRatingsMode = (typeof SYNC_RATINGS_MODES)[number];

/**
 * Narrowing guard for `--mode` parsing inside the action handler.
 *
 * Commander's `.choices()` is deliberately not used: it installs a throwing
 * `argParser`, which exits the process before the failure envelope runs.
 *
 * @param value - A raw `--mode` token.
 * @returns True when the token names a declared mode.
 */
export function isSyncRatingsMode(value: string): value is LidarrSyncRatingsMode {
  return (SYNC_RATINGS_MODES as readonly string[]).includes(value);
}

/* ── Decision binding ────────────────────────────────────────────────────── */

/** One decision's route: the rule that computes it, the producer that seals it. */
export interface SyncRatingsDecisionBinding {
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
}

/**
 * Decision → shipped rule → shipped producer.
 *
 * `satisfies` makes an unbound decision a compile error, and the `producer` type
 * excludes `null`, so a rule that cannot be sealed can never be bound here.
 */
export const SYNC_RATINGS_DECISION_BINDING = Object.freeze({
  "quality-profile": {
    ruleId: "rating-quality-upgrade",
    producer: "artist-profile-assignment",
  },
  monitoring: {
    ruleId: "stale-monitoring-cleanup",
    producer: "artist-monitoring",
  },
} satisfies Readonly<Record<SyncRatingsDecision, SyncRatingsDecisionBinding>>);

/* ── Refusals ────────────────────────────────────────────────────────────── */

/** Stable kebab refusal codes — a public contract; CI may grep these. */
export const SYNC_RATINGS_REFUSAL_CODES = [
  "decision-disabled",
  "rule-not-evaluated",
  "cross-decision-conflict",
] as const;
export type SyncRatingsRefusalCode = (typeof SYNC_RATINGS_REFUSAL_CODES)[number];

/**
 * One withheld change. Refusals are DATA, never omissions.
 *
 * A cohort silently missing an artist is indistinguishable from a bug; a refusal
 * names the cause and the exact key or flag that clears it.
 */
export interface SyncRatingsRefusal {
  readonly code: SyncRatingsRefusalCode;
  /** `decision` blocks one cohort; `artist` withholds one subject. */
  readonly scope: "decision" | "artist";
  /** The decision blocked, or `null` for an artist withheld from BOTH. */
  readonly decision: SyncRatingsDecision | null;
  /** Present only for `scope: "artist"`. Id keys stay SINGULAR by contract. */
  readonly artistId: number | null;
  /** The blocking rule's own `skipReason`, when the cause was a rule skip. */
  readonly ruleSkipReason: PolicyRuleSkipReason | null;
  readonly detail: string;
  /** The exact `.rfmedia.yaml` key or CLI flag that resolves it, or null. */
  readonly remedy: string | null;
}

/* ── Cohorts ─────────────────────────────────────────────────────────────── */

/**
 * One artist-level change, projected VERBATIM off a frozen `PolicyProposal`.
 *
 * `before` and `after` carry the proposal's own maps unchanged, so they keep the
 * proposal's string index signature: read them with bracket access and narrow
 * with `typeof`, never with dot access.
 */
export interface SyncRatingsChange {
  /** The proposal's stable, non-rotating key; `--explain` accepts it. */
  readonly decisionKey: PolicyDecisionKey;
  readonly artistId: number;
  readonly artistName: string;
  readonly plexId: string;
  readonly artistMbid: string | null;
  readonly before: Readonly<Record<string, string | number | boolean | null>>;
  readonly after: Readonly<Record<string, string | number | boolean | null>>;
  readonly checks: readonly PolicyThresholdCheck[];
  readonly summary: string;
}

/** One producer cohort. `changes` is empty unless `gate === "sealable"`. */
export interface SyncRatingsCohort {
  readonly decision: SyncRatingsDecision;
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
  readonly gate: "sealable" | "refused" | "no-changes";
  /** The single sealed target profile id; `null` for a monitoring cohort. */
  readonly resolvedProfileId: number | null;
  /** Display-only target name; the producer binds by id, never by this. */
  readonly qualityProfileName: string | null;
  /** Desired monitored state; `null` for a profile cohort. */
  readonly desiredMonitored: boolean | null;
  readonly changes: readonly SyncRatingsChange[];
  /** Ascending, deduplicated. Empty unless `gate === "sealable"`. */
  readonly artistIds: readonly number[];
}

/* ── Thresholds ──────────────────────────────────────────────────────────── */

export type SyncRatingsThresholdSource = "flag" | "config" | "default";

export interface SyncRatingsThreshold<T> {
  readonly value: T;
  readonly source: SyncRatingsThresholdSource;
  /** Dotted `.rfmedia.yaml` key, or null when the knob is flag-only. */
  readonly configPath: string | null;
}

/**
 * Honest per-field provenance.
 *
 * `PolicyThresholdCheck.configPath` on a proposal always cites the
 * `.rfmedia.yaml` key even when the effective bound arrived from a flag, so a
 * reviewer needs this block to tell a persistent policy from a one-off
 * experiment.
 */
export interface SyncRatingsResolvedThresholds {
  readonly minStars: SyncRatingsThreshold<number>;
  readonly maxPlays: SyncRatingsThreshold<number>;
  readonly qualityProfile: SyncRatingsThreshold<string | null>;
  readonly maxProposals: SyncRatingsThreshold<number>;
}

/* ── Result ──────────────────────────────────────────────────────────────── */

/**
 * The only two v3 plan shapes sync-ratings can seal.
 *
 * A subset of `LidarrMutationPlanV3`, so a
 * `LidarrPlanGenerationResultV3<LidarrSyncRatingsPlan>` stays assignable to what
 * the shipped mutation presenter accepts — nothing is added to the presenter's
 * closed union for this feature.
 */
export type LidarrSyncRatingsPlan = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" | "artist-profile-assignment" } }
>;

/** One sealed artifact and, in apply mode, its outcome. */
export interface LidarrSyncRatingsOutcome {
  readonly decision: SyncRatingsDecision;
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
  /** `{ planPath, plan }` exactly as `renderMutationPlan` consumes it. */
  readonly generated: LidarrPlanGenerationResultV3<LidarrSyncRatingsPlan>;
  /** Absent in `"recommend"` and `"plan"` mode, and when a confirm was declined. */
  readonly apply?: LidarrPlanApplyResult;
}

/**
 * Proportion of the matched library this run would change.
 *
 * Reported, never a gate: a large fraction is a prompt to re-read the
 * thresholds, not a condition the command refuses on.
 */
export interface SyncRatingsFootprint {
  /** `report.coverage.authoritativeLinks` — the exact-MBID population. */
  readonly authoritativeLinks: number;
  /** Distinct artists across every sealable cohort. */
  readonly changedArtists: number;
  /** `changedArtists / max(authoritativeLinks, 1)`, rounded to four decimals. */
  readonly fraction: number;
}

export interface LidarrSyncRatingsReport {
  readonly schema: typeof SYNC_RATINGS_SCHEMA;
  readonly mode: LidarrSyncRatingsMode;
  readonly decisions: readonly SyncRatingsDecision[];
  readonly thresholds: SyncRatingsResolvedThresholds;
  readonly cohorts: readonly SyncRatingsCohort[];
  /** Decision- and artist-scoped refusals, in `SYNC_RATINGS_REFUSAL_CODES` order. */
  readonly refusals: readonly SyncRatingsRefusal[];
  readonly footprint: SyncRatingsFootprint;
  /** 0-2 outcomes, ordered by `POLICY_PRODUCER_IDS` declaration order. */
  readonly outcomes: readonly LidarrSyncRatingsOutcome[];
  /**
   * The verbatim, deep-frozen `PolicyEvaluationReport` returned by the
   * unmodified evaluate action, embedded unchanged.
   *
   * The projection reads only from this object, which is what makes the two
   * commands structurally incapable of disagreeing about a decision. It is NOT
   * byte-identical to a `lidarr policy evaluate` run: `evaluatedAt` is stamped
   * per run and the sync-ratings overrides mutate the echoed resolved policy.
   * `--explain` reads it.
   */
  readonly evaluation: PolicyEvaluationReport;
  /**
   * Per-decision state read from the RAW `policy.rules.*.enabled` tri-state.
   *
   * `evaluation.policy.rules[id].enabled` is contaminated by the force-enable
   * override this command passes to the engine, so it must never be a
   * presenter's source for decision state or provenance — this field is.
   */
  readonly decisionStates: Readonly<Record<SyncRatingsDecision, "on" | "unset" | "off">>;
}

/* ── Bounds ──────────────────────────────────────────────────────────────── */

/** Inclusive `--min-stars` bounds, matching `validateStarRating`. */
export const SYNC_RATINGS_MIN_STARS = 1;
export const SYNC_RATINGS_MAX_STARS = 5;
/** Inclusive `--max-plays` ceiling, matching the config validator's bound. */
export const SYNC_RATINGS_MAX_PLAYS = 1_000_000;

/* ── CLI option surface ──────────────────────────────────────────────────── */

/**
 * Every long option `rfmedia lidarr sync-ratings` declares, in Commander
 * declaration order.
 *
 * This is the single artifact binding the leaf's declared options to the
 * hand-written shell-completion templates: the completion spec never constructs
 * the Commander program, so nothing else in the repo reconciles the two.
 *
 * Root `--output` and `--json` are declared on the root program and reconciled
 * by the `cli.ts` `preAction` hook; the leaf must not redeclare them, so they
 * deliberately do not appear here.
 */
export const LIDARR_SYNC_RATINGS_OPTION_LONGS = [
  "--plex-library",
  "--decision",
  "--min-stars",
  "--max-plays",
  "--quality-profile",
  "--max-proposals",
  "--mode",
  "--yes",
  "--explain",
  "--verbose",
  "--plex-url",
  "--plex-token",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;
