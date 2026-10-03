/**
 * The decision matrix (issue #209, design §14.2 — CRITICAL).
 *
 * Pure, zero network, zero mocks: every fixture is a frozen literal and the
 * indexes are built by the real `./policy-signals.js` join layer, so the branded
 * `PolicyIdentityLink` is minted the same way production mints it. Tests are
 * written against the design's bullets, not against the implementation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationAmbiguousItem,
  ReconciliationAuthoritativeItem,
  ReconciliationNormalizedNameReviewItem,
  ReconciliationPlexOnlyItem,
  ReconciliationSourceUnmatchedItem,
  ReconciliationTargetUnmatchedItem,
} from "../../types/bridge.js";
import type { LidarrArtist, LidarrProfile } from "../../types/lidarr.js";
import type {
  PolicyEvaluationInput,
  PolicyProposal,
  PolicyResolvedDiscoverySeed,
  PolicyResolvedPolicy,
  PolicyResolvedRatingQualityUpgrade,
  PolicyResolvedStaleMonitoring,
  PolicyRuleOutcome,
  PolicyRuleVerdict,
  PolicySignalBundle,
  PolicySkip,
} from "../../types/lidarr-policy.js";
import type { MediaArtist, MediaTrack } from "../../types/media-server.js";
import { mapPlexTrack } from "../adapters/plex/mappers.js";
import { isPlexWireTrack } from "../adapters/plex/types.js";
import {
  evaluateDiscoverySeed,
  evaluateRatingQualityUpgrade,
  evaluateStaleMonitoringCleanup,
} from "./policy-rules.js";
import { fingerprintPolicyProposal } from "./policy-overrides.js";
import {
  buildPolicyEvaluationCoverage,
  indexArtistRatings,
  indexAuthoritativeIdentities,
  indexTrackPlays,
} from "./policy-signals.js";

/* ── Identifiers ─────────────────────────────────────────────────────────── */

const MBID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
  d: "44444444-4444-4444-8444-444444444444",
} as const;

const EVALUATED_AT = "2026-08-07T12:00:00.000Z";
const EVALUATED_AT_EPOCH_SECONDS = Math.floor(Date.parse(EVALUATED_AT) / 1_000);
const SECONDS_PER_DAY = 86_400;

/** Star ratings are normalized as `stars / 5` by `evaluateMediaFilterRule`. */
function stars(value: number): number {
  return value / 5;
}

/* ── Reconciliation fixtures ─────────────────────────────────────────────── */

