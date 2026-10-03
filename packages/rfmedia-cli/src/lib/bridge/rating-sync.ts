/**
 * The pure decision-projection layer for `rfmedia lidarr sync-ratings` (#221).
 *
 * ZERO I/O: no client, no adapter, no database, no clock, no `fetch`. It imports
 * `../../types/*.js` and nothing else — never `./policy-engine.js` or
 * `./policy-rules.js`, which would close an ESM cycle — and every value it
 * constructs is frozen before it leaves.
 *
 * This is the only genuinely new decision logic in the feature. It re-derives no
 * rating, no play total and no threshold: the engine already decided all three,
 * and this module reads its frozen report. What it adds is exactly four gates —
 * the explicit kill switch (G1), the per-rule evaluation gate (G2), the
 * cross-decision conflict (G3), and the engine invariants (G4).
 *
 * G4 THROWS. A malformed proposal that is quietly dropped produces a silently
 * WRONG cohort, and a cohort is what becomes a mutation, so an invariant
 * violation ends the run instead of shrinking the artifact.
 *
 * Two shapes of the report are easy to get wrong and are handled once, here:
 * `report.rules` is an ARRAY (searched with `.find`), and `before` / `after` are
 * string-index records (bracket access, narrowed with `typeof`).
 */

import type { PolicyConfigOptions } from "../../types/config.js";
import type {
  PolicyEvaluationReport,
  PolicyProducerId,
  PolicyProposal,
  PolicyResolvedRatingQualityUpgrade,
  PolicyResolvedStaleMonitoring,
  PolicyRuleId,
  PolicyRuleResult,
  PolicyRuleSkipReason,
} from "../../types/lidarr-policy.js";
import {
  SYNC_RATINGS_DECISION_BINDING,
  SYNC_RATINGS_DECISIONS,
  SYNC_RATINGS_REFUSAL_CODES,
} from "../../types/lidarr-sync-ratings.js";
import type {
  SyncRatingsChange,
  SyncRatingsCohort,
  SyncRatingsDecision,
  SyncRatingsDecisionBinding,
  SyncRatingsFootprint,
  SyncRatingsRefusal,
  SyncRatingsRefusalCode,
  SyncRatingsResolvedThresholds,
  SyncRatingsThreshold,
  SyncRatingsThresholdSource,
} from "../../types/lidarr-sync-ratings.js";

/* ── Constants ───────────────────────────────────────────────────────────── */

/** The exact `.rfmedia.yaml` key that re-enables each decision. */
export const SYNC_RATINGS_REMEDY: Readonly<Record<SyncRatingsDecision, string>> = Object.freeze({
  "quality-profile": "policy.rules.rating-quality-upgrade.enabled",
  monitoring: "policy.rules.stale-monitoring-cleanup.enabled",
});

/**
 * Dotted `.rfmedia.yaml` keys behind the four echoed thresholds.
 *
 * Deliberately re-declared rather than imported from `./policy-rule-shared.js`:
 * this module imports `../../types/*.js` alone, which is what keeps it free of
 * the evaluator graph and of any ESM cycle.
 */
const SYNC_RATINGS_CONFIG_PATH = {
  minStars: "policy.rules.rating-quality-upgrade.minRating",
  qualityProfile: "policy.rules.rating-quality-upgrade.targetQualityProfile",
  maxPlays: "policy.rules.stale-monitoring-cleanup.maxPlays",
  maxProposals: "policy.rules.rating-quality-upgrade.maxProposals",
} as const;

/**
 * The `.rfmedia.yaml` key that resolves a cross-decision conflict.
 *
 * An artist draws both a profile upgrade and an unmonitor exactly while its
 * rating falls in the half-open band `[minStars, protectRatingAtOrAbove)`, so
 * the band is empty only once `protectRatingAtOrAbove <= minStars`. The remedy
 * is therefore to CLOSE that gap — lower the protected floor to `--min-stars`,
 * or raise `--min-stars` to the floor. Widening it strictly enlarges the band
 * and withholds more artists.
 */
const CONFLICT_REMEDY = "policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove";

/** `SYNC_RATINGS_REFUSAL_CODES` as a rank lookup, for the refusal order. */
const REFUSAL_ORDER: ReadonlyMap<SyncRatingsRefusalCode, number> = new Map(
  SYNC_RATINGS_REFUSAL_CODES.map((code, index) => [code, index] as const),
);

/* ── Failure ─────────────────────────────────────────────────────────────── */

