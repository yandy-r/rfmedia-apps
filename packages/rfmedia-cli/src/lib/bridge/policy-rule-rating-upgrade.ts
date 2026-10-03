/**
 * The `rating-quality-upgrade` evaluator (issue #209, design §6.1).
 *
 * Pure and synchronous: already-materialised indexes in, decisions out. Every
 * proposal is minted by `createPolicyProposal`, which requires the branded
 * `PolicyIdentityLink`, so review-grade name evidence cannot reach a
 * mutation-bound decision (§8.3).
 */

import type { LidarrProfile } from "../../types/lidarr.js";
import type {
  PolicyEvaluationInput,
  PolicyResolvedPolicy,
  PolicyResolvedRatingQualityUpgrade,
  PolicyRuleId,
  PolicyRuleOutcome,
  PolicySkip,
  PolicyThresholdCheck,
} from "../../types/lidarr-policy.js";
import {
  applyCohortCap,
  indexLidarrArtists,
  POLICY_CAP_RANKING,
  POLICY_CONFIG_PATH,
  ratingObservation,
  selectBlockingCause,
  skipForLink,
  starsOf,
  type PolicyBlockingCause,
  type RankedPolicyProposal,
} from "./policy-rule-shared.js";
import {
  buildPolicyHandoff,
  checkArtistRating,
  createPolicyProposal,
  requireSignal,
} from "./policy-rule-support.js";
import { lookupArtistPlays } from "./policy-signals.js";

const RULE_ID: PolicyRuleId = "rating-quality-upgrade";

/**
 * Indexes gathered Lidarr quality profiles by their internal id.
 *
 * @param profiles - The gathered quality-profile list.
 * @returns Profiles keyed by `id`.
 */
function indexQualityProfiles(
  profiles: readonly LidarrProfile[],
): ReadonlyMap<number, LidarrProfile> {
  const byId = new Map<number, LidarrProfile>();
  for (const profile of profiles) {
    byId.set(profile.id, profile);
  }
  return byId;
}

/**
 * Unwraps the resolved `rating-quality-upgrade` configuration.
 *
 * @param policy - The resolved policy echoed in the report.
 * @returns The rule's resolved configuration.
 * @throws {Error} When the engine bound a different rule's configuration.
 */
function requireRatingPolicy(policy: PolicyResolvedPolicy): PolicyResolvedRatingQualityUpgrade {
  const resolved = policy.rules[RULE_ID];
  if (resolved.kind !== "rating-quality-upgrade") {
    throw new Error(`policy rule ${RULE_ID} resolved to ${resolved.kind} configuration`);
  }
  return resolved;
}

/**
 * Proposes a quality-profile upgrade for demonstrably highly-rated artists.
 *
 * Per §6.1, in order: an absent `LidarrArtist` and an absent `MediaArtist` are
 * both `signal-unavailable`; an UNRATED artist is `signal-unavailable`
 * (`unrated`), never a low rating; a below-floor rating is `signal-unavailable`
 * with the check attached; an artist already on the target profile is
 * `already-converged`.
 *
 * §16.1 is NOT implemented here. This rule CONSUMES `resolvedProfileId` and
 * never resolves a profile NAME; the engine gates the rule before dispatch when
 * a configured `targetQualityProfile` resolves to nothing. The guards below are
 * defensive only and deliberately carry no available-profile-names detail.
 *
 * @param input - Everything the engine gathered and indexed.
 * @returns The rule's proposals and refusals, or a rule-level skip.
 */