function authoritative(
  plexId: string,
  lidarrId: number,
  title: string,
  artistMbid: string,
): ReconciliationAuthoritativeItem {
  return {
    category: "authoritative",
    reason: "unique-exact-mbid",
    method: "exact-mbid",
    source: { plexId, title, artistMbid },
    target: { lidarrId, title, artistMbid },
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function noCandidate(plexId: string, title: string): ReconciliationSourceUnmatchedItem {
  return {
    category: "unmatched",
    reason: "no-candidate",
    method: "none",
    source: { plexId, title, artistMbid: null },
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function insufficientScore(plexId: string, title: string): ReconciliationSourceUnmatchedItem {
  return {
    category: "unmatched",
    reason: "insufficient-score",
    method: "fuzzy-name",
    source: { plexId, title, artistMbid: null },
    target: null,
    score: 0.4,
    runnerUpMargin: 0.1,
    candidates: [],
  };
}

function normalizedNameReview(
  plexId: string,
  lidarrId: number,
  title: string,
): ReconciliationNormalizedNameReviewItem {
  return {
    category: "review-normalized-name",
    reason: "unique-normalized-name",
    method: "normalized-name",
    source: { plexId, title, artistMbid: null },
    target: { lidarrId, title, artistMbid: null },
    score: 1,
    runnerUpMargin: 1,
    candidates: [
      {
        rank: 1,
        target: { lidarrId, title, artistMbid: null },
        method: "normalized-name",
        score: 1,
      },
    ],
  };
}

function ambiguous(plexId: string, title: string): ReconciliationAmbiguousItem {
  return {
    category: "ambiguous",
    reason: "normalized-name-collision",
    method: "normalized-name",
    source: { plexId, title, artistMbid: null },
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function lidarrOnlyItem(lidarrId: number, title: string): ReconciliationTargetUnmatchedItem {
  return {
    category: "unmatched",
    reason: "no-authoritative-source-match",
    method: "none",
    source: null,
    target: { lidarrId, title, artistMbid: MBID.d },
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function buildReport(parts: {
  readonly matchedExact?: readonly ReconciliationAuthoritativeItem[];
  readonly reviewSuggested?: readonly ReconciliationNormalizedNameReviewItem[];
  readonly plexOnly?: readonly ReconciliationPlexOnlyItem[];
  readonly lidarrOnly?: readonly ReconciliationTargetUnmatchedItem[];
}): PlexLidarrReconciliationResultV1 {
  const matchedExact = parts.matchedExact ?? [];
  const reviewSuggested = parts.reviewSuggested ?? [];
  const plexOnly = parts.plexOnly ?? [];
  const lidarrOnly = parts.lidarrOnly ?? [];

  return {
    schema: "rfmedia.plex-lidarr-reconciliation.v1",
    scope: {
      plexOrigin: "https://plex.example.test",
      plexInstanceId: "machine-1",
      plexLibraryId: "7",
      lidarrOrigin: "https://lidarr.example.test",
      entityKind: "artist",
    },
    provenance: { source: "live", mode: "online", freshness: "fresh" },
    capturedAt: "2026-07-28T12:00:00.000Z",
    verifiedAt: "2026-07-28T12:00:00.000Z",
    completeness: {
      sourceComplete: true,
      targetComplete: true,
      resolutionsComplete: true,
      complete: true,
      sourceArtistCount: matchedExact.length + plexOnly.length,
      targetArtistCount: matchedExact.length + lidarrOnly.length,
      resolutionCount: matchedExact.length + plexOnly.length,
    },
    summary: {
      sourceArtistCount: matchedExact.length + plexOnly.length,
      targetArtistCount: matchedExact.length + lidarrOnly.length,
      primaryOutcomeCount: matchedExact.length + plexOnly.length,
      matchedExactCount: matchedExact.length,
      reviewSuggestedCount: reviewSuggested.length,
      reviewAmbiguousCount: 0,
      plexOnlyCount: plexOnly.length,
      lidarrOnlyCount: lidarrOnly.length,
      conflictCount: 0,
      unavailableCount: 0,
      duplicatesIncluded: false,
      duplicateFindingCount: 0,
      suggestionCount: 0,
    },
    matchedExact,
    reviewSuggested,
    reviewAmbiguous: [],
    plexOnly,
    lidarrOnly,
    conflicts: [],
    unavailable: [],
    duplicates: [],
    suggestions: [],
  };
}

/* ── Plex and Lidarr fixtures ────────────────────────────────────────────── */

function plexArtist(id: string, title: string, rating: number | null): MediaArtist {
  return { id, kind: "artist", title, rating, albumCount: 2 };
}

function plexTrack(
  id: string,
  artistName: string,
  playCount: number,
  lastViewedAt?: number,
): MediaTrack {
  return {
    id,
    kind: "track",
    title: `track ${id}`,
    rating: null,
    artist: artistName,
    album: "Album",
    playCount,
    ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
    durationMs: 180_000,
    filePath: `/music/${artistName}/${id}.flac`,
  };
}

function lidarrArtist(
  id: number,
  artistName: string,
  artistMbid: string,
  overrides: {
    readonly monitored?: boolean;
    readonly qualityProfileId?: number;
    readonly trackFileCount?: number | "absent";
  } = {},
): LidarrArtist {
  const trackFileCount = overrides.trackFileCount ?? 12;
  return {
    id,
    artistName,
    foreignArtistId: artistMbid,
    monitored: overrides.monitored ?? true,
    qualityProfileId: overrides.qualityProfileId ?? 2,
    metadataProfileId: 1,
    tags: [],
    ...(trackFileCount === "absent"
      ? {}
      : { statistics: { albumCount: 2, trackFileCount, trackCount: 20, sizeOnDisk: 1_000 } }),
  };
}

const PROFILES: readonly LidarrProfile[] = [
  { id: 2, name: "Standard" },
  { id: 6, name: "Lossless" },
];

/* ── Resolved policy ─────────────────────────────────────────────────────── */

function resolvedPolicy(overrides: {
  readonly rating?: Partial<PolicyResolvedRatingQualityUpgrade>;
  readonly stale?: Partial<PolicyResolvedStaleMonitoring>;
  readonly seed?: Partial<PolicyResolvedDiscoverySeed>;
}): PolicyResolvedPolicy {
  return {
    plexLibrary: "Music",
    rules: {
      "rating-quality-upgrade": {
        kind: "rating-quality-upgrade",
        enabled: true,
        minRating: 4,
        targetQualityProfile: "Lossless",
        resolvedProfileId: 6,
        maxProposals: 25,
        ...overrides.rating,
      },
      "stale-monitoring-cleanup": {
        kind: "stale-monitoring-cleanup",
        enabled: true,
        maxPlays: 0,
        minDaysSinceLastViewed: null,
        protectRatingAtOrAbove: 4,
        requireTrackCoverage: true,
        minTrackFileCount: 1,
        maxProposals: 25,
        ...overrides.stale,
      },
      "discovery-seed": {
        kind: "discovery-seed",
        enabled: true,
        minRating: 5,
        minPlays: null,
        maxSeeds: 10,
        ...overrides.seed,
      },
    },
  };
}

/* ── Evaluator input ─────────────────────────────────────────────────────── */

interface Scenario {
  readonly evaluatedAt?: string;
  readonly report: PlexLidarrReconciliationResultV1;
  readonly plexArtists?: readonly MediaArtist[];
  readonly tracks?: readonly MediaTrack[];
  readonly lidarrArtists?: readonly LidarrArtist[];
  readonly profiles?: readonly LidarrProfile[];
  readonly policy?: PolicyResolvedPolicy;
  /** Drops the ratings slot, which the rating veto must refuse to guess around. */
  readonly ratingsUnavailable?: boolean;
}

function buildInput(scenario: Scenario): PolicyEvaluationInput {
  const plexArtists = scenario.plexArtists ?? [];
  const tracks = scenario.tracks ?? [];
  const signals: PolicySignalBundle = {
    bridgeIdentity: { status: "available", data: scenario.report },
    lidarrArtists: { status: "available", data: scenario.lidarrArtists ?? [] },
    lidarrQualityProfiles: { status: "available", data: scenario.profiles ?? PROFILES },
    plexArtistRatings:
      scenario.ratingsUnavailable === true
        ? { status: "unavailable", reason: "plex-not-configured", detail: "no Plex credential" }
        : { status: "available", data: plexArtists },
    plexTrackPlays: { status: "available", data: tracks },
  };

  const identity = indexAuthoritativeIdentities(scenario.report);
  return {
    evaluatedAt: scenario.evaluatedAt ?? EVALUATED_AT,
    signals,
    policy: scenario.policy ?? resolvedPolicy({}),
    coverage: buildPolicyEvaluationCoverage({ signals, identity }),
    identity,
    ratings: indexArtistRatings(scenario.ratingsUnavailable === true ? [] : plexArtists),
    plays: indexTrackPlays(tracks, identity),
    selected: new Set(["rating-quality-upgrade", "stale-monitoring-cleanup", "discovery-seed"]),
  };
}

/* ── Outcome narrowing ───────────────────────────────────────────────────── */

function verdictOf(outcome: PolicyRuleOutcome): PolicyRuleVerdict {
  if ("ruleSkip" in outcome) {
    throw new Error(`expected a verdict, got rule skip: ${outcome.ruleSkip.reason}`);
  }
  return outcome;
}

function ruleSkipOf(outcome: PolicyRuleOutcome): { reason: string; detail: string } {
  if (!("ruleSkip" in outcome)) {
    throw new Error("expected a rule-level skip, got a verdict");
  }
  return outcome.ruleSkip;
}

function keysOf(proposals: readonly PolicyProposal[]): readonly string[] {
  return proposals.map((proposal) => proposal.key);
}

/**
 * Finds the one skip a rule emitted for a SUBJECT.
 *
 * A skip key is `<ruleId>:<side>:<id>:<code>`, so these helpers take the subject
 * prefix `<ruleId>:<side>:<id>` and match on it: the code is exactly what the
 * assertion is about to check, and appending `:` keeps `…:artist:10` from
 * matching `…:artist:100:<code>`.
 */
function skipForSubject(skips: readonly PolicySkip[], subjectKey: string): PolicySkip {
  const matches = skips.filter((skip) => skip.key.startsWith(`${subjectKey}:`));
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`no skip emitted for ${subjectKey}; got ${skips.map((s) => s.key).join(", ")}`);
  }
  if (matches.length > 1) {
    throw new Error(`${matches.length} skips emitted for ${subjectKey}, expected exactly one`);
  }
  return match;
}

function skipCodeFor(skips: readonly PolicySkip[], key: string): string {
  return skipForSubject(skips, key).code;
}

function skipDetailFor(skips: readonly PolicySkip[], key: string): string {
  return skipForSubject(skips, key).detail;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── §6.1 rating-quality-upgrade ─────────────────────────────────────────── */

describe("evaluateRatingQualityUpgrade", () => {
  const scenario = (
    ratings: readonly [string, number, number | null][],
    policy?: PolicyResolvedPolicy,
  ): PolicyEvaluationInput =>
    buildInput({
      report: buildReport({
        matchedExact: ratings.map(([title, id], index) =>
          authoritative(`p${id}`, id, title, `${index}${MBID.a.slice(1)}`),
        ),
      }),
      plexArtists: ratings.map(([title, id, rating]) => plexArtist(`p${id}`, title, rating)),
      lidarrArtists: ratings.map(([title, id], index) =>
        lidarrArtist(id, title, `${index}${MBID.a.slice(1)}`),
      ),
      policy,
    });

  it("proposes at the rating floor and above it, and refuses just below it", () => {
    const verdict = verdictOf(
      evaluateRatingQualityUpgrade(
        scenario([
          ["AtFloor", 10, stars(4)],
          ["AboveFloor", 20, stars(5)],
          ["BelowFloor", 30, stars(3)],
        ]),
      ),
    );

    expect(keysOf(verdict.proposals)).toEqual([
      "rating-quality-upgrade:artist:10",
      "rating-quality-upgrade:artist:20",
    ]);
    expect(verdict.proposals.every((p) => p.code === "rating-below-target-profile")).toBe(true);
    expect(skipCodeFor(verdict.skips, "rating-quality-upgrade:artist:30")).toBe(
      "signal-unavailable",
    );
  });

  it("treats an unrated artist as signal-unavailable, never as a low rating", () => {
    const verdict = verdictOf(evaluateRatingQualityUpgrade(scenario([["Unrated", 10, null]])));

    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "rating-quality-upgrade:artist:10")).toBe(
      "signal-unavailable",
    );
    expect(skipDetailFor(verdict.skips, "rating-quality-upgrade:artist:10")).toContain("unrated");

    const ratingCheck = verdict.skips[0]?.checks[0];
    expect(ratingCheck?.observed).toBeNull();
    expect(ratingCheck?.satisfied).toBe(false);
  });

  it("reports already-converged when the artist is on the target profile", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Converged", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Converged", stars(5))],
      lidarrArtists: [lidarrArtist(10, "Converged", MBID.a, { qualityProfileId: 6 })],
    });

    const verdict = verdictOf(evaluateRatingQualityUpgrade(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "rating-quality-upgrade:artist:10")).toBe(
      "already-converged",
    );
  });

  it("refuses when the linked Lidarr artist is absent from the gathered list", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Ghost", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Ghost", stars(5))],
      lidarrArtists: [],
    });

    const verdict = verdictOf(evaluateRatingQualityUpgrade(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "rating-quality-upgrade:artist:10")).toBe(
      "signal-unavailable",
    );
  });

  it("refuses the whole rule when no target profile id is resolved", () => {
    const input = scenario(
      [["AtFloor", 10, stars(4)]],
      resolvedPolicy({ rating: { resolvedProfileId: null } }),
    );

    expect(ruleSkipOf(evaluateRatingQualityUpgrade(input)).reason).toBe("signal-unavailable");
  });

  it("emits a fully evidenced proposal with an inert profile handoff", () => {
    const verdict = verdictOf(
      evaluateRatingQualityUpgrade(scenario([["Radiohead", 41, stars(5)]])),
    );
    const proposal = verdict.proposals[0];

    expect(proposal?.before).toEqual({ qualityProfileId: 2, qualityProfileName: "Standard" });
    expect(proposal?.after).toEqual({ qualityProfileId: 6, qualityProfileName: "Lossless" });
    expect(proposal?.handoff).toEqual({
      producer: "artist-profile-assignment",
      argv: ["lidarr", "plan", "artist-profiles", "--ids", "41", "--quality-profile", "Lossless"],
    });
    expect(proposal?.checks.length).toBeGreaterThan(0);
    expect(proposal?.checks.map((check) => check.configPath)).toEqual([
      "policy.rules.rating-quality-upgrade.minRating",
      "policy.rules.rating-quality-upgrade.targetQualityProfile",
    ]);
    expect(proposal?.observations["rating"]).toEqual({
      status: "observed",
      value: 5,
      join: "exact-plex-id",
    });
  });

  it("cuts the cohort by rating, not by id, when the cap is exceeded", () => {
    const verdict = verdictOf(
      evaluateRatingQualityUpgrade(
        scenario(
          [
            ["LowerRated", 10, stars(4)],
            ["HigherRated", 20, stars(5)],
          ],
          resolvedPolicy({ rating: { maxProposals: 1 } }),
        ),
      ),
    );

    expect(keysOf(verdict.proposals)).toEqual(["rating-quality-upgrade:artist:20"]);
    expect(skipCodeFor(verdict.skips, "rating-quality-upgrade:artist:10")).toBe(
      "cohort-cap-exceeded",
    );
  });
});