/**
 * An invariant the policy engine guarantees was violated.
 *
 * Thrown, never silently skipped: a malformed proposal that is quietly dropped
 * produces a silently WRONG cohort, and a cohort is what becomes a mutation.
 * Every instance means the engine changed underneath this module.
 */
export class SyncRatingsProjectionError extends Error {
  /** The offending proposal key, or the rule id when no proposal is in scope. */
  readonly decisionKey: string;

  /**
   * @param decisionKey - The offending proposal key, or the rule id.
   * @param detail - What the engine guaranteed and what arrived instead.
   */
  constructor(decisionKey: string, detail: string) {
    super(`${decisionKey}: ${detail}`);
    this.name = "SyncRatingsProjectionError";
    this.decisionKey = decisionKey;
  }
}

/* ── Internal shapes ─────────────────────────────────────────────────────── */

/** A cohort that passed G1 and G2, before the cross-decision drop. */
interface CohortDraft {
  readonly decision: SyncRatingsDecision;
  readonly ruleId: PolicyRuleId;
  readonly producer: PolicyProducerId;
  readonly changes: readonly SyncRatingsChange[];
  readonly desiredMonitored: boolean | null;
  readonly resolvedProfileId: number | null;
  readonly qualityProfileName: string | null;
}

/** One selected decision's fate after the two per-decision gates. */
type DecisionOutcome =
  | { readonly kind: "refused"; readonly cohort: SyncRatingsCohort }
  | { readonly kind: "projected"; readonly draft: CohortDraft };

/* ── Report readers ──────────────────────────────────────────────────────── */

/**
 * Reads one rule's result out of the report's rule ARRAY.
 *
 * The engine maps over every registered rule id, so an absent entry is an
 * invariant violation rather than a refusal the operator can act on.
 *
 * @param report - A completed evaluation report.
 * @param ruleId - The rule bound to the selected decision.
 * @returns That rule's result row.
 * @throws {SyncRatingsProjectionError} When the rule is absent from the report.
 */
function requireRuleResult(report: PolicyEvaluationReport, ruleId: PolicyRuleId): PolicyRuleResult {
  const result = report.rules.find((rule) => rule.id === ruleId);
  if (result === undefined) {
    throw new SyncRatingsProjectionError(
      ruleId,
      "rule is absent from report.rules, which the engine builds by mapping over every registered rule id",
    );
  }
  return result;
}

/**
 * Narrows the echoed resolved policy's rating rule on its `kind` discriminant.
 *
 * @param report - A completed evaluation report.
 * @returns The resolved `rating-quality-upgrade` rule.
 * @throws {SyncRatingsProjectionError} When the entry carries another `kind`.
 */
function requireRatingRule(report: PolicyEvaluationReport): PolicyResolvedRatingQualityUpgrade {
  const resolved = report.policy.rules["rating-quality-upgrade"];
  if (resolved.kind !== "rating-quality-upgrade") {
    throw new SyncRatingsProjectionError(
      "rating-quality-upgrade",
      `report.policy.rules is mis-keyed: the entry carries kind "${resolved.kind}"`,
    );
  }
  return resolved;
}

/**
 * Narrows the echoed resolved policy's monitoring rule on its `kind`.
 *
 * @param report - A completed evaluation report.
 * @returns The resolved `stale-monitoring-cleanup` rule.
 * @throws {SyncRatingsProjectionError} When the entry carries another `kind`.
 */
function requireStaleRule(report: PolicyEvaluationReport): PolicyResolvedStaleMonitoring {
  const resolved = report.policy.rules["stale-monitoring-cleanup"];
  if (resolved.kind !== "stale-monitoring-cleanup") {
    throw new SyncRatingsProjectionError(
      "stale-monitoring-cleanup",
      `report.policy.rules is mis-keyed: the entry carries kind "${resolved.kind}"`,
    );
  }
  return resolved;
}

/** Renders an index-signature scalar for an invariant message. */
function describeScalar(value: string | number | boolean | null | undefined): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}

/* ── Refusals ────────────────────────────────────────────────────────────── */

/**
 * Orders refusals by code, then by artist.
 *
 * @param left - One refusal.
 * @param right - The refusal it is compared with.
 * @returns A negative, zero, or positive ordering value.
 */
