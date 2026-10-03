/**
 * Cross-rule primitives for the three consumption-policy evaluators (issue
 * #209, design §6, §16.3).
 *
 * Exists so the split rule modules — `./policy-rule-rating-upgrade.js`,
 * `./policy-rule-stale-monitoring.js`, `./policy-rule-discovery-seed.js` — can
 * share the skip-precedence and cap-cut machinery without importing their own
 * composition root (`./policy-rules.js`), which would close an ESM cycle.
 *
 * Zero I/O and no proposal construction: this module holds only the two
 * cross-cutting behaviours the design states once for all three rules, plus the
 * dotted config-path table those rules echo on every configured check.
 */

import type { LidarrArtist } from "../../types/lidarr.js";
import { POLICY_SKIP_ORDER } from "../../types/lidarr-policy.js";
import type {
  PolicyIdentityLink,
  PolicyObservation,
  PolicyProposal,
  PolicyRuleId,
  PolicySkip,
  PolicySkipCode,
  PolicySubject,
  PolicyThresholdCheck,
} from "../../types/lidarr-policy.js";
import { createPolicySkip } from "./policy-rule-support.js";

/**
 * Every dotted `.rfmedia.yaml` key a policy check may cite.
 *
 * `configPath` is what makes a verdict actionable — the operator reads the key
 * to edit straight off the report — so the keys live in one table rather than
 * being spelled inline at each construction site.
 */
export const POLICY_CONFIG_PATH = {
  ratingMinRating: "policy.rules.rating-quality-upgrade.minRating",
  ratingTargetProfile: "policy.rules.rating-quality-upgrade.targetQualityProfile",
  staleMaxPlays: "policy.rules.stale-monitoring-cleanup.maxPlays",
  staleMinDaysSinceLastViewed: "policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed",
  staleProtectRating: "policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove",
  staleRequireCoverage: "policy.rules.stale-monitoring-cleanup.requireTrackCoverage",
  staleMinTrackFiles: "policy.rules.stale-monitoring-cleanup.minTrackFileCount",
  seedMinRating: "policy.rules.discovery-seed.minRating",
  seedMinPlays: "policy.rules.discovery-seed.minPlays",
} as const;

/**
 * §16.3's cap ranking, per rule, as printable text.
 *
 * Echoed on every `cohort-cap-exceeded` skip because the ranking deliberately
 * differs from the report's display order, and an operator who cannot see that
 * will read the cut as arbitrary.
 */
export const POLICY_CAP_RANKING = {
  "rating-quality-upgrade": "rating desc, lidarrId asc",
  "stale-monitoring-cleanup": "plays asc, lidarrId asc",
  "discovery-seed": "rating desc, plays desc, plexId asc",
} as const;

/** `POLICY_SKIP_ORDER` as a rank lookup. */
const SKIP_PRECEDENCE: ReadonlyMap<PolicySkipCode, number> = new Map(
  POLICY_SKIP_ORDER.map((code, index) => [code, index] as const),
);

/** One detected reason a subject cannot be proposed. */
export interface PolicyBlockingCause {
  readonly code: PolicySkipCode;
  readonly detail: string;
  readonly checks?: readonly PolicyThresholdCheck[];
}

/** A proposal plus the evidence its rule's cap cut ranks on (§16.3). */
export interface RankedPolicyProposal {
  readonly proposal: PolicyProposal;
  /** Star rating, or -1 when unrated, so rated candidates always outrank. */
  readonly rating: number;
  /** Observed plays, or -1 when unobserved. */
  readonly plays: number;
  /** Lidarr artist id, or 0 for an inert seed that has no Lidarr counterpart. */
  readonly lidarrId: number;
  readonly plexId: string;
}

/**
 * Picks the cause that comes first in `POLICY_SKIP_ORDER`.
 *
 * A subject may be blocked by more than one cause. Reporting the
 * precedence-first one is what makes an emitted skip code deterministic across
 * runs instead of an artifact of gate ordering. Ties keep evaluation order.
 *
 * @param causes - Every cause detected for one subject, in evaluation order.
 * @returns The first blocking cause, or undefined when nothing blocked.
 */
