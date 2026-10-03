/**
 * The `discovery-seed` evaluator (issue #209, design §6.3).
 *
 * Emits INERT seeds only. This module makes no Last.fm call, constructs no
 * client, registers no fetch owner, and every proposal it mints goes through
 * `createPolicySeedProposal`, whose `handoff.producer` is fixed to `"discovery"`
 * and whose subject carries no `artistId` — so a seed can never be routed to a
 * mutation producer.
 */

import type {
  PolicyEvaluationInput,
  PolicyObservation,
  PolicyPlayIndex,
  PolicyResolvedDiscoverySeed,
  PolicyResolvedPolicy,
  PolicyRuleId,
  PolicyRuleOutcome,
  PolicySkip,
  PolicySubject,
  PolicyThresholdCheck,
} from "../../types/lidarr-policy.js";
import { normalizeBridgeArtistName } from "./artist-name.js";
import {
  applyCohortCap,
  POLICY_CAP_RANKING,
  POLICY_CONFIG_PATH,
  ratingObservation,
  selectBlockingCause,
  starsOf,
  type PolicyBlockingCause,
  type RankedPolicyProposal,
} from "./policy-rule-shared.js";
import {
  checkArtistRating,
  createPolicySeedProposal,
  createPolicySkip,
} from "./policy-rule-support.js";

const RULE_ID: PolicyRuleId = "discovery-seed";

/** Normalized form of the `mapPlexTrack` `"Unknown Artist"` fallback bucket. */
const SENTINEL_ARTIST_KEY = normalizeBridgeArtistName("Unknown Artist");

/**
 * Unwraps the resolved `discovery-seed` configuration.
 *
 * @param policy - The resolved policy echoed in the report.
 * @returns The rule's resolved configuration.
 * @throws {Error} When the engine bound a different rule's configuration.
 */
function requireSeedPolicy(policy: PolicyResolvedPolicy): PolicyResolvedDiscoverySeed {
  const resolved = policy.rules[RULE_ID];
  if (resolved.kind !== "discovery-seed") {
    throw new Error(`policy rule ${RULE_ID} resolved to ${resolved.kind} configuration`);
  }
  return resolved;
}

/**
 * Reads a Plex-only subject's play total off the weak normalized-name join.
 *
 * `lookupArtistPlays` requires the branded `PolicyIdentityLink`, which a
 * discovery seed can never have — it has no Lidarr counterpart at all. This
 * mirrors that lookup over a raw Plex title, applying the same fail-closed
 * poisonings: the sentinel bucket, then any key claimed by two or more Plex
 * artists, then the honest absence of coverage.
 *
 * @param plays - The play index.
 * @param plexTitle - The Plex artist title to observe.
 * @returns The observation, carrying `sampleSize` when observed.
 */
function lookupSeedPlays(plays: PolicyPlayIndex, plexTitle: string): PolicyObservation<number> {
  const key = normalizeBridgeArtistName(plexTitle);
  if (key === SENTINEL_ARTIST_KEY) {
    return { status: "unavailable", reason: "sentinel-artist-name" };
  }
  if (plays.poisoned.has(key)) {
    return { status: "unavailable", reason: "ambiguous-name-join" };
  }
  const bucket = plays.byNormalizedName.get(key);
  if (bucket === undefined) {
    return { status: "unavailable", reason: "no-track-coverage" };
  }
  return {
    status: "observed",
    value: bucket.plays,
    join: "normalized-name",
    sampleSize: bucket.sampleSize,
  };
}

/**
 * Offers high-signal Plex artists that Lidarr has no candidate for as seeds.
 *
 * Candidates come EXCLUSIVELY from `PolicyIdentityIndex.seedCandidates`, which
 * is narrowed at the type level to `reason: "no-candidate"` — the one honest
 * "absent from Lidarr" signal. Review, ambiguous, conflict, and unavailable
 * `plexOnly` members probably already exist in Lidarr under a slightly
 * different name and are never seeded.
 *
 * `minPlays` nuance (§6.3): an unavailable play observation SKIPS the candidate
 * when `minPlays` is configured, and is IGNORED when it is not.
 *
 * @param input - Everything the engine gathered and indexed.
 * @returns The rule's inert seeds and refusals.
 */
