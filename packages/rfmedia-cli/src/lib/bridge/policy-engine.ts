/**
 * The consumption-policy engine (issue #209, design §3, §8.7, §10.3, §14.3,
 * §16.1, §16.2, §16.4).
 *
 * A registry clone of `../lidarr/audit.ts`: pure and synchronous, gathered slots
 * in and a deep-frozen {@link PolicyEvaluationReport} out, with
 * `LidarrAuditFinding` replaced by `PolicyProposal`. Every concern a single rule
 * must NOT own lives here — default resolution, selection, the `enabled` gate,
 * requirement gating, the §16.1 profile gate, per-rule error isolation, the §6.0
 * universal refusals, hard bounds, status precedence, ordering, and the summary
 * and coverage accounting — so the evaluators in `./policy-rules.js` stay
 * trivial functions over already-materialised indexes.
 *
 * Five structural guarantees, which are exactly what a `--json` consumer relies
 * on and four of which are invisible in a happy-path run:
 *
 * 1. EVERY registered rule appears in `report.rules` exactly once, always —
 *    deselected, disabled, ungathered, errored, or run. A consumer keys on ids
 *    without probing for their presence.
 * 2. Requirement gating: the first unavailable `requires` slot skips the rule
 *    with THAT slot's own reason and detail. An unavailable `enriches` slot never
 *    gates. A consumed slot that failed to load (`data-unavailable`,
 *    `lidarr-unreachable`) degrades the report; an expected absence
 *    (`not-requested`, `plex-not-configured`) never does.
 * 3. A throwing evaluator costs exactly ONE rule: it becomes a `rule-error` skip
 *    carrying a bounded message, the report degrades, and every sibling rule
 *    still runs.
 * 4. Status precedence is strict: `degraded` > `proposals` > `clean`.
 * 5. Deterministic total order — rule declaration order, then `lidarrId` asc,
 *    then `plexId` asc — and the whole report is deep-frozen.
 *
 * §16.1 is owned here, not by any rule: an unresolvable `targetQualityProfile`
 * produces a rule-level skip naming the configured value AND the available
 * profile names, and degrades the report. It NEVER throws
 * `LookupNotFoundError`, because that would delete a perfectly good
 * `stale-monitoring-cleanup` report over an unrelated rule's misconfiguration.
 *
 * This module MUST NOT statically import `../lidarr/index.js` or any barrel that
 * would close an ESM cycle. The import direction is strictly
 * `types ← support ← signals ← rules ← engine`.
 */

import type { PolicyConfigOptions } from "../../types/config.js";
import type { LidarrProfile } from "../../types/lidarr.js";
import {
  POLICY_ENGINE_VERSION,
  POLICY_EVALUATION_SCHEMA,
  POLICY_MAX_PROPOSALS_PER_RULE,
  POLICY_MAX_SKIPS_PER_RULE,
  POLICY_RULE_DESCRIPTORS,
  POLICY_RULE_IDS,
  POLICY_SIGNALS,
} from "../../types/lidarr-policy.js";
import type {
  PolicyEvaluationCoverage,
  PolicyEvaluationInput,
  PolicyEvaluationReport,
  PolicyEvaluationSummary,
  PolicyEvaluatedProposal,
  PolicyIdentityIndex,
  PolicyNonAuthoritativeSubject,
  PolicyObservation,
  PolicyOverrideResult,
  PolicyProposal,
  PolicyResolvedDiscoverySeed,
  PolicyResolvedPolicy,
  PolicyResolvedRatingQualityUpgrade,
  PolicyResolvedStaleMonitoring,
  PolicyRuleDescriptor,
  PolicyRuleEvaluator,
  PolicyRuleId,
  PolicyRuleResult,
  PolicyRuleSkipReason,
  PolicySignal,
  PolicySignalBundle,
  PolicySignalSlot,
  PolicySignalStatusMap,
  PolicySignalUnavailableReason,
  PolicySkip,
  PolicySubject,
} from "../../types/lidarr-policy.js";
import {
  applyCohortCap,
  POLICY_CAP_RANKING,
  type RankedPolicyProposal,
} from "./policy-rule-shared.js";
import { reconcilePolicyOverrides } from "./policy-overrides.js";
import { createPolicySkip } from "./policy-rule-support.js";
import {
  evaluateDiscoverySeed,
  evaluateRatingQualityUpgrade,
  evaluateStaleMonitoringCleanup,
} from "./policy-rules.js";
import {
  buildPolicyEvaluationCoverage,
  buildTrackJoinSummary,
  indexArtistRatings,
  indexAuthoritativeIdentities,
  toPolicyPlayIndex,
} from "./policy-signals.js";

/**
 * Every registered rule's verdict function.
 *
 * MODULE-PRIVATE, mirroring `../lidarr/audit.ts:93`: keeping the map out of
 * `./policy-rules.js` is what lets that module stay the composition root without
 * importing this one. Keyed on `PolicyRuleId`, so a newly registered rule is a
 * compile error until its evaluator exists.
 */