function compareRefusals(left: SyncRatingsRefusal, right: SyncRatingsRefusal): number {
  const byCode = (REFUSAL_ORDER.get(left.code) ?? 0) - (REFUSAL_ORDER.get(right.code) ?? 0);
  return byCode !== 0 ? byCode : (left.artistId ?? 0) - (right.artistId ?? 0);
}

/**
 * Builds the G1 refusal for a decision the operator switched off.
 *
 * @param decision - The refused decision.
 * @returns The frozen refusal.
 */
function disabledRefusal(decision: SyncRatingsDecision): SyncRatingsRefusal {
  const remedy = SYNC_RATINGS_REMEDY[decision];
  return Object.freeze({
    code: "decision-disabled",
    scope: "decision",
    decision,
    artistId: null,
    ruleSkipReason: null,
    detail: `${remedy} is false, so this decision is deliberately switched off`,
    remedy,
  });
}

/**
 * Builds the G2 refusal for a rule the engine did not evaluate.
 *
 * @param decision - The refused decision.
 * @param skipReason - The rule's own skip reason, carried verbatim.
 * @param detail - The rule's own detail, carried verbatim.
 * @returns The frozen refusal.
 */
function notEvaluatedRefusal(
  decision: SyncRatingsDecision,
  skipReason: PolicyRuleSkipReason,
  detail: string,
): SyncRatingsRefusal {
  return Object.freeze({
    code: "rule-not-evaluated",
    scope: "decision",
    decision,
    artistId: null,
    ruleSkipReason: skipReason,
    detail,
    remedy: null,
  });
}

/**
 * Builds the G3 refusal for an artist withheld from BOTH cohorts.
 *
 * @param artistId - The Lidarr artist both decisions proposed.
 * @returns The frozen refusal.
 */
function conflictRefusal(artistId: number): SyncRatingsRefusal {
  return Object.freeze({
    code: "cross-decision-conflict",
    scope: "artist",
    decision: null,
    artistId,
    ruleSkipReason: null,
    detail: `artist ${artistId} is proposed by both decisions; the two artifacts apply independently with no ordering guarantee, so it is withheld from both`,
    remedy: CONFLICT_REMEDY,
  });
}

/* ── Projection ──────────────────────────────────────────────────────────── */

/**
 * Projects one proposal into a change, carrying the diff material verbatim.
 *
 * @param proposal - The engine's frozen proposal.
 * @param artistId - Its already-narrowed Lidarr artist id.
 * @returns The frozen change.
 */
function toChange(proposal: PolicyProposal, artistId: number): SyncRatingsChange {
  return Object.freeze({
    decisionKey: proposal.key,
    artistId,
    artistName: proposal.subject.name,
    plexId: proposal.subject.plexId,
    artistMbid: proposal.subject.artistMbid,
    before: proposal.before,
    after: proposal.after,
    checks: proposal.checks,
    summary: proposal.summary,
  });
}

/**
 * Projects one selected decision's proposals into a draft cohort.
 *
 * Proposals are filtered on `ruleId` BEFORE any invariant runs, because a
 * `discovery-seed` proposal legitimately carries no `subject.artistId` and must
 * never be mistaken for an engine-invariant violation.
 *
 * @param report - A completed evaluation report.
 * @param decision - The decision being projected.
 * @param binding - Its rule and producer.
 * @returns The draft cohort, before the cross-decision drop.
 * @throws {SyncRatingsProjectionError} When a proposal carries no
 *   `subject.artistId`, when its `after` map lacks the scalar its producer
 *   requires, when two profile proposals name different target ids, or when the
 *   resolved policy carries no `resolvedProfileId` behind a non-empty cohort.
 */