/* ── §6.2 stale-monitoring-cleanup ───────────────────────────────────────── */

describe("evaluateStaleMonitoringCleanup", () => {
  it("refuses the whole rule when the library-wide play total is zero", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Silent", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Silent", null)],
      tracks: [plexTrack("t1", "Silent", 0)],
      lidarrArtists: [lidarrArtist(10, "Silent", MBID.a)],
    });

    const skip = ruleSkipOf(evaluateStaleMonitoringCleanup(input));
    expect(skip.reason).toBe("consumption-signal-empty");
    expect(skip.detail).toBe(
      "library-wide Plex play total is zero; the resolved Plex token's account may not be the listening account",
    );
  });

  it("scopes the zero-play refusal to itself: the sibling rules still propose", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [authoritative("p10", 10, "Silent", MBID.a)],
        plexOnly: [noCandidate("p90", "Duster")],
      }),
      plexArtists: [plexArtist("p10", "Silent", stars(5)), plexArtist("p90", "Duster", stars(5))],
      tracks: [plexTrack("t1", "Silent", 0)],
      lidarrArtists: [lidarrArtist(10, "Silent", MBID.a)],
    });

    expect(input.coverage.totalPlaysObserved).toBe(0);
    expect(ruleSkipOf(evaluateStaleMonitoringCleanup(input)).reason).toBe(
      "consumption-signal-empty",
    );
    expect(verdictOf(evaluateRatingQualityUpgrade(input)).proposals).toHaveLength(1);
    expect(verdictOf(evaluateDiscoverySeed(input)).proposals).toHaveLength(1);
  });

  it("preserves legacy null recency behavior at and below the play ceiling", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "AtCeiling", MBID.a),
          authoritative("p20", 20, "BelowCeiling", MBID.b),
          authoritative("p30", 30, "AboveCeiling", MBID.c),
        ],
      }),
      plexArtists: [
        plexArtist("p10", "AtCeiling", null),
        plexArtist("p20", "BelowCeiling", null),
        plexArtist("p30", "AboveCeiling", null),
      ],
      tracks: [
        plexTrack("t1", "AtCeiling", 5),
        plexTrack("t2", "BelowCeiling", 4),
        plexTrack("t3", "AboveCeiling", 6),
      ],
      lidarrArtists: [
        lidarrArtist(10, "AtCeiling", MBID.a),
        lidarrArtist(20, "BelowCeiling", MBID.b),
        lidarrArtist(30, "AboveCeiling", MBID.c),
      ],
      policy: resolvedPolicy({ stale: { maxPlays: 5 } }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(input.policy.rules["stale-monitoring-cleanup"]).toMatchObject({
      minDaysSinceLastViewed: null,
    });
    expect(keysOf(verdict.proposals)).toEqual([
      "stale-monitoring-cleanup:artist:10",
      "stale-monitoring-cleanup:artist:20",
    ]);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:30")).toBe(
      "signal-unavailable",
    );
    for (const proposal of verdict.proposals) {
      expect(proposal.observations).not.toHaveProperty("lastViewedAt");
      expect(proposal.checks.some((check) => check.comparator === "older-than-days")).toBe(false);
    }
  });

  it("applies the recency boundary inclusively and refuses recent or future views", () => {
    const exactBoundary = EVALUATED_AT_EPOCH_SECONDS - 90 * SECONDS_PER_DAY;
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "ExactBoundary", MBID.a),
          authoritative("p20", 20, "JustRecent", MBID.b),
          authoritative("p30", 30, "Older", MBID.c),
          authoritative("p40", 40, "Future", MBID.d),
        ],
      }),
      plexArtists: [
        plexArtist("p10", "ExactBoundary", null),
        plexArtist("p20", "JustRecent", null),
        plexArtist("p30", "Older", null),
        plexArtist("p40", "Future", null),
      ],
      tracks: [
        plexTrack("t1", "ExactBoundary", 1, exactBoundary),
        plexTrack("t2", "JustRecent", 1, exactBoundary + 1),
        plexTrack("t3", "Older", 1, exactBoundary - 1),
        plexTrack("t4", "Future", 1, EVALUATED_AT_EPOCH_SECONDS + 1),
      ],
      lidarrArtists: [
        lidarrArtist(10, "ExactBoundary", MBID.a),
        lidarrArtist(20, "JustRecent", MBID.b),
        lidarrArtist(30, "Older", MBID.c),
        lidarrArtist(40, "Future", MBID.d),
      ],
      policy: resolvedPolicy({ stale: { maxPlays: 1, minDaysSinceLastViewed: 90 } }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(keysOf(verdict.proposals)).toEqual([
      "stale-monitoring-cleanup:artist:10",
      "stale-monitoring-cleanup:artist:30",
    ]);

    const exactProposal = verdict.proposals[0];
    expect(exactProposal?.observations["lastViewedAt"]).toEqual({
      status: "observed",
      value: exactBoundary,
      join: "normalized-name",
      sampleSize: 1,
    });
    expect(exactProposal?.checks.at(-1)).toEqual({
      signal: "plexTrackPlays",
      label: "lastViewedAt",
      comparator: "older-than-days",
      bound: 90,
      observed: new Date(exactBoundary * 1_000).toISOString(),
      satisfied: true,
      configPath: "policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed",
    });

    for (const artistId of [20, 40]) {
      const skip = skipForSubject(verdict.skips, `stale-monitoring-cleanup:artist:${artistId}`);
      expect(skip.code).toBe("signal-unavailable");
      expect(skip.checks.at(-1)).toMatchObject({
        comparator: "older-than-days",
        bound: 90,
        satisfied: false,
        configPath: "policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed",
      });
    }
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
  ])(
    "excludes a last-viewed row with a %s play count before stale-rule evaluation",
    (_case, viewCount) => {
      const oldView = EVALUATED_AT_EPOCH_SECONDS - 120 * SECONDS_PER_DAY;
      const guardedTracks = [
        {
          ratingKey: "t1",
          title: "Broken",
          grandparentTitle: "Broken",
          ...(viewCount === undefined ? {} : { viewCount }),
          lastViewedAt: oldView,
        },
        {
          ratingKey: "t2",
          title: "Witness",
          grandparentTitle: "Witness",
          viewCount: 1,
          lastViewedAt: oldView,
        },
      ]
        .filter(isPlexWireTrack)
        .map(mapPlexTrack);
      const input = buildInput({
        report: buildReport({
          matchedExact: [
            authoritative("p10", 10, "Broken", MBID.a),
            authoritative("p20", 20, "Witness", MBID.b),
          ],
        }),
        plexArtists: [plexArtist("p10", "Broken", null), plexArtist("p20", "Witness", null)],
        tracks: guardedTracks,
        lidarrArtists: [lidarrArtist(10, "Broken", MBID.a), lidarrArtist(20, "Witness", MBID.b)],
        policy: resolvedPolicy({ stale: { maxPlays: 1, minDaysSinceLastViewed: 90 } }),
      });

      const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
      expect(keysOf(verdict.proposals)).toEqual(["stale-monitoring-cleanup:artist:20"]);
      expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
        "no-consumption-coverage",
      );
    },
  );

  it("refuses missing and partial recency with their exact observation gaps", () => {
    const oldView = EVALUATED_AT_EPOCH_SECONDS - 120 * SECONDS_PER_DAY;
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "Missing", MBID.a),
          authoritative("p20", 20, "Partial", MBID.b),
        ],
      }),
      plexArtists: [plexArtist("p10", "Missing", null), plexArtist("p20", "Partial", null)],
      tracks: [
        plexTrack("t1", "Missing", 1),
        plexTrack("t2", "Partial", 1, oldView),
        plexTrack("t3", "Partial", 1),
      ],
      lidarrArtists: [lidarrArtist(10, "Missing", MBID.a), lidarrArtist(20, "Partial", MBID.b)],
      policy: resolvedPolicy({ stale: { maxPlays: 2, minDaysSinceLastViewed: 90 } }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toContain(
      "no-recency-coverage",
    );
    expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:20")).toContain(
      "partial-recency-coverage",
    );
  });

  it("keeps rating and play-ceiling refusals ahead of unavailable recency", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "Protected", MBID.a),
          authoritative("p20", 20, "OverPlayed", MBID.b),
        ],
      }),
      plexArtists: [
        plexArtist("p10", "Protected", stars(5)),
        plexArtist("p20", "OverPlayed", null),
      ],
      tracks: [plexTrack("t1", "Protected", 1), plexTrack("t2", "OverPlayed", 2)],
      lidarrArtists: [
        lidarrArtist(10, "Protected", MBID.a),
        lidarrArtist(20, "OverPlayed", MBID.b),
      ],
      policy: resolvedPolicy({ stale: { maxPlays: 1, minDaysSinceLastViewed: 90 } }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "rating-protected",
    );
    expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).not.toContain(
      "recency-coverage",
    );
    expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:20")).toContain(
      "2 Plex plays exceed",
    );
    expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:20")).not.toContain(
      "recency-coverage",
    );
  });

  it("keeps the evidence fingerprint stable when only evaluation time advances", () => {
    const lastViewedAt = EVALUATED_AT_EPOCH_SECONDS - 100 * SECONDS_PER_DAY;
    const baseScenario: Scenario = {
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Old View", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Old View", null)],
      tracks: [plexTrack("t1", "Old View", 1, lastViewedAt)],
      lidarrArtists: [lidarrArtist(10, "Old View", MBID.a)],
      policy: resolvedPolicy({ stale: { maxPlays: 1, minDaysSinceLastViewed: 90 } }),
    };
    const first = verdictOf(
      evaluateStaleMonitoringCleanup(buildInput({ ...baseScenario, evaluatedAt: EVALUATED_AT })),
    ).proposals[0];
    const later = verdictOf(
      evaluateStaleMonitoringCleanup(
        buildInput({
          ...baseScenario,
          evaluatedAt: new Date(
            (EVALUATED_AT_EPOCH_SECONDS + SECONDS_PER_DAY) * 1_000,
          ).toISOString(),
        }),
      ),
    ).proposals[0];
    if (first === undefined || later === undefined) {
      throw new Error("expected qualifying proposals at both evaluation instants");
    }

    expect(later.summary).not.toBe(first.summary);
    const scope = {
      plexOrigin: "https://plex.example.test",
      lidarrOrigin: "https://lidarr.example.test",
      plexLibrary: "Music",
    };
    expect(fingerprintPolicyProposal(later, scope)).toBe(fingerprintPolicyProposal(first, scope));
  });

  it.each(["not-an-instant", "9999"])(
    "fails closed when recency is configured with invalid evaluation instant %s",
    (evaluatedAt) => {
      const input = buildInput({
        evaluatedAt,
        report: buildReport({ matchedExact: [authoritative("p10", 10, "Old View", MBID.a)] }),
        plexArtists: [plexArtist("p10", "Old View", null)],
        tracks: [plexTrack("t1", "Old View", 1, EVALUATED_AT_EPOCH_SECONDS)],
        lidarrArtists: [lidarrArtist(10, "Old View", MBID.a)],
        policy: resolvedPolicy({ stale: { maxPlays: 1, minDaysSinceLastViewed: 90 } }),
      });

      const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
      expect(verdict.proposals).toHaveLength(0);
      expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
        "signal-unavailable",
      );
      expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toContain(
        "invalid evaluatedAt",
      );
    },
  );

  it("vetoes a highly rated zero-play artist with rating-protected", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "Beloved", MBID.a),
          authoritative("p20", 20, "Noisy", MBID.b),
          authoritative("p30", 30, "AtProtectedFloor", MBID.c),
          authoritative("p40", 40, "BelowProtectedFloor", MBID.d),
        ],
      }),
      plexArtists: [
        plexArtist("p10", "Beloved", stars(5)),
        plexArtist("p20", "Noisy", null),
        plexArtist("p30", "AtProtectedFloor", stars(4)),
        plexArtist("p40", "BelowProtectedFloor", stars(3)),
      ],
      tracks: [
        plexTrack("t1", "Beloved", 0),
        plexTrack("t2", "Noisy", 9),
        plexTrack("t3", "AtProtectedFloor", 0),
        plexTrack("t4", "BelowProtectedFloor", 0),
      ],
      lidarrArtists: [
        lidarrArtist(10, "Beloved", MBID.a),
        lidarrArtist(20, "Noisy", MBID.b),
        lidarrArtist(30, "AtProtectedFloor", MBID.c),
        lidarrArtist(40, "BelowProtectedFloor", MBID.d),
      ],
    });

    // The protected floor is INCLUSIVE, as `protectRatingAtOrAbove` promises:
    // artist 30 sits exactly at the default floor of 4 and must be vetoed, while
    // artist 40 one star below it stays proposable. A `>` comparator would
    // un-protect artist 30 and surface it here.
    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(keysOf(verdict.proposals)).toEqual(["stale-monitoring-cleanup:artist:40"]);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "rating-protected",
    );
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:30")).toBe(
      "rating-protected",
    );
  });

  it("refuses rather than proceeding blind when the ratings slot is unavailable", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Beloved", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Beloved", stars(5))],
      tracks: [plexTrack("t1", "Beloved", 3)],
      lidarrArtists: [lidarrArtist(10, "Beloved", MBID.a)],
      policy: resolvedPolicy({ stale: { maxPlays: 5 } }),
      ratingsUnavailable: true,
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "signal-unavailable",
    );
  });

  it("refuses an artist whose Lidarr statistics block is absent, never reading it as zero", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "FreshlyAdded", MBID.a)] }),
      plexArtists: [plexArtist("p10", "FreshlyAdded", null)],
      tracks: [plexTrack("t1", "FreshlyAdded", 0), plexTrack("t2", "Decoy", 7)],
      lidarrArtists: [lidarrArtist(10, "FreshlyAdded", MBID.a, { trackFileCount: "absent" })],
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "signal-unavailable",
    );
    expect(skipDetailFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toContain(
      "lidarr-statistics-absent",
    );
  });

  it("refuses an artist still being acquired: trackFileCount below the floor", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Acquiring", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Acquiring", null)],
      tracks: [plexTrack("t1", "Acquiring", 0), plexTrack("t2", "Decoy", 7)],
      lidarrArtists: [lidarrArtist(10, "Acquiring", MBID.a, { trackFileCount: 0 })],
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "no-consumption-coverage",
    );
  });

  it("refuses an artist with zero joined tracks while requireTrackCoverage is true", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Unjoined", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Unjoined", null)],
      tracks: [plexTrack("t1", "Decoy", 7)],
      lidarrArtists: [lidarrArtist(10, "Unjoined", MBID.a)],
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "no-consumption-coverage",
    );
  });

  it("reads zero joined tracks as zero plays only once the coverage gate is disabled", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Unjoined", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Unjoined", null)],
      tracks: [plexTrack("t1", "Decoy", 7)],
      lidarrArtists: [lidarrArtist(10, "Unjoined", MBID.a)],
      policy: resolvedPolicy({ stale: { requireTrackCoverage: false } }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(keysOf(verdict.proposals)).toEqual(["stale-monitoring-cleanup:artist:10"]);
  });

  it("refuses an ambiguous normalized-name join", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [authoritative("p10", 10, "Duster", MBID.a)],
        reviewSuggested: [normalizedNameReview("p99", 99, "duster")],
      }),
      plexArtists: [plexArtist("p10", "Duster", null)],
      tracks: [plexTrack("t1", "Duster", 4)],
      lidarrArtists: [lidarrArtist(10, "Duster", MBID.a)],
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "ambiguous-name-join",
    );
  });

  it("hard-refuses a lidarrOnly artist with no-consumption-coverage", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [authoritative("p10", 10, "Played", MBID.a)],
        lidarrOnly: [lidarrOnlyItem(77, "OrphanedInLidarr")],
      }),
      plexArtists: [plexArtist("p10", "Played", null)],
      tracks: [plexTrack("t1", "Played", 9)],
      lidarrArtists: [
        lidarrArtist(10, "Played", MBID.a),
        lidarrArtist(77, "OrphanedInLidarr", MBID.d),
      ],
      policy: resolvedPolicy({ stale: { maxPlays: 20 } }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:77")).toBe(
      "no-consumption-coverage",
    );
    expect(keysOf(verdict.proposals)).toEqual(["stale-monitoring-cleanup:artist:10"]);
  });

  it("reports already-converged for an artist that is already unmonitored", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "Unmonitored", MBID.a)] }),
      plexArtists: [plexArtist("p10", "Unmonitored", stars(2))],
      tracks: [plexTrack("t1", "Unmonitored", 0), plexTrack("t2", "Decoy", 7)],
      lidarrArtists: [lidarrArtist(10, "Unmonitored", MBID.a, { monitored: false })],
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "already-converged",
    );
  });

  it("reports the POLICY_SKIP_ORDER-first cause when two causes apply", () => {
    const input = buildInput({
      report: buildReport({ matchedExact: [authoritative("p10", 10, "TwoCauses", MBID.a)] }),
      plexArtists: [plexArtist("p10", "TwoCauses", stars(2))],
      tracks: [plexTrack("t1", "TwoCauses", 0), plexTrack("t2", "Decoy", 7)],
      lidarrArtists: [
        lidarrArtist(10, "TwoCauses", MBID.a, { monitored: false, trackFileCount: 0 }),
      ],
    });

    // `already-converged` and `no-consumption-coverage` both apply; the latter
    // is earlier in POLICY_SKIP_ORDER, so it is the reported code.
    expect(
      skipCodeFor(
        verdictOf(evaluateStaleMonitoringCleanup(input)).skips,
        "stale-monitoring-cleanup:artist:10",
      ),
    ).toBe("no-consumption-coverage");
  });

  it("emits a fully evidenced proposal with an inert monitoring handoff", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [authoritative("p29104", 233, "Generic Chillhop", MBID.a)],
      }),
      plexArtists: [plexArtist("p29104", "Generic Chillhop", null)],
      tracks: [plexTrack("t1", "Generic Chillhop", 0), plexTrack("t2", "Decoy", 7)],
      lidarrArtists: [lidarrArtist(233, "Generic Chillhop", MBID.a, { trackFileCount: 22 })],
    });

    const proposal = verdictOf(evaluateStaleMonitoringCleanup(input)).proposals[0];
    expect(proposal?.code).toBe("monitored-artist-unconsumed");
    expect(proposal?.before).toEqual({ monitored: true });
    expect(proposal?.after).toEqual({ monitored: false });
    expect(proposal?.handoff).toEqual({
      producer: "artist-monitoring",
      argv: ["lidarr", "plan", "artist-monitoring", "--ids", "233", "--unmonitored"],
    });
    expect(proposal?.checks.length).toBeGreaterThan(0);

    const structural = proposal?.checks.filter((check) => check.configPath === null) ?? [];
    expect(structural.map((check) => check.label)).toEqual(["monitored"]);
    for (const check of proposal?.checks ?? []) {
      if (check.configPath !== null) {
        expect(check.configPath).toMatch(/^policy\.rules\.stale-monitoring-cleanup\.[A-Za-z]+$/);
      }
    }
    expect(proposal?.observations["trackFileCount"]).toEqual({
      status: "observed",
      value: 22,
      join: "exact-artist-mbid",
    });
    expect(proposal?.observations["rating"]).toEqual({ status: "unavailable", reason: "unrated" });
  });

  it("cuts the cohort by least-consumed first, not by id, when the cap is exceeded", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "MorePlayed", MBID.a),
          authoritative("p20", 20, "LessPlayed", MBID.b),
        ],
      }),
      plexArtists: [plexArtist("p10", "MorePlayed", null), plexArtist("p20", "LessPlayed", null)],
      tracks: [plexTrack("t1", "MorePlayed", 5), plexTrack("t2", "LessPlayed", 1)],
      lidarrArtists: [
        lidarrArtist(10, "MorePlayed", MBID.a),
        lidarrArtist(20, "LessPlayed", MBID.b),
      ],
      policy: resolvedPolicy({
        stale: { maxPlays: 10, maxProposals: 1 },
      }),
    });

    const verdict = verdictOf(evaluateStaleMonitoringCleanup(input));
    expect(keysOf(verdict.proposals)).toEqual(["stale-monitoring-cleanup:artist:20"]);
    expect(skipCodeFor(verdict.skips, "stale-monitoring-cleanup:artist:10")).toBe(
      "cohort-cap-exceeded",
    );
  });
});