const EVALUATORS: Readonly<Record<PolicyRuleId, PolicyRuleEvaluator>> = Object.freeze({
  "rating-quality-upgrade": evaluateRatingQualityUpgrade,
  "stale-monitoring-cleanup": evaluateStaleMonitoringCleanup,
  "discovery-seed": evaluateDiscoverySeed,
});

/** Skip detail for a rule the operator excluded with `--rule`. */
const NOT_SELECTED_DETAIL = "rule not included in the --rule selection";

/**
 * The Plex music library assumed when neither `--plex-library` nor
 * `policy.plexLibrary` names one.
 *
 * `"Music"` is the repo-wide default for a Plex music library (it is the
 * Commander default on `rfmedia plex` leaves) and is the value §5.3 and §10.2
 * use throughout.
 */
const DEFAULT_PLEX_LIBRARY = "Music";

/**
 * Every default, applied HERE and nowhere else.
 *
 * §5.2 forbids the config validator from injecting a single default: it returns
 * only what the operator supplied, so `undefined` keeps meaning "unset" all the
 * way to this consumption site. Pattern: `resolveLidarrCascadePolicy`
 * (`../lidarr/cascade-analysis.ts:145`).
 */
const POLICY_DEFAULTS = Object.freeze({
  ratingMinRating: 4,
  ratingMaxProposals: 25,
  staleMaxPlays: 0,
  staleProtectRatingAtOrAbove: 4,
  staleRequireTrackCoverage: true,
  staleMinTrackFileCount: 1,
  staleMaxProposals: 25,
  seedMinRating: 5,
  seedMaxSeeds: 10,
});

/**
 * Unavailable reasons that mean a gather genuinely FAILED.
 *
 * Everything else in `PolicySignalUnavailableReason` (`not-requested`,
 * `plex-not-configured`) is an expected absence: a narrowed `--rule` run or an
 * unconfigured Plex must not make a correct report look broken (§8.7).
 */
const FAILED_GATHER_REASONS: ReadonlySet<PolicySignalUnavailableReason> = new Set([
  "data-unavailable",
  "lidarr-unreachable",
]);

/** `POLICY_RULE_IDS` as a rank lookup, for the deterministic total order. */
const RULE_ORDER: ReadonlyMap<PolicyRuleId, number> = new Map(
  POLICY_RULE_IDS.map((id, index) => [id, index] as const),
);

/** §16.3's cap comparator per rule, used ONLY to decide the cut. */
const CAP_COMPARATORS: Readonly<
  Record<PolicyRuleId, (left: RankedPolicyProposal, right: RankedPolicyProposal) => number>
> = Object.freeze({
  "rating-quality-upgrade": (left, right) =>
    right.rating - left.rating || left.lidarrId - right.lidarrId,
  "stale-monitoring-cleanup": (left, right) =>
    left.plays - right.plays || left.lidarrId - right.lidarrId,
  "discovery-seed": (left, right) =>
    right.rating - left.rating ||
    right.plays - left.plays ||
    left.plexId.localeCompare(right.plexId),
});

/** The identity substrate when the bridge slot was never gathered. */
const EMPTY_IDENTITY_INDEX: PolicyIdentityIndex = Object.freeze({
  links: Object.freeze([]),
  byLidarrId: Object.freeze(new Map()),
  byPlexId: Object.freeze(new Map()),
  nonAuthoritative: Object.freeze([]),
  seedCandidates: Object.freeze([]),
});

/** Everything {@link runLidarrPolicyEvaluation} needs; the action supplies all of it. */
export interface PolicyEvaluationRunInput {
  /** When the evaluation ran (ISO-8601), stamped by the action. */
  readonly evaluatedAt: string;
  /** Credential-free canonical Plex origin. */
  readonly plexOrigin: string;
  /** Credential-free canonical Lidarr origin. */
  readonly lidarrOrigin: string;
  /** Rule ids the operator selected; everything else reports `not-selected`. */
  readonly selected: ReadonlySet<PolicyRuleId>;
  /** One slot per `PolicySignal`, already gathered by the action. */
  readonly signals: PolicySignalBundle;
  /** Raw `policy:` config, exactly as the validator returned it — no defaults. */
  readonly config: PolicyConfigOptions | undefined;
  /** Per-invocation CLI overrides. */
  readonly overrides: PolicyEvaluationOverrides;
}

/**
 * The per-invocation overrides the leaf may supply.
 *
 * `maxProposals` is a SINGLE GLOBAL integer applied as every selected rule's cap
 * (§16.2). There is deliberately no `--max-proposals rule=N` syntax to parse:
 * the config file already allows per-rule tuning for the persistent case.
 *
 * Every field is optional and every consumption site slots it ahead of the
 * config lookup with `??`, so a leaf that supplies none of them — which is what
 * `rfmedia lidarr policy evaluate` does — resolves exactly as it did before the
 * seam existed.
 */