function projectDecision(
  report: PolicyEvaluationReport,
  decision: SyncRatingsDecision,
  binding: SyncRatingsDecisionBinding,
): CohortDraft {
  const rating = decision === "quality-profile" ? requireRatingRule(report) : null;
  const changes: SyncRatingsChange[] = [];
  // An empty monitoring cohort still reports the rule's structural target.
  let desiredMonitored: boolean | null = decision === "monitoring" ? false : null;
  // Distinguishes the seeded default above from a value an actual proposal
  // decided, so the divergence guard below cannot fire against the seed.
  let observedMonitored = false;
  let proposedProfileId: number | null = null;
  let qualityProfileName: string | null = null;

  for (const proposal of report.proposals) {
    if (proposal.ruleId !== binding.ruleId) {
      continue;
    }

    const artistId = proposal.subject.artistId;
    if (typeof artistId !== "number") {
      throw new SyncRatingsProjectionError(
        proposal.key,
        "proposal carries no subject.artistId, so it names no Lidarr artist to mutate",
      );
    }

    if (decision === "monitoring") {
      const next = proposal.after["monitored"];
      if (typeof next !== "boolean") {
        throw new SyncRatingsProjectionError(
          proposal.key,
          `after["monitored"] is ${describeScalar(next)} rather than a boolean`,
        );
      }
      // The cohort seals ONE monitored scalar over every artistId, so a
      // divergent proposal would silently mutate artists to the opposite of
      // what their own proposal decided. Fail fast, exactly as the profile
      // branch does for a divergent target id.
      if (observedMonitored && next !== desiredMonitored) {
        throw new SyncRatingsProjectionError(
          proposal.key,
          `names monitored=${next} while an earlier proposal in the same cohort named monitored=${desiredMonitored}`,
        );
      }
      desiredMonitored = next;
      observedMonitored = true;
    } else {
      const target = proposal.after["qualityProfileId"];
      if (typeof target !== "number") {
        throw new SyncRatingsProjectionError(
          proposal.key,
          `after["qualityProfileId"] is ${describeScalar(target)} rather than a number`,
        );
      }
      if (proposedProfileId !== null && target !== proposedProfileId) {
        throw new SyncRatingsProjectionError(
          proposal.key,
          `names target quality profile ${target} while an earlier proposal in the same cohort named ${proposedProfileId}`,
        );
      }
      proposedProfileId = target;

      const name = proposal.after["qualityProfileName"];
      if (qualityProfileName === null && typeof name === "string") {
        qualityProfileName = name;
      }
    }

    changes.push(toChange(proposal, artistId));
  }

  if (rating !== null && changes.length > 0 && typeof rating.resolvedProfileId !== "number") {
    throw new SyncRatingsProjectionError(
      binding.ruleId,
      "the resolved policy carries no resolvedProfileId while its cohort proposes profile changes",
    );
  }

  return {
    decision,
    ruleId: binding.ruleId,
    producer: binding.producer,
    changes,
    desiredMonitored,
    resolvedProfileId: rating?.resolvedProfileId ?? null,
    // Prefer the live profile NAME a proposal resolved, because
    // `--quality-profile 320` resolves numerically first and only the resolved
    // name makes the chosen profile legible. With no proposal to read it from
    // there is no resolved name, so this falls back to the operator's own
    // token purely for display.
    qualityProfileName: qualityProfileName ?? rating?.targetQualityProfile ?? null,
  };
}

/**
 * Finds every artist proposed by more than one decision.
 *
 * @param drafts - The drafts that passed G1 and G2.
 * @returns The conflicting Lidarr artist ids.
 */
function findConflictingArtists(drafts: readonly CohortDraft[]): ReadonlySet<number> {
  const seen = new Set<number>();
  const conflicting = new Set<number>();
  for (const draft of drafts) {
    for (const artistId of new Set(draft.changes.map((change) => change.artistId))) {
      if (seen.has(artistId)) {
        conflicting.add(artistId);
      } else {
        seen.add(artistId);
      }
    }
  }
  return conflicting;
}

/**
 * Builds the cohort a refused decision still reports.
 *
 * A refusal is DATA: the cohort stays in the report with an empty change list so
 * a consumer keys on decisions without probing for their presence.
 *
 * @param decision - The refused decision.
 * @param binding - Its rule and producer.
 * @returns The frozen, empty cohort.
 */
function refusedCohort(
  decision: SyncRatingsDecision,
  binding: SyncRatingsDecisionBinding,
): SyncRatingsCohort {
  return Object.freeze({
    decision,
    ruleId: binding.ruleId,
    producer: binding.producer,
    gate: "refused",
    resolvedProfileId: null,
    qualityProfileName: null,
    desiredMonitored: null,
    changes: Object.freeze([]),
    artistIds: Object.freeze([]),
  });
}

/**
 * Applies the cross-decision drop and seals a draft into its cohort.
 *
 * @param draft - A cohort that passed G1 and G2.
 * @param conflicting - Artists withheld from every cohort.
 * @returns The frozen cohort.
 */