/* ── §6.3 discovery-seed ─────────────────────────────────────────────────── */

describe("evaluateDiscoverySeed", () => {
  it("seeds only from no-candidate members, never from review or ambiguous ones", () => {
    const input = buildInput({
      report: buildReport({
        plexOnly: [
          noCandidate("p1", "Duster"),
          insufficientScore("p2", "Fuzzy Match"),
          ambiguous("p3", "Collided"),
          normalizedNameReview("p4", 44, "Review Grade"),
        ],
      }),
      plexArtists: [
        plexArtist("p1", "Duster", stars(5)),
        plexArtist("p2", "Fuzzy Match", stars(5)),
        plexArtist("p3", "Collided", stars(5)),
        plexArtist("p4", "Review Grade", stars(5)),
      ],
    });

    const verdict = verdictOf(evaluateDiscoverySeed(input));
    expect(keysOf(verdict.proposals)).toEqual(["discovery-seed:plex:p1"]);
    expect(verdict.skips).toHaveLength(0);
  });

  it("proposes at the rating floor and refuses just below it", () => {
    const input = buildInput({
      report: buildReport({
        plexOnly: [noCandidate("p1", "AtFloor"), noCandidate("p2", "BelowFloor")],
      }),
      plexArtists: [
        plexArtist("p1", "AtFloor", stars(5)),
        plexArtist("p2", "BelowFloor", stars(4)),
      ],
    });

    const verdict = verdictOf(evaluateDiscoverySeed(input));
    expect(keysOf(verdict.proposals)).toEqual(["discovery-seed:plex:p1"]);
    expect(skipCodeFor(verdict.skips, "discovery-seed:plex:p2")).toBe("signal-unavailable");
  });

  it("skips an unobservable play total when minPlays is set", () => {
    const input = buildInput({
      report: buildReport({ plexOnly: [noCandidate("p1", "NoTracks")] }),
      plexArtists: [plexArtist("p1", "NoTracks", stars(5))],
      policy: resolvedPolicy({ seed: { minPlays: 25 } }),
    });

    const verdict = verdictOf(evaluateDiscoverySeed(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "discovery-seed:plex:p1")).toBe("signal-unavailable");
  });

  it("refuses an observed play total that falls below minPlays", () => {
    const input = buildInput({
      report: buildReport({ plexOnly: [noCandidate("p1", "LowPlays")] }),
      plexArtists: [plexArtist("p1", "LowPlays", stars(5))],
      tracks: [plexTrack("t1", "LowPlays", 3), plexTrack("t2", "LowPlays", 4)],
      policy: resolvedPolicy({ seed: { minPlays: 25 } }),
    });

    const verdict = verdictOf(evaluateDiscoverySeed(input));
    expect(verdict.proposals).toHaveLength(0);
    expect(skipCodeFor(verdict.skips, "discovery-seed:plex:p1")).toBe("signal-unavailable");
    expect(skipDetailFor(verdict.skips, "discovery-seed:plex:p1")).toBe(
      "7 Plex plays are below the configured floor of 25",
    );
    expect(verdict.skips[0]?.checks.map((check) => check.configPath)).toEqual([
      "policy.rules.discovery-seed.minPlays",
    ]);
  });

  it("ignores an unobservable play total when minPlays is not set", () => {
    const input = buildInput({
      report: buildReport({ plexOnly: [noCandidate("p1", "NoTracks")] }),
      plexArtists: [plexArtist("p1", "NoTracks", stars(5))],
    });

    const verdict = verdictOf(evaluateDiscoverySeed(input));
    expect(keysOf(verdict.proposals)).toEqual(["discovery-seed:plex:p1"]);
  });

  it("emits an inert seed that can never be routed to a mutation producer", () => {
    const input = buildInput({
      report: buildReport({ plexOnly: [noCandidate("p1", "Duster")] }),
      plexArtists: [plexArtist("p1", "Duster", stars(5))],
      tracks: [plexTrack("t1", "Duster", 30)],
    });

    const proposal = verdictOf(evaluateDiscoverySeed(input)).proposals[0];
    expect(proposal?.code).toBe("high-signal-discovery-seed");
    expect(proposal?.subject.artistId).toBeUndefined();
    expect(proposal?.before).toEqual({ inLidarr: false });
    expect(proposal?.after).toEqual({ inLidarr: false });
    expect(proposal?.handoff).toEqual({
      producer: "discovery",
      argv: ["lidarr", "discover", "--artist", "Duster"],
    });
    expect(proposal?.checks.length).toBeGreaterThan(0);
    expect(proposal?.checks[0]?.configPath).toBe("policy.rules.discovery-seed.minRating");
  });

  it("cuts the seed cohort by rating then plays, not by plex id", () => {
    const input = buildInput({
      report: buildReport({
        plexOnly: [noCandidate("p1", "LowerRated"), noCandidate("p2", "HigherRated")],
      }),
      plexArtists: [
        plexArtist("p1", "LowerRated", stars(4)),
        plexArtist("p2", "HigherRated", stars(5)),
      ],
      policy: resolvedPolicy({ seed: { minRating: 4, maxSeeds: 1 } }),
    });

    const verdict = verdictOf(evaluateDiscoverySeed(input));
    expect(keysOf(verdict.proposals)).toEqual(["discovery-seed:plex:p2"]);
    expect(skipCodeFor(verdict.skips, "discovery-seed:plex:p1")).toBe("cohort-cap-exceeded");
  });
});