export interface PolicyEvaluationOverrides {
  readonly plexLibrary?: string;
  readonly maxProposals?: number;
  /** #221 `--min-stars`. Overrides ONLY `rating-quality-upgrade.minRating`. */
  readonly ratingMinRating?: number;
  /**
   * #221 `--quality-profile`. A name or numeric id, resolved against the LIVE
   * profile slot by {@link resolveTargetProfileId} exactly as the config value
   * is — numeric-first, so a profile literally NAMED `"320"` resolves by id.
   */
  readonly ratingTargetQualityProfile?: string;
  /** #221 `--max-plays`. Overrides ONLY `stale-monitoring-cleanup.maxPlays`. */
  readonly staleMaxPlays?: number;
  /**
   * Rule ids treated as enabled regardless of `policy.rules.<id>.enabled`.
   *
   * Callers MUST narrow `selected` to the same ids. {@link runRule} applies the
   * `not-selected` gate BEFORE the `disabled` gate, so a force-enabled but
   * unselected rule still reports `not-selected`.
   *
   * The resolved `enabled` produced here is echoed verbatim into
   * `report.policy.rules[id].enabled`, so under this override that field is
   * CONTAMINATED: it reports the effective value, not the operator's
   * configuration. A consumer that needs the operator's tri-state must read the
   * raw `PolicyConfigOptions`, never the report.
   */
  readonly forceEnable?: ReadonlySet<PolicyRuleId>;
}

/** One rule that reached dispatch, before bounds and §6.0 attribution. */
interface RanRule {
  readonly id: PolicyRuleId;
  readonly title: string;
  readonly proposals: readonly PolicyProposal[];
  readonly skips: readonly PolicySkip[];
}

/**
 * One entry in the per-rule pass: either already-skipped, or run.
 *
 * `degraded` travels with the entry rather than through a mutable outer flag so
 * every gate stays a pure expression.
 */
type RuleOutcomeEntry =
  | { readonly kind: "skipped"; readonly result: PolicyRuleResult; readonly degraded: boolean }
  | { readonly kind: "ran"; readonly ran: RanRule; readonly degraded: boolean };

/** Builds a skipped per-rule entry. */
function skipEntry(result: PolicyRuleResult, degraded: boolean): RuleOutcomeEntry {
  return { kind: "skipped", result, degraded };
}

/**
 * Widens a frozen registry entry to the descriptor interface.
 *
 * The registry is declared `as const`, so a direct index yields a union of
 * literal-typed entries whose `requires` / `enriches` tuples cannot be iterated
 * as one. Reading through this helper collapses that union once.
 *
 * @param id - The rule id to describe.
 * @returns The descriptor for that id.
 */
function describeRule(id: PolicyRuleId): PolicyRuleDescriptor {
  return POLICY_RULE_DESCRIPTORS[id];
}

/**
 * Reads one gathered slot without caring about its payload type.
 *
 * @param signals - Slots gathered by the action.
 * @param signal - Which slot to read.
 * @returns The slot, with its data erased to `unknown`.
 */
function readSlot(signals: PolicySignalBundle, signal: PolicySignal): PolicySignalSlot<unknown> {
  return signals[signal];
}

/** Extracts a bounded human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves `targetQualityProfile` against the live profile list.
 *
 * Accepts a numeric id or a case-insensitive name, in that order, because §5.1
 * declares the config field as "by name or numeric id". Returns `null` when the
 * value resolves to nothing — the engine turns that into the §16.1 rule skip
 * rather than throwing.
 *
 * @param target - The configured value, or null when unset.
 * @param slot - The gathered quality-profile slot.
 * @returns The resolved Lidarr profile id, or null.
 */
function resolveTargetProfileId(
  target: string | null,
  slot: PolicySignalSlot<readonly LidarrProfile[]>,
): number | null {
  if (target === null || slot.status !== "available") {
    return null;
  }

  const trimmed = target.trim();
  if (trimmed === "") {
    return null;
  }

  const numeric = Number(trimmed);
  if (Number.isSafeInteger(numeric)) {
    const byId = slot.data.find((profile) => profile.id === numeric);
    if (byId !== undefined) {
      return byId.id;
    }
  }

  const lowered = trimmed.toLowerCase();
  return slot.data.find((profile) => profile.name.trim().toLowerCase() === lowered)?.id ?? null;
}

/**
 * Resolves one rule's effective `enabled`, honouring the per-invocation
 * force-enable set.
 *
 * A rule the operator never configured has `configured === undefined`, which is
 * the only state a caller is expected to force; an explicit `false` is a
 * deliberate kill switch and remains the caller's to respect before it puts the
 * id in the set. The engine itself does not distinguish the two, because the
 * `enabled` gate has exactly one input.
 *
 * @param overrides - Per-invocation CLI overrides.
 * @param id - The rule being resolved.
 * @param configured - The operator's `policy.rules.<id>.enabled`, or undefined.
 * @returns True when the rule should reach dispatch.
 */