export function evaluateDiscoverySeed(input: PolicyEvaluationInput): PolicyRuleOutcome {
  const config = requireSeedPolicy(input.policy);

  const ranked: RankedPolicyProposal[] = [];
  const skips: PolicySkip[] = [];

  for (const candidate of input.identity.seedCandidates) {
    const subject: PolicySubject = {
      kind: "artist",
      name: candidate.source.title,
      plexId: candidate.source.plexId,
      artistMbid: candidate.source.artistMbid,
    };
    const identity = { category: candidate.category, reason: candidate.reason };
    const refuse = (cause: PolicyBlockingCause): void => {
      skips.push(
        createPolicySkip({
          ruleId: RULE_ID,
          code: cause.code,
          subject,
          identity,
          checks: cause.checks ?? [],
          detail: cause.detail,
        }),
      );
    };

    const plexArtist = input.ratings.byPlexId.get(candidate.source.plexId);
    if (plexArtist === undefined) {
      refuse({
        code: "signal-unavailable",
        detail: `no-plex-artist: Plex artist ${candidate.source.plexId} carries no gathered rating record`,
      });
      continue;
    }

    const ratingCheck = checkArtistRating(
      plexArtist,
      ">=",
      config.minRating,
      POLICY_CONFIG_PATH.seedMinRating,
    );
    const stars = starsOf(ratingCheck);
    const playsObservation = lookupSeedPlays(input.plays, candidate.source.title);

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

    const checks: PolicyThresholdCheck[] = [ratingCheck];
    if (config.minPlays !== null) {
      if (playsObservation.status !== "observed") {
        causes.push({
          code: "signal-unavailable",
          detail: `${playsObservation.reason}: no trustworthy Plex play total backs the configured minPlays floor`,
        });
      } else {
        const playsCheck: PolicyThresholdCheck = {
          signal: "plexTrackPlays",
          label: "plays",
          comparator: ">=",
          bound: config.minPlays,
          observed: playsObservation.value,
          satisfied: playsObservation.value >= config.minPlays,
          configPath: POLICY_CONFIG_PATH.seedMinPlays,
        };
        checks.push(playsCheck);
        if (!playsCheck.satisfied) {
          causes.push({
            code: "signal-unavailable",
            detail: `${playsObservation.value} Plex plays are below the configured floor of ${config.minPlays}`,
            checks: [playsCheck],
          });
        }
      }
    }

    const blocking = selectBlockingCause(causes);
    if (blocking !== undefined) {
      refuse(blocking);
      continue;
    }

    const playsText =
      playsObservation.status === "observed"
        ? `${playsObservation.value} plays`
        : "no joined plays";
    const proposal = createPolicySeedProposal({
      subject,
      identity,
      checks,
      observations: { rating: ratingObservation(ratingCheck), plays: playsObservation },
      summary: `Rated ${stars} stars in Plex with ${playsText} and no Lidarr candidate at all.`,
      seedArtistName: candidate.source.title,
    });

    ranked.push({
      proposal,
      rating: stars ?? -1,
      plays: playsObservation.status === "observed" ? playsObservation.value : -1,
      lidarrId: 0,
      plexId: candidate.source.plexId,
    });
  }

  const capped = applyCohortCap({
    ranked,
    cap: config.maxSeeds,
    ruleId: RULE_ID,
    rankingLabel: POLICY_CAP_RANKING["discovery-seed"],
    compare: (left, right) =>
      right.rating - left.rating ||
      right.plays - left.plays ||
      left.plexId.localeCompare(right.plexId),
  });

  return { proposals: capped.proposals, skips: [...skips, ...capped.skips] };
}