/* ── Standing mutation-boundary invariant (§7.1 item 5) ──────────────────── */

describe("policy rule handoffs", () => {
  it("never emit an apply verb or a --plan-file argument", () => {
    const input = buildInput({
      report: buildReport({
        matchedExact: [
          authoritative("p10", 10, "Upgradeable", MBID.a),
          authoritative("p20", 20, "Unconsumed", MBID.b),
        ],
        plexOnly: [noCandidate("p90", "Seedable")],
        lidarrOnly: [lidarrOnlyItem(77, "OrphanedInLidarr")],
      }),
      plexArtists: [
        plexArtist("p10", "Upgradeable", stars(5)),
        plexArtist("p20", "Unconsumed", stars(2)),
        plexArtist("p90", "Seedable", stars(5)),
      ],
      tracks: [plexTrack("t1", "Unconsumed", 0), plexTrack("t2", "Upgradeable", 12)],
      lidarrArtists: [
        lidarrArtist(10, "Upgradeable", MBID.a),
        lidarrArtist(20, "Unconsumed", MBID.b),
      ],
    });

    const proposals = [
      ...verdictOf(evaluateRatingQualityUpgrade(input)).proposals,
      ...verdictOf(evaluateStaleMonitoringCleanup(input)).proposals,
      ...verdictOf(evaluateDiscoverySeed(input)).proposals,
    ];

    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(proposal.handoff.argv).not.toContain("apply");
      expect(proposal.handoff.argv).not.toContain("--plan-file");
    }
  });
});
