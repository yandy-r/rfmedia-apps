/**
 * The `stale-monitoring-cleanup` evaluator (issue #209, design §6.2, §8.4,
 * §16.4).
 *
 * The only rule in the design with real blast radius. Every gate here fails
 * CLOSED, and no absent signal is ever coerced to a zero that would read as
 * evidence of non-consumption.
 */

import type {
  PolicyEvaluationInput,
  PolicyObservation,
  PolicyResolvedPolicy,
  PolicyResolvedStaleMonitoring,
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
  createPolicySkip,
  requireSignal,
} from "./policy-rule-support.js";
import { lookupArtistLastViewedAt, lookupArtistPlays } from "./policy-signals.js";

const RULE_ID: PolicyRuleId = "stale-monitoring-cleanup";
const SECONDS_PER_DAY = 86_400;

/** §6.2 rule-level gate detail, verbatim. It reaches an output field. */
const EMPTY_CONSUMPTION_DETAIL =
  "library-wide Plex play total is zero; the resolved Plex token's account may not be the listening account";

/** §6.0 hard-refusal detail for a Lidarr artist with no Plex counterpart. */
const LIDARR_ONLY_DETAIL =
  "artist has no Plex counterpart at all, so it has produced no consumption evidence; absence of evidence is never evidence of non-consumption";

/**
 * The one `ReconciliationReason` carried exclusively by
 * `ReconciliationTargetUnmatchedItem`, i.e. by `report.lidarrOnly`.
 *
 * `PolicyIdentityIndex.nonAuthoritative` already projects every refused subject
 * exactly once, so filtering it on this reason recovers the `lidarrOnly` cohort
 * without re-projecting subjects out of the raw reconciliation report.
 */
const LIDARR_ONLY_REASON = "no-authoritative-source-match";

/**
 * Unwraps the resolved `stale-monitoring-cleanup` configuration.
 *
 * @param policy - The resolved policy echoed in the report.
 * @returns The rule's resolved configuration.
 * @throws {Error} When the engine bound a different rule's configuration.
 */
function requireStalePolicy(policy: PolicyResolvedPolicy): PolicyResolvedStaleMonitoring {
  const resolved = policy.rules[RULE_ID];
  if (resolved.kind !== "stale-monitoring-cleanup") {
    throw new Error(`policy rule ${RULE_ID} resolved to ${resolved.kind} configuration`);
  }
  return resolved;
}

/**
 * Proposes unmonitoring for monitored artists with no demonstrated consumption.
 *
 * Safety gates, all fail-closed:
 *
 * - Rule-level (§6.2, §16.4): a library-wide play total of zero refuses the
 *   WHOLE rule with `consumption-signal-empty` — the signature of a token whose
 *   Plex account is not the listening account. The gate is rule-scoped; a
 *   zero-play library still lets the other two rules evaluate and propose.
 * - §6.0: a `lidarrOnly` artist — one with no Plex counterpart at all — is
 *   hard-refused with `no-consumption-coverage`.
 * - Gate 1 (rating veto): an unavailable ratings slot, or an artist missing from
 *   it, refuses with `signal-unavailable` rather than proceeding blind.
 * - Gate 2 (coverage): `requireTrackCoverage` turns "no joined tracks" into
 *   `no-consumption-coverage` instead of a silent zero.
 * - Gate 3 (acquisition, §8.4): an ABSENT `LidarrArtist.statistics` block is
 *   `signal-unavailable` (`lidarr-statistics-absent`) and is NEVER coerced to
 *   zero, which would make the gate fail OPEN on exactly the freshly-added
 *   artists it exists to protect.
 * - Final recency gate: when configured, a trustworthy latest view must be at
 *   least the resolved whole-day threshold old at the captured evaluation time.
 *
 * @param input - Everything the engine gathered and indexed.
 * @returns The rule's proposals and refusals, or a rule-level skip.
 */