function sealCohort(draft: CohortDraft, conflicting: ReadonlySet<number>): SyncRatingsCohort {
  const changes = draft.changes.filter((change) => !conflicting.has(change.artistId));
  const artistIds = [...new Set(changes.map((change) => change.artistId))].sort(
    (left, right) => left - right,
  );
  return Object.freeze({
    decision: draft.decision,
    ruleId: draft.ruleId,
    producer: draft.producer,
    gate: changes.length > 0 ? "sealable" : "no-changes",
    resolvedProfileId: draft.resolvedProfileId,
    qualityProfileName: draft.qualityProfileName,
    desiredMonitored: draft.desiredMonitored,
    changes: Object.freeze(changes),
    artistIds: Object.freeze(artistIds),
  });
}

/* ── Plan ────────────────────────────────────────────────────────────────── */

export interface RatingSyncPlanInput {
  /** A completed, deep-frozen evaluation report. */
  readonly report: PolicyEvaluationReport;
  /** The operator's `--decision` selection. */
  readonly decisions: readonly SyncRatingsDecision[];
  /**
   * Decisions whose rule is EXPLICITLY `enabled: false` in `.rfmedia.yaml`.
   *
   * Computed by the action from the RAW config, where `undefined` (never
   * configured) and `false` (deliberately switched off) are still
   * distinguishable — `resolvePolicyConfig` collapses both to `false`.
   */
  readonly disabledDecisions: ReadonlySet<SyncRatingsDecision>;
}

export interface RatingSyncPlan {
  readonly cohorts: readonly SyncRatingsCohort[];
  readonly refusals: readonly SyncRatingsRefusal[];
  /** Decisions whose cohort passed every gate AND has at least one change. */
  readonly sealable: readonly SyncRatingsDecision[];
  readonly footprint: SyncRatingsFootprint;
}

/**
 * Projects a frozen evaluation report into sealable producer cohorts.
 *
 * Pure, synchronous, freezing. Gates, in order: G1 the explicit config disable;
 * G2 the selected rule's own `PolicyRuleResult`; G3 the cross-decision conflict,
 * which drops the artist from BOTH cohorts. There is deliberately NO whole-report
 * gate — `report.status === "degraded"` is set by ANY rule's evaluator skip, so
 * gating on it would let one unrelated rule block a perfectly healthy cohort,
 * and the per-rule gate is what carries that rule's own `skipReason` and
 * `detail` to the operator verbatim.
 *
 * Cohorts are emitted in `SYNC_RATINGS_DECISIONS` order — which is
 * `POLICY_PRODUCER_IDS` order — so a partial failure downstream is predictable.
 *
 * @param input - The report, the selection, and the explicit-disable set.
 * @returns The frozen plan.
 * @throws {SyncRatingsProjectionError} When a selected rule is absent from
 *   `report.rules`, when a proposal carries no `subject.artistId`, when its
 *   `after` map lacks the scalar its producer requires, when two profile
 *   proposals name different target ids, or when the resolved policy carries no
 *   `resolvedProfileId` behind a non-empty profile cohort.
 */
export function buildRatingSyncPlan(input: RatingSyncPlanInput): RatingSyncPlan {
  const selected = SYNC_RATINGS_DECISIONS.filter((decision) => input.decisions.includes(decision));
  const refusals: SyncRatingsRefusal[] = [];
  const outcomes: DecisionOutcome[] = [];

  for (const decision of selected) {
    const binding = SYNC_RATINGS_DECISION_BINDING[decision];

    if (input.disabledDecisions.has(decision)) {
      refusals.push(disabledRefusal(decision));
      outcomes.push({ kind: "refused", cohort: refusedCohort(decision, binding) });
      continue;
    }

    const result = requireRuleResult(input.report, binding.ruleId);
    if (result.status === "skipped") {
      refusals.push(notEvaluatedRefusal(decision, result.skipReason, result.detail));
      outcomes.push({ kind: "refused", cohort: refusedCohort(decision, binding) });
      continue;
    }

    outcomes.push({ kind: "projected", draft: projectDecision(input.report, decision, binding) });
  }

  const drafts = outcomes.flatMap((outcome) =>
    outcome.kind === "projected" ? [outcome.draft] : [],
  );
  const conflicting = findConflictingArtists(drafts);
  for (const artistId of [...conflicting].sort((left, right) => left - right)) {
    refusals.push(conflictRefusal(artistId));
  }

  const cohorts = outcomes.map((outcome) =>
    outcome.kind === "refused" ? outcome.cohort : sealCohort(outcome.draft, conflicting),
  );

  const changedArtists = new Set<number>();
  const sealable: SyncRatingsDecision[] = [];
  for (const cohort of cohorts) {
    if (cohort.gate !== "sealable") {
      continue;
    }
    sealable.push(cohort.decision);
    for (const artistId of cohort.artistIds) {
      changedArtists.add(artistId);
    }
  }

  const authoritativeLinks = input.report.coverage.authoritativeLinks;
  const ratio = changedArtists.size / Math.max(authoritativeLinks, 1);
  const footprint: SyncRatingsFootprint = Object.freeze({
    authoritativeLinks,
    changedArtists: changedArtists.size,
    fraction: Math.round(ratio * 10_000) / 10_000,
  });

  return Object.freeze({
    cohorts: Object.freeze(cohorts),
    refusals: Object.freeze(refusals.sort(compareRefusals)),
    sealable: Object.freeze(sealable),
    footprint,
  });
}