function forceEnabled(
  overrides: PolicyEvaluationOverrides,
  id: PolicyRuleId,
  configured: boolean | undefined,
): boolean {
  return overrides.forceEnable?.has(id) === true || (configured ?? false);
}

/**
 * Applies every policy default at the consumption site and resolves the live
 * quality-profile reference.
 *
 * The third parameter is MANDATORY and is what distinguishes this from
 * `resolveLidarrCascadePolicy`, which takes config alone:
 * `PolicyResolvedRatingQualityUpgrade.resolvedProfileId` cannot be produced from
 * config, because a profile NAME only means something against a live Lidarr
 * profile list. Hardcoding it to `null` would break §6.1 step 4's convergence
 * check, which is the gate that stops the rule proposing an upgrade to the
 * profile the artist is already on.
 *
 * @param config - Raw `policy:` config, or undefined when unset.
 * @param overrides - Per-invocation CLI overrides (§16.2).
 * @param qualityProfiles - The gathered live quality-profile slot.
 * @returns The frozen resolved policy echoed in the report.
 */
export function resolvePolicyConfig(
  config: PolicyConfigOptions | undefined,
  overrides: PolicyEvaluationOverrides,
  qualityProfiles: PolicySignalSlot<readonly LidarrProfile[]>,
): PolicyResolvedPolicy {
  const rules = config?.rules;
  const rating = rules?.["rating-quality-upgrade"];
  const stale = rules?.["stale-monitoring-cleanup"];
  const seed = rules?.["discovery-seed"];
  const targetQualityProfile =
    overrides.ratingTargetQualityProfile ?? rating?.targetQualityProfile ?? null;

  const resolvedRating: PolicyResolvedRatingQualityUpgrade = Object.freeze({
    kind: "rating-quality-upgrade",
    enabled: forceEnabled(overrides, "rating-quality-upgrade", rating?.enabled),
    minRating: overrides.ratingMinRating ?? rating?.minRating ?? POLICY_DEFAULTS.ratingMinRating,
    targetQualityProfile,
    resolvedProfileId: resolveTargetProfileId(targetQualityProfile, qualityProfiles),
    maxProposals:
      overrides.maxProposals ?? rating?.maxProposals ?? POLICY_DEFAULTS.ratingMaxProposals,
  });

  const resolvedStale: PolicyResolvedStaleMonitoring = Object.freeze({
    kind: "stale-monitoring-cleanup",
    enabled: forceEnabled(overrides, "stale-monitoring-cleanup", stale?.enabled),
    maxPlays: overrides.staleMaxPlays ?? stale?.maxPlays ?? POLICY_DEFAULTS.staleMaxPlays,
    minDaysSinceLastViewed: stale?.minDaysSinceLastViewed ?? null,
    protectRatingAtOrAbove:
      stale?.protectRatingAtOrAbove ?? POLICY_DEFAULTS.staleProtectRatingAtOrAbove,
    requireTrackCoverage: stale?.requireTrackCoverage ?? POLICY_DEFAULTS.staleRequireTrackCoverage,
    minTrackFileCount: stale?.minTrackFileCount ?? POLICY_DEFAULTS.staleMinTrackFileCount,
    maxProposals:
      overrides.maxProposals ?? stale?.maxProposals ?? POLICY_DEFAULTS.staleMaxProposals,
  });

  const resolvedSeed: PolicyResolvedDiscoverySeed = Object.freeze({
    kind: "discovery-seed",
    enabled: forceEnabled(overrides, "discovery-seed", seed?.enabled),
    minRating: seed?.minRating ?? POLICY_DEFAULTS.seedMinRating,
    minPlays: seed?.minPlays ?? null,
    maxSeeds: overrides.maxProposals ?? seed?.maxSeeds ?? POLICY_DEFAULTS.seedMaxSeeds,
  });

  return Object.freeze({
    plexLibrary: overrides.plexLibrary ?? config?.plexLibrary ?? DEFAULT_PLEX_LIBRARY,
    rules: Object.freeze({
      "rating-quality-upgrade": resolvedRating,
      "stale-monitoring-cleanup": resolvedStale,
      "discovery-seed": resolvedSeed,
    }),
  });
}

/**
 * Builds a `skipped` rule verdict.
 *
 * @param id - The rule id.
 * @param title - The rule's registry title.
 * @param skipReason - Machine-readable reason.
 * @param detail - Operator-facing explanation.
 * @returns The frozen verdict.
 */
function skippedRule(
  id: PolicyRuleId,
  title: string,
  skipReason: PolicyRuleSkipReason,
  detail: string,
): PolicyRuleResult {
  return Object.freeze({ id, title, status: "skipped", skipReason, detail });
}