export function evaluateStaleMonitoringCleanup(input: PolicyEvaluationInput): PolicyRuleOutcome {
  if (input.coverage.totalPlaysObserved === 0) {
    return { ruleSkip: { reason: "consumption-signal-empty", detail: EMPTY_CONSUMPTION_DETAIL } };
  }

  const config = requireStalePolicy(input.policy);
  const parsedEvaluatedAtMilliseconds = Date.parse(input.evaluatedAt);
  const recencyClock =
    config.minDaysSinceLastViewed === null
      ? null
      : {
          evaluatedAtEpochSeconds:
            Number.isFinite(parsedEvaluatedAtMilliseconds) &&
            new Date(parsedEvaluatedAtMilliseconds).toISOString() === input.evaluatedAt
              ? parsedEvaluatedAtMilliseconds / 1_000
              : null,
          thresholdDays: config.minDaysSinceLastViewed,
        };
  const artistsById = indexLidarrArtists(
    requireSignal(input.signals.lidarrArtists, RULE_ID, "lidarrArtists"),
  );
  const ratingsAvailable = input.signals.plexArtistRatings.status === "available";

  const skips: PolicySkip[] = [];
  for (const refused of input.identity.nonAuthoritative) {
    if (refused.identity.reason !== LIDARR_ONLY_REASON) {
      continue;
    }
    skips.push(
      createPolicySkip({
        ruleId: RULE_ID,
        code: "no-consumption-coverage",
        subject: refused.subject,
        identity: refused.identity,
        detail: LIDARR_ONLY_DETAIL,
      }),
    );
  }

  const ranked: RankedPolicyProposal[] = [];

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

    const causes: PolicyBlockingCause[] = [];
    const checks: PolicyThresholdCheck[] = [];

    // Step 2 — monitoring state. A structural gate, so `configPath` is null.
    const monitoredCheck: PolicyThresholdCheck = {
      signal: "lidarrArtists",
      label: "monitored",
      comparator: "==",
      bound: true,
      observed: artist.monitored,
      satisfied: artist.monitored === true,
      configPath: null,
    };
    checks.push(monitoredCheck);
    if (!monitoredCheck.satisfied) {
      causes.push({
        code: "already-converged",
        detail: "artist is already unmonitored in Lidarr",
        checks: [monitoredCheck],
      });
    }

    // Step 3 — play observation, carrying all three fail-closed poisonings.
    const playsObservation = lookupArtistPlays(input.plays, link);
    let plays: number | null = null;
    if (playsObservation.status === "observed") {
      plays = playsObservation.value;
      checks.push({
        signal: "plexTrackPlays",
        label: "track coverage",
        comparator: ">=",
        bound: 1,
        observed: playsObservation.sampleSize ?? 0,
        satisfied: true,
        configPath: POLICY_CONFIG_PATH.staleRequireCoverage,
      });
    } else if (
      playsObservation.reason === "ambiguous-name-join" ||
      playsObservation.reason === "sentinel-artist-name"
    ) {
      causes.push({
        code: "ambiguous-name-join",
        detail: `${playsObservation.reason}: the normalized artist name yields no trustworthy play total`,
      });
    } else if (config.requireTrackCoverage) {
      causes.push({
        code: "no-consumption-coverage",
        detail: `${playsObservation.reason}: no Plex track joined this artist, so "no plays" cannot be read as "not consumed"`,
        checks: [
          {
            signal: "plexTrackPlays",
            label: "track coverage",
            comparator: ">=",
            bound: 1,
            observed: 0,
            satisfied: false,
            configPath: POLICY_CONFIG_PATH.staleRequireCoverage,
          },
        ],
      });
    } else {
      // The operator disabled gate 2 deliberately: with no joined tracks and no
      // coverage requirement, an absent observation IS the zero-play reading the
      // gate exists to prevent. Nothing else reaches this branch — the other two
      // gaps already produced a cause above.
      plays = 0;
    }

    // Step 4 — the rating veto. Always active (the config schema admits 1.0-5.0
    // only, so there is no disabling value). It refuses rather than guessing.
    let ratingCheck: PolicyThresholdCheck | undefined;
    const plexArtist = ratingsAvailable ? input.ratings.byPlexId.get(link.plexId) : undefined;
    if (plexArtist === undefined) {
      causes.push({
        code: "signal-unavailable",
        detail: ratingsAvailable
          ? `no-plex-artist: Plex artist ${link.plexId} carries no gathered rating record, so the rating veto cannot be evaluated`
          : "the Plex artist ratings signal is unavailable, so the rating veto cannot be evaluated",
      });
    } else {
      ratingCheck = checkArtistRating(
        plexArtist,
        ">=",
        config.protectRatingAtOrAbove,
        POLICY_CONFIG_PATH.staleProtectRating,
      );
      checks.push(ratingCheck);
      if (ratingCheck.satisfied) {
        causes.push({
          code: "rating-protected",
          detail: `Plex rating ${starsOf(ratingCheck) ?? "unrated"} is at or above the protected floor of ${config.protectRatingAtOrAbove} stars`,
          checks: [ratingCheck],
        });
      }
    }

    // Step 5 — the acquisition gate. An absent statistics block is a refusal.
    if (config.minTrackFileCount > 0) {
      const statistics = artist.statistics;
      if (statistics === undefined) {
        causes.push({
          code: "signal-unavailable",
          detail:
            "lidarr-statistics-absent: Lidarr reported no statistics block for this artist, which is never read as zero files",
        });
      } else {
        const fileCheck: PolicyThresholdCheck = {
          signal: "lidarrArtists",
          label: "trackFileCount",
          comparator: ">=",
          bound: config.minTrackFileCount,
          observed: statistics.trackFileCount,
          satisfied: statistics.trackFileCount >= config.minTrackFileCount,
          configPath: POLICY_CONFIG_PATH.staleMinTrackFiles,
        };
        checks.push(fileCheck);
        if (!fileCheck.satisfied) {
          causes.push({
            code: "no-consumption-coverage",
            detail: `Lidarr holds ${statistics.trackFileCount} track file(s), below the acquisition floor of ${config.minTrackFileCount}`,
            checks: [fileCheck],
          });
        }
      }
    }

    const blocking = selectBlockingCause(causes);
    if (blocking !== undefined) {
      skips.push(skipForLink(RULE_ID, link, blocking));
      continue;
    }

    // Step 6 — the play ceiling. `plays` is non-null here by construction: every
    // unavailable observation produced a cause above, except the deliberate
    // gate-2-disabled zero. The guard is belt-and-braces, never a fallback.
    if (plays === null) {
      skips.push(
        skipForLink(RULE_ID, link, {
          code: "signal-unavailable",
          detail: "no trustworthy Plex play total could be observed for this artist",
        }),
      );
      continue;
    }

    const playsCheck: PolicyThresholdCheck = {
      signal: "plexTrackPlays",
      label: "plays",
      comparator: "<=",
      bound: config.maxPlays,
      observed: plays,
      satisfied: plays <= config.maxPlays,
      configPath: POLICY_CONFIG_PATH.staleMaxPlays,
    };
    checks.push(playsCheck);
    if (!playsCheck.satisfied) {
      skips.push(
        skipForLink(RULE_ID, link, {
          code: "signal-unavailable",
          detail: `${plays} Plex plays exceed the configured ceiling of ${config.maxPlays}`,
          checks: [playsCheck],
        }),
      );
      continue;
    }

    // Step 7 — optional recency conjunct. Every earlier safety gate, including
    // the absolute play ceiling, has already had precedence. The raw timestamp
    // and configured day count are stable fingerprint material; the moving age
    // is reserved for summary prose.
    let lastViewedAtObservation: PolicyObservation<number> | undefined;
    let daysSinceLastViewed: number | undefined;
    if (recencyClock !== null) {
      if (recencyClock.evaluatedAtEpochSeconds === null) {
        skips.push(
          skipForLink(RULE_ID, link, {
            code: "signal-unavailable",
            detail: `invalid evaluatedAt for recency evaluation: ${input.evaluatedAt}`,
          }),
        );
        continue;
      }
      lastViewedAtObservation = lookupArtistLastViewedAt(input.plays, link);
      if (lastViewedAtObservation.status === "unavailable") {
        skips.push(
          skipForLink(RULE_ID, link, {
            code: "signal-unavailable",
            detail: `${lastViewedAtObservation.reason}: no trustworthy Plex last-viewed timestamp is available for this artist`,
          }),
        );
        continue;
      }

      const observedIso = new Date(lastViewedAtObservation.value * 1_000).toISOString();
      const elapsedSeconds = recencyClock.evaluatedAtEpochSeconds - lastViewedAtObservation.value;
      const recencyCheck: PolicyThresholdCheck = {
        signal: "plexTrackPlays",
        label: "lastViewedAt",
        comparator: "older-than-days",
        bound: recencyClock.thresholdDays,
        observed: observedIso,
        satisfied: elapsedSeconds >= recencyClock.thresholdDays * SECONDS_PER_DAY,
        configPath: POLICY_CONFIG_PATH.staleMinDaysSinceLastViewed,
      };
      checks.push(recencyCheck);
      if (!recencyCheck.satisfied) {
        skips.push(
          skipForLink(RULE_ID, link, {
            code: "signal-unavailable",
            detail: `latest Plex view ${observedIso} is less than ${recencyClock.thresholdDays} whole days before evaluation ${input.evaluatedAt}`,
            checks: [recencyCheck],
          }),
        );
        continue;
      }
      daysSinceLastViewed = Math.floor(elapsedSeconds / SECONDS_PER_DAY);
    }

    const stars = ratingCheck === undefined ? null : starsOf(ratingCheck);
    const proposal = createPolicyProposal({
      ruleId: RULE_ID,
      code: "monitored-artist-unconsumed",
      link,
      before: { monitored: true },
      after: { monitored: false },
      checks,
      observations: {
        plays: playsObservation,
        rating:
          ratingCheck === undefined
            ? { status: "unavailable", reason: "unrated" }
            : ratingObservation(ratingCheck),
        monitored: { status: "observed", value: true, join: "exact-artist-mbid" },
        trackFileCount:
          artist.statistics === undefined
            ? { status: "unavailable", reason: "lidarr-statistics-absent" }
            : {
                status: "observed",
                value: artist.statistics.trackFileCount,
                join: "exact-artist-mbid",
              },
        ...(lastViewedAtObservation === undefined ? {} : { lastViewedAt: lastViewedAtObservation }),
      },
      summary: `${plays} plays and ${stars === null ? "unrated" : `rated ${stars} stars`} in Plex while monitored in Lidarr.${daysSinceLastViewed === undefined ? "" : ` Last viewed ${daysSinceLastViewed} whole days before evaluation.`}`,
      handoff: buildPolicyHandoff("artist-monitoring", [
        "lidarr",
        "plan",
        "artist-monitoring",
        "--ids",
        String(link.lidarrId),
        "--unmonitored",
      ]),
    });

    ranked.push({
      proposal,
      rating: stars ?? -1,
      plays,
      lidarrId: link.lidarrId,
      plexId: link.plexId,
    });
  }

  const capped = applyCohortCap({
    ranked,
    cap: config.maxProposals,
    ruleId: RULE_ID,
    rankingLabel: POLICY_CAP_RANKING["stale-monitoring-cleanup"],
    compare: (left, right) => left.plays - right.plays || left.lidarrId - right.lidarrId,
  });

  return { proposals: capped.proposals, skips: [...skips, ...capped.skips] };
}