/* ── Thresholds ──────────────────────────────────────────────────────────── */

export interface SyncRatingsThresholdInput {
  readonly report: PolicyEvaluationReport;
  /** Raw `policy:` config exactly as the validator returned it — no defaults. */
  readonly config: PolicyConfigOptions | undefined;
  readonly overrides: {
    readonly minStars?: number;
    readonly maxPlays?: number;
    readonly qualityProfile?: string;
    readonly maxProposals?: number;
  };
}

/**
 * Tags where an effective value came from.
 *
 * @param override - The CLI override for that knob, or undefined.
 * @param configured - The raw `.rfmedia.yaml` value, or undefined.
 * @returns The provenance tag.
 */
function thresholdSource(override: unknown, configured: unknown): SyncRatingsThresholdSource {
  if (override !== undefined) {
    return "flag";
  }
  return configured !== undefined ? "config" : "default";
}

/**
 * Resolves every threshold with honest `flag | config | default` provenance.
 *
 * Effective VALUES are read back off `report.policy.rules[…]`, which the engine
 * already defaulted at its single site, so this module never re-declares a
 * policy default; only the SOURCE tag is derived here. It is needed because
 * `PolicyThresholdCheck.configPath` on a proposal always cites the
 * `.rfmedia.yaml` key even when the effective bound arrived from a flag, so the
 * checks alone cannot tell a persistent policy from a one-off experiment.
 *
 * `maxProposals` is a PER-RULE cap that `--max-proposals` replaces identically
 * on every selected rule; the single echoed value is therefore the
 * `rating-quality-upgrade` cap, whose key it cites. A divergent per-rule
 * `stale-monitoring-cleanup.maxProposals` stays visible in
 * `evaluation.policy.rules`.
 *
 * @param input - The report, raw config, and CLI overrides.
 * @returns The frozen resolved thresholds echoed in the report.
 * @throws {SyncRatingsProjectionError} When the echoed resolved policy is
 *   mis-keyed and a rule entry carries another `kind`.
 */
export function resolveSyncRatingsThresholds(
  input: SyncRatingsThresholdInput,
): SyncRatingsResolvedThresholds {
  const rating = requireRatingRule(input.report);
  const stale = requireStaleRule(input.report);
  const ratingConfig = input.config?.rules?.["rating-quality-upgrade"];
  const staleConfig = input.config?.rules?.["stale-monitoring-cleanup"];

  const minStars: SyncRatingsThreshold<number> = Object.freeze({
    value: rating.minRating,
    source: thresholdSource(input.overrides.minStars, ratingConfig?.minRating),
    configPath: SYNC_RATINGS_CONFIG_PATH.minStars,
  });
  const maxPlays: SyncRatingsThreshold<number> = Object.freeze({
    value: stale.maxPlays,
    source: thresholdSource(input.overrides.maxPlays, staleConfig?.maxPlays),
    configPath: SYNC_RATINGS_CONFIG_PATH.maxPlays,
  });
  const qualityProfile: SyncRatingsThreshold<string | null> = Object.freeze({
    value: rating.targetQualityProfile,
    source: thresholdSource(input.overrides.qualityProfile, ratingConfig?.targetQualityProfile),
    configPath: SYNC_RATINGS_CONFIG_PATH.qualityProfile,
  });
  const maxProposals: SyncRatingsThreshold<number> = Object.freeze({
    value: rating.maxProposals,
    source: thresholdSource(input.overrides.maxProposals, ratingConfig?.maxProposals),
    configPath: SYNC_RATINGS_CONFIG_PATH.maxProposals,
  });

  return Object.freeze({
    minStars,
    maxPlays,
    qualityProfile,
    maxProposals,
  });
}