/**
 * Builds the verdict for a rule that reached dispatch.
 *
 * `clean` and `proposals` are separate arms of `PolicyRuleResult` because
 * `clean` pins `proposedCount` to the literal `0`.
 *
 * @param bounded - The rule's bounded decisions.
 * @returns The frozen verdict.
 */
function ranRuleResult(bounded: RanRule): PolicyRuleResult {
  const skippedCount = bounded.skips.length;
  return bounded.proposals.length === 0
    ? Object.freeze({
        id: bounded.id,
        title: bounded.title,
        status: "clean",
        proposedCount: 0,
        skippedCount,
      })
    : Object.freeze({
        id: bounded.id,
        title: bounded.title,
        status: "proposals",
        proposedCount: bounded.proposals.length,
        skippedCount,
      });
}

/**
 * Finds the first hard requirement a rule cannot satisfy.
 *
 * The unavailable slot's OWN reason and detail are propagated verbatim, so the
 * report explains the absence at its source rather than inventing a per-rule
 * message. `enriches` entries are never consulted: they add depth and must not
 * gate.
 *
 * @param signals - Slots gathered by the action.
 * @param requires - The rule's hard requirements, in declaration order.
 * @returns The blocking slot's reason and detail, or undefined when it may run.
 */
function findBlockingRequirement(
  signals: PolicySignalBundle,
  requires: readonly PolicySignal[],
): { readonly detail: string } | undefined {
  for (const signal of requires) {
    const slot = readSlot(signals, signal);
    if (slot.status === "unavailable") {
      return { detail: `${signal} signal unavailable (${slot.reason}): ${slot.detail}` };
    }
  }
  return undefined;
}

/**
 * Reports whether a rule consumes a slot that genuinely failed to load.
 *
 * Both `requires` and `enriches` count as consumption — a soft enrichment that
 * could not be read still means the rule rendered its verdict over less data
 * than it asked for.
 *
 * @param signals - Slots gathered by the action.
 * @param descriptor - The rule's registry entry.
 * @returns True when at least one consumed slot failed to gather.
 */