export function selectBlockingCause(
  causes: readonly PolicyBlockingCause[],
): PolicyBlockingCause | undefined {
  let best: PolicyBlockingCause | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const cause of causes) {
    const rank = SKIP_PRECEDENCE.get(cause.code) ?? Number.MAX_SAFE_INTEGER;
    if (rank < bestRank) {
      best = cause;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Indexes gathered Lidarr artists by their internal id.
 *
 * @param artists - The gathered library-wide artist list.
 * @returns Artists keyed by `id`.
 */
export function indexLidarrArtists(
  artists: readonly LidarrArtist[],
): ReadonlyMap<number, LidarrArtist> {
  const byId = new Map<number, LidarrArtist>();
  for (const artist of artists) {
    byId.set(artist.id, artist);
  }
  return byId;
}

/**
 * Reads the star-scale rating back off an evaluated rating check.
 *
 * The star projection is owned by `checkArtistRating`; reading it back here
 * keeps the normalized-to-star conversion in exactly one place.
 *
 * @param check - A check produced by `checkArtistRating`.
 * @returns The star rating, or null when the artist is unrated.
 */
export function starsOf(check: PolicyThresholdCheck): number | null {
  return typeof check.observed === "number" ? check.observed : null;
}

/**
 * Projects an evaluated rating check onto an observation.
 *
 * @param check - A check produced by `checkArtistRating`.
 * @returns An `exact-plex-id` observation, or the `unrated` gap.
 */
export function ratingObservation(check: PolicyThresholdCheck): PolicyObservation<number> {
  const stars = starsOf(check);
  return stars === null
    ? { status: "unavailable", reason: "unrated" }
    : { status: "observed", value: stars, join: "exact-plex-id" };
}

/**
 * Builds the skip for the first blocking cause detected against a link.
 *
 * @param ruleId - The rule emitting the refusal.
 * @param link - The authoritative link behind the subject.
 * @param cause - The selected blocking cause.
 * @returns The frozen skip.
 */
export function skipForLink(
  ruleId: PolicyRuleId,
  link: PolicyIdentityLink,
  cause: PolicyBlockingCause,
): PolicySkip {
  const subject: PolicySubject = {
    kind: "artist",
    name: link.lidarrTitle,
    plexId: link.plexId,
    artistId: link.lidarrId,
    artistMbid: link.artistMbid,
  };
  return createPolicySkip({
    ruleId,
    code: cause.code,
    subject,
    identity: { category: "authoritative", reason: "unique-exact-mbid" },
    checks: cause.checks ?? [],
    detail: cause.detail,
  });
}

/**
 * Applies a rule's proposal cap, cutting by evidence strength (§16.3).
 *
 * A cap that cuts on id discards the most valuable proposals for an arbitrary
 * reason, so the cut is computed on a ranked copy. The survivors are then
 * emitted in their ORIGINAL iteration order: the ranking governs the cut alone
 * and never the report's display order.
 *
 * @param input - The ranked cohort, the cap, and the rule's comparator.
 * @returns The surviving proposals and one `cohort-cap-exceeded` skip per cut.
 */
export function applyCohortCap(input: {
  readonly ranked: readonly RankedPolicyProposal[];
  readonly cap: number;
  readonly ruleId: PolicyRuleId;
  readonly rankingLabel: string;
  readonly compare: (left: RankedPolicyProposal, right: RankedPolicyProposal) => number;
}): { readonly proposals: readonly PolicyProposal[]; readonly skips: readonly PolicySkip[] } {
  if (input.ranked.length <= input.cap) {
    return { proposals: input.ranked.map((entry) => entry.proposal), skips: [] };
  }

  const survivors = new Set(
    [...input.ranked]
      .sort(input.compare)
      .slice(0, input.cap)
      .map((entry) => entry.proposal.key),
  );

  const proposals: PolicyProposal[] = [];
  const skips: PolicySkip[] = [];
  for (const entry of input.ranked) {
    if (survivors.has(entry.proposal.key)) {
      proposals.push(entry.proposal);
      continue;
    }
    skips.push(
      createPolicySkip({
        ruleId: input.ruleId,
        code: "cohort-cap-exceeded",
        subject: entry.proposal.subject,
        identity: entry.proposal.identity,
        checks: entry.proposal.checks,
        detail: `cohort cap of ${input.cap} reached; the cut ranks by ${input.rankingLabel}, which is not the report's display order`,
      }),
    );
  }
  return { proposals, skips };
}