export function evaluateRatingQualityUpgrade(input: PolicyEvaluationInput): PolicyRuleOutcome {
  const config = requireRatingPolicy(input.policy);
  if (config.resolvedProfileId === null) {
    return {
      ruleSkip: {
        reason: "signal-unavailable",
        detail: "no target quality profile is resolved for rating-quality-upgrade",
      },
    };
  }

  const artistsById = indexLidarrArtists(
    requireSignal(input.signals.lidarrArtists, RULE_ID, "lidarrArtists"),
  );
  const profilesById = indexQualityProfiles(
    requireSignal(input.signals.lidarrQualityProfiles, RULE_ID, "lidarrQualityProfiles"),
  );

  const targetProfile = profilesById.get(config.resolvedProfileId);
  if (targetProfile === undefined) {
    return {
      ruleSkip: {
        reason: "signal-unavailable",
        detail: `resolved quality profile id ${config.resolvedProfileId} is absent from the gathered Lidarr quality profiles`,
      },
    };
  }

  const ranked: RankedPolicyProposal[] = [];
  const skips: PolicySkip[] = [];

  for (const link of input.identity.links) {
    const artist = artistsById.get(link.lidarrId);
    if (artist === undefined) {
      skips.push(
        skipForLink(RULE_ID, link, {
          code: "signal-unavailable",
          detail: `Lidarr artist ${link.lidarrId} is absent from the gathered artist list`,
        }),
      );
      continue;
    }

    const plexArtist = input.ratings.byPlexId.get(link.plexId);
    if (plexArtist === undefined) {
      skips.push(
        skipForLink(RULE_ID, link, {
          code: "signal-unavailable",
          detail: `no-plex-artist: Plex artist ${link.plexId} carries no gathered rating record`,
        }),
      );
      continue;
    }

    const ratingCheck = checkArtistRating(
      plexArtist,
      ">=",
      config.minRating,
      POLICY_CONFIG_PATH.ratingMinRating,
    );
    const stars = starsOf(ratingCheck);

    const causes: PolicyBlockingCause[] = [];
    if (stars === null) {
      causes.push({
        code: "signal-unavailable",
        detail:
          "unrated: the artist carries no Plex rating, which is no signal rather than a low rating",
        checks: [ratingCheck],
      });
    } else if (!ratingCheck.satisfied) {
      causes.push({
        code: "signal-unavailable",
        detail: `Plex rating ${stars} is below the configured floor of ${config.minRating} stars`,
        checks: [ratingCheck],
      });
    }

    const profileCheck: PolicyThresholdCheck = {
      signal: "lidarrQualityProfiles",
      label: "qualityProfileId",
      comparator: "!=",
      bound: config.resolvedProfileId,
      observed: artist.qualityProfileId,
      satisfied: artist.qualityProfileId !== config.resolvedProfileId,
      configPath: POLICY_CONFIG_PATH.ratingTargetProfile,
    };
    if (!profileCheck.satisfied) {
      causes.push({
        code: "already-converged",
        detail: `artist is already assigned quality profile "${targetProfile.name}"`,
        checks: [profileCheck],
      });
    }

    const blocking = selectBlockingCause(causes);
    if (blocking !== undefined) {
      skips.push(skipForLink(RULE_ID, link, blocking));
      continue;
    }

    const currentProfile = profilesById.get(artist.qualityProfileId);
    const playsObservation = lookupArtistPlays(input.plays, link);
    const proposal = createPolicyProposal({
      ruleId: RULE_ID,
      code: "rating-below-target-profile",
      link,
      before: {
        qualityProfileId: artist.qualityProfileId,
        qualityProfileName: currentProfile?.name ?? null,
      },
      after: { qualityProfileId: targetProfile.id, qualityProfileName: targetProfile.name },
      checks: [ratingCheck, profileCheck],
      observations: { rating: ratingObservation(ratingCheck), plays: playsObservation },
      summary: `Rated ${stars} stars in Plex while assigned quality profile "${currentProfile?.name ?? artist.qualityProfileId}" instead of "${targetProfile.name}".`,
      handoff: buildPolicyHandoff("artist-profile-assignment", [
        "lidarr",
        "plan",
        "artist-profiles",
        "--ids",
        String(link.lidarrId),
        "--quality-profile",
        targetProfile.name,
      ]),
    });

    ranked.push({
      proposal,
      rating: stars ?? -1,
      plays: playsObservation.status === "observed" ? playsObservation.value : -1,
      lidarrId: link.lidarrId,
      plexId: link.plexId,
    });
  }

  const capped = applyCohortCap({
    ranked,
    cap: config.maxProposals,
    ruleId: RULE_ID,
    rankingLabel: POLICY_CAP_RANKING["rating-quality-upgrade"],
    compare: (left, right) => right.rating - left.rating || left.lidarrId - right.lidarrId,
  });

  return { proposals: capped.proposals, skips: [...skips, ...capped.skips] };
}