function consumesFailedGather(
  signals: PolicySignalBundle,
  descriptor: PolicyRuleDescriptor,
): boolean {
  for (const signal of [...descriptor.requires, ...descriptor.enriches]) {
    const slot = readSlot(signals, signal);
    if (slot.status === "unavailable" && FAILED_GATHER_REASONS.has(slot.reason)) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the §16.1 rule skip when a configured target profile resolves to
 * nothing.
 *
 * Carries the configured value AND the available profile names, because the
 * operator's next action is to correct one against the other. Returns undefined
 * whenever the rule is not in that state — including when the profile slot is
 * absent, which the requirement gate has already handled.
 *
 * @param resolved - The resolved `rating-quality-upgrade` configuration.
 * @param slot - The gathered quality-profile slot.
 * @returns The rule skip detail, or undefined.
 */
function findUnresolvedTargetProfile(
  resolved: PolicyResolvedRatingQualityUpgrade,
  slot: PolicySignalSlot<readonly LidarrProfile[]>,
): string | undefined {
  if (
    resolved.targetQualityProfile === null ||
    resolved.resolvedProfileId !== null ||
    slot.status !== "available"
  ) {
    return undefined;
  }

  const available = slot.data.map((profile) => profile.name).join(", ");
  return `configured targetQualityProfile "${resolved.targetQualityProfile}" matched no live Lidarr quality profile; available profiles: ${available === "" ? "(none)" : available}`;
}

/**
 * Reads a numeric observation for the §16.3 cap ranking.
 *
 * @param observation - One per-signal observation, possibly absent.
 * @returns The observed number, or -1 so observed candidates always outrank.
 */
function observedNumber(observation: PolicyObservation<number | boolean> | undefined): number {
  if (observation === undefined || observation.status !== "observed") {
    return -1;
  }
  return typeof observation.value === "number" ? observation.value : -1;
}

/**
 * Projects a proposal onto the evidence its rule's cap cut ranks on.
 *
 * The evidence is read back off the proposal's own `observations` rather than
 * re-derived from the indexes, so the engine's defensive bound ranks on exactly
 * what the rule reported.
 *
 * @param proposal - One emitted proposal.
 * @returns The ranked entry.
 */
function rankProposal(proposal: PolicyProposal): RankedPolicyProposal {
  return {
    proposal,
    rating: observedNumber(proposal.observations["rating"]),
    plays: observedNumber(proposal.observations["plays"]),
    lidarrId: proposal.subject.artistId ?? 0,
    plexId: proposal.subject.plexId,
  };
}

/**
 * Applies the engine's hard bounds to one rule's decisions.
 *
 * `POLICY_MAX_PROPOSALS_PER_RULE` is enforced through the same §16.3 evidence
 * ranking the rules use, so the CUT never discards the strongest proposals for
 * an arbitrary reason, and the survivors keep their original order.
 * `POLICY_MAX_SKIPS_PER_RULE` truncates in the deterministic emission order.
 * Both bounds are defensive: the config ceiling on `maxProposals` equals the
 * engine bound, so the proposal cut is unreachable through configuration.
 *
 * Every reported count reflects what the report CONTAINS, so
 * `summary.skipped === report.skips.length` holds for a consumer.
 *
 * @param ran - One rule's decisions, after §6.0 attribution.
 * @returns The bounded decisions.
 */
function applyEngineBounds(ran: RanRule): RanRule {
  const capped = applyCohortCap({
    ranked: ran.proposals.map(rankProposal),
    cap: POLICY_MAX_PROPOSALS_PER_RULE,
    ruleId: ran.id,
    rankingLabel: POLICY_CAP_RANKING[ran.id],
    compare: CAP_COMPARATORS[ran.id],
  });

  const allSkips = [...ran.skips, ...capped.skips];
  return {
    id: ran.id,
    title: ran.title,
    proposals: capped.proposals,
    skips:
      allSkips.length > POLICY_MAX_SKIPS_PER_RULE
        ? allSkips.slice(0, POLICY_MAX_SKIPS_PER_RULE)
        : allSkips,
  };
}

/**
 * Materialises the §6.0 universal refusals against exactly one rule (plan R4).
 *
 * `PolicyIdentityIndex.nonAuthoritative` carries no `ruleId`: the refusal list
 * is computed once over the whole reconciliation report, and duplicating it per
 * running rule would multiply §10.2's arithmetic by the number of rules that
 * ran. Attribution is to the first rule in `POLICY_RULE_IDS` declaration order
 * that actually ran, which makes it deterministic across runs.
 *
 * @param subjects - Every subject the bridge could not prove.
 * @param ruleId - The attributed rule id.
 * @returns One skip per refused subject.
 */
function attributeNonAuthoritative(
  subjects: readonly PolicyNonAuthoritativeSubject[],
  ruleId: PolicyRuleId,
): readonly PolicySkip[] {
  return subjects.map((refused) =>
    createPolicySkip({
      ruleId,
      code: "identity-not-authoritative",
      subject: refused.subject,
      identity: refused.identity,
      detail: refused.detail,
    }),
  );
}

/**
 * Chooses the rule the §6.0 refusals are attributed to.
 *
 * When no rule ran at all the refusals are still emitted — they are data, not
 * omissions — attributed to the first registered rule id, which is the one
 * deterministic choice available.
 *
 * @param entries - The per-rule pass, in declaration order.
 * @returns The attributed rule id, and whether that rule actually ran.
 */
function selectRefusalOwner(entries: readonly RuleOutcomeEntry[]): {
  readonly ruleId: PolicyRuleId;
  readonly ran: boolean;
} {
  for (const entry of entries) {
    if (entry.kind === "ran") {
      return { ruleId: entry.ran.id, ran: true };
    }
  }
  return { ruleId: POLICY_RULE_IDS[0], ran: false };
}

/** Orders decisions by rule declaration order, then `lidarrId`, then `plexId`. */
function compareDecisions(
  left: { readonly ruleId: PolicyRuleId; readonly subject: PolicySubject },
  right: { readonly ruleId: PolicyRuleId; readonly subject: PolicySubject },
): number {
  const leftRule = RULE_ORDER.get(left.ruleId) ?? POLICY_RULE_IDS.length;
  const rightRule = RULE_ORDER.get(right.ruleId) ?? POLICY_RULE_IDS.length;
  if (leftRule !== rightRule) {
    return leftRule - rightRule;
  }

  const leftId = left.subject.artistId ?? 0;
  const rightId = right.subject.artistId ?? 0;
  if (leftId !== rightId) {
    return leftId - rightId;
  }

  return left.subject.plexId.localeCompare(right.subject.plexId);
}

/**
 * Echoes slot availability verbatim so the report explains its own gaps.
 *
 * @param signals - Slots gathered by the action.
 * @returns The frozen signal status map.
 */
function buildSignalStatusMap(signals: PolicySignalBundle): PolicySignalStatusMap {
  const entries: Record<PolicySignal, { readonly status: "available" | "unavailable" }> = {
    bridgeIdentity: { status: "available" },
    lidarrArtists: { status: "available" },
    lidarrQualityProfiles: { status: "available" },
    plexArtistRatings: { status: "available" },
    plexTrackPlays: { status: "available" },
  };

  for (const signal of POLICY_SIGNALS) {
    const slot = readSlot(signals, signal);
    entries[signal] = Object.freeze(
      slot.status === "available"
        ? { status: "available" }
        : { status: "unavailable", detail: slot.detail },
    );
  }

  return Object.freeze(entries);
}

/**
 * Aggregates decisions and rule verdicts into the report summary.
 *
 * @param proposals - Every proposal in the report.
 * @param skips - Every skip in the report.
 * @param rules - Every rule verdict, in registry order.
 * @returns The frozen summary.
 */
function buildSummary(
  proposals: readonly PolicyEvaluatedProposal[],
  skips: readonly PolicySkip[],
  rules: readonly PolicyRuleResult[],
  overrides: readonly PolicyOverrideResult[],
): PolicyEvaluationSummary {
  let rulesRun = 0;
  let rulesSkipped = 0;
  for (const rule of rules) {
    if (rule.status === "skipped") {
      rulesSkipped += 1;
    } else {
      rulesRun += 1;
    }
  }

  return Object.freeze({
    proposed: proposals.length,
    skipped: skips.length,
    suppressed: overrides.filter((override) => override.status === "suppressed").length,
    staleOverrides: overrides.filter((override) => override.status === "stale").length,
    notEvaluatedOverrides: overrides.filter((override) => override.status === "not-evaluated")
      .length,
    rulesRun,
    rulesSkipped,
  });
}

/**
 * Builds every index a rule consumes, from the gathered slots alone.
 *
 * The track join is summarized ONCE and shared by the play index and the
 * coverage block: it normalizes every drained track name, so deriving it twice
 * would double the cost of the hottest pass in the feature.
 *
 * @param signals - Slots gathered by the action.
 * @returns The identity, rating, and play/recency indexes plus the coverage block.
 */
function buildIndexes(signals: PolicySignalBundle): {
  readonly identity: PolicyIdentityIndex;
  readonly ratings: PolicyEvaluationInput["ratings"];
  readonly plays: PolicyEvaluationInput["plays"];
  readonly coverage: PolicyEvaluationCoverage;
} {
  const identity =
    signals.bridgeIdentity.status === "available"
      ? indexAuthoritativeIdentities(signals.bridgeIdentity.data)
      : EMPTY_IDENTITY_INDEX;
  const trackJoin = buildTrackJoinSummary(
    signals.plexTrackPlays.status === "available" ? signals.plexTrackPlays.data : [],
    identity,
  );

  return {
    identity,
    ratings: indexArtistRatings(
      signals.plexArtistRatings.status === "available" ? signals.plexArtistRatings.data : [],
    ),
    plays: toPolicyPlayIndex(trackJoin),
    coverage: buildPolicyEvaluationCoverage({ signals, identity, trackJoin }),
  };
}

/**
 * Runs one rule through the five gates, in this exact precedence.
 *
 * 1. **Deselected** — not in `selected` ⇒ `skipped` / `not-selected`.
 * 2. **Disabled** — `enabled === false` ⇒ `skipped` / `disabled`, naming the
 *    exact `.rfmedia.yaml` key. Checked before the degrade accounting: a rule
 *    that was never going to run must not degrade the report over a slot it
 *    would have consumed.
 * 3. **Requirement gate** — the first unavailable `requires` slot ⇒ `skipped` /
 *    `signal-unavailable` with that slot's own reason and detail.
 * 4. **§16.1 profile gate** — a configured `targetQualityProfile` that resolves
 *    to nothing ⇒ `skipped` / `signal-unavailable`, naming the configured value
 *    and every available profile. Never a throw.
 * 5. **Dispatch** — behind `try`/`catch`; a throw becomes `skipped` /
 *    `rule-error` and the run continues.
 *
 * @param id - The rule to run.
 * @param input - The fully indexed evaluator input.
 * @param selected - The run's selection.
 * @returns The rule's entry, carrying whether it degraded the report.
 */
function runRule(
  id: PolicyRuleId,
  input: PolicyEvaluationInput,
  selected: ReadonlySet<PolicyRuleId>,
): RuleOutcomeEntry {
  const descriptor = describeRule(id);
  const title = descriptor.title;
  const skip = (
    reason: PolicyRuleSkipReason,
    detail: string,
    degraded: boolean,
  ): RuleOutcomeEntry => skipEntry(skippedRule(id, title, reason, detail), degraded);

  if (!selected.has(id)) {
    return skip("not-selected", NOT_SELECTED_DETAIL, false);
  }

  const resolved = input.policy.rules[id];
  if (!resolved.enabled) {
    return skip("disabled", `disabled in policy.rules.${id}.enabled`, false);
  }

  const degraded = consumesFailedGather(input.signals, descriptor);

  const blocked = findBlockingRequirement(input.signals, descriptor.requires);
  if (blocked !== undefined) {
    return skip("signal-unavailable", blocked.detail, degraded);
  }

  if (resolved.kind === "rating-quality-upgrade") {
    const unresolved = findUnresolvedTargetProfile(resolved, input.signals.lidarrQualityProfiles);
    if (unresolved !== undefined) {
      return skip("signal-unavailable", unresolved, true);
    }
  }

  try {
    const outcome = EVALUATORS[id](input);
    if ("ruleSkip" in outcome) {
      return skip(outcome.ruleSkip.reason, outcome.ruleSkip.detail, true);
    }
    return {
      kind: "ran",
      ran: { id, title, proposals: outcome.proposals, skips: outcome.skips },
      degraded,
    };
  } catch (error) {
    return skip("rule-error", errorMessage(error), true);
  }
}

/**
 * Runs every registered rule and assembles the frozen evaluation report.
 *
 * Pure and synchronous. Every default is applied here (§5.2), every registered
 * rule is reported exactly once (§8.7), the §6.0 universal refusals are
 * attributed to exactly one rule (plan R4), and the whole envelope of §10.3 is
 * built including its `signals`, `summary`, and `coverage` blocks.
 *
 * @param input - Timestamp, origins, selection, gathered slots, and config.
 * @returns The deep-frozen report, rules in registry declaration order.
 */
export function runLidarrPolicyEvaluation(input: PolicyEvaluationRunInput): PolicyEvaluationReport {
  const policy = resolvePolicyConfig(
    input.config,
    input.overrides,
    input.signals.lidarrQualityProfiles,
  );
  const indexes = buildIndexes(input.signals);
  const evaluationInput: PolicyEvaluationInput = {
    evaluatedAt: input.evaluatedAt,
    signals: input.signals,
    policy,
    coverage: indexes.coverage,
    identity: indexes.identity,
    ratings: indexes.ratings,
    plays: indexes.plays,
    selected: input.selected,
  };

  const entries = POLICY_RULE_IDS.map((id) => runRule(id, evaluationInput, input.selected));
  const degraded = entries.some((entry) => entry.degraded);

  const refusalOwner = selectRefusalOwner(entries);
  const refusals = attributeNonAuthoritative(
    indexes.identity.nonAuthoritative,
    refusalOwner.ruleId,
  );

  const classificationRules: PolicyRuleResult[] = [];
  const boundedRuns = new Map<PolicyRuleId, RanRule>();
  const proposals: PolicyProposal[] = [];
  const skips: PolicySkip[] = refusalOwner.ran ? [] : [...refusals];

  for (const entry of entries) {
    if (entry.kind === "skipped") {
      classificationRules.push(entry.result);
      continue;
    }

    // Bound FIRST, attach the §6.0 refusals after. Concatenating them before the
    // bound would put them at the tail of the rule's own skips, where
    // `POLICY_MAX_SKIPS_PER_RULE`'s head truncation cuts first — so any library
    // whose owning rule emits 500 skips would silently delete every universal
    // refusal while `coverage.nonAuthoritativeArtists` still reported them.
    // Refusals are data, never omissions, and the no-rule-ran path emits them
    // unbounded too.
    const bounded = applyEngineBounds(entry.ran);
    const withRefusals: RanRule =
      refusalOwner.ran && bounded.id === refusalOwner.ruleId
        ? { ...bounded, skips: [...bounded.skips, ...refusals] }
        : bounded;

    proposals.push(...withRefusals.proposals);
    skips.push(...withRefusals.skips);
    boundedRuns.set(withRefusals.id, withRefusals);
    classificationRules.push(ranRuleResult(withRefusals));
  }

  proposals.sort(compareDecisions);
  skips.sort(compareDecisions);

  const reconciled = reconcilePolicyOverrides({
    plexOrigin: input.plexOrigin,
    lidarrOrigin: input.lidarrOrigin,
    plexLibrary: policy.plexLibrary,
    proposals,
    skips,
    rules: classificationRules,
    overrides: input.config?.overrides,
  });

  const rules = entries.map((entry): PolicyRuleResult => {
    if (entry.kind === "skipped") {
      return entry.result;
    }
    const bounded = boundedRuns.get(entry.ran.id);
    if (bounded === undefined) {
      throw new TypeError(`Policy engine omitted bounded rule results for ${entry.ran.id}`);
    }
    return ranRuleResult({
      ...bounded,
      proposals: reconciled.proposals.filter((proposal) => proposal.ruleId === bounded.id),
    });
  });

  const frozenRules = Object.freeze(rules);
  const frozenSkips = Object.freeze(skips);

  return Object.freeze({
    schema: POLICY_EVALUATION_SCHEMA,
    engineVersion: POLICY_ENGINE_VERSION,
    evaluatedAt: input.evaluatedAt,
    plexOrigin: input.plexOrigin,
    lidarrOrigin: input.lidarrOrigin,
    plexLibrary: policy.plexLibrary,
    status: degraded ? "degraded" : reconciled.proposals.length > 0 ? "proposals" : "clean",
    policy,
    signals: buildSignalStatusMap(input.signals),
    summary: buildSummary(reconciled.proposals, frozenSkips, frozenRules, reconciled.overrides),
    rules: frozenRules,
    proposals: reconciled.proposals,
    skips: frozenSkips,
    overrides: reconciled.overrides,
    coverage: indexes.coverage,
  });
}
