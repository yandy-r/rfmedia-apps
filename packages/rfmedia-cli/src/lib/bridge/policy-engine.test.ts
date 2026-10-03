/**
 * The five structural guarantees (issue #209, design §14.3 — CRITICAL).
 *
 * Four of the five are invisible in a happy-path run, which is exactly why they
 * ship pinned: they are what a `--json` consumer relies on. Everything here is
 * pure — frozen literal fixtures, real evaluators, real join layer — with a
 * single mock seam: `./policy-rules.js` is replaced by pass-through spies so ONE
 * test can make an evaluator throw. No snapshots.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { policyDecisionKeys } from "../../commands/lidarr-policy-presenter.js";
import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationAuthoritativeItem,
  ReconciliationNormalizedNameReviewItem,
  ReconciliationSourceUnmatchedItem,
  ReconciliationTargetUnmatchedItem,
} from "../../types/bridge.js";
import type { PolicyConfigOptions } from "../../types/config.js";
import type { LidarrArtist, LidarrProfile } from "../../types/lidarr.js";
import {
  POLICY_MAX_SKIPS_PER_RULE,
  POLICY_RULE_IDS,
  shouldFailPolicyEvaluation,
  type PolicyDecisionEvidenceFingerprint,
  type PolicyEvaluationReport,
  type PolicyRuleEvaluator,
  type PolicyRuleId,
  type PolicySignalBundle,
  type PolicySignalSlot,
  type PolicySignalUnavailableReason,
  type PolicySkip,
} from "../../types/lidarr-policy.js";
import type { MediaArtist, MediaTrack } from "../../types/media-server.js";
import {
  resolvePolicyConfig,
  runLidarrPolicyEvaluation,
  type PolicyEvaluationOverrides,
} from "./policy-engine.js";
import { createPolicySkip } from "./policy-rule-support.js";

/* ── The one mock seam ───────────────────────────────────────────────────── */

const ruleMocks = vi.hoisted(() => ({
  ratingQualityUpgrade: vi.fn<PolicyRuleEvaluator>(),
  staleMonitoringCleanup: vi.fn<PolicyRuleEvaluator>(),
  discoverySeed: vi.fn<PolicyRuleEvaluator>(),
}));

vi.mock("./policy-rules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy-rules.js")>();
  ruleMocks.ratingQualityUpgrade.mockImplementation(actual.evaluateRatingQualityUpgrade);
  ruleMocks.staleMonitoringCleanup.mockImplementation(actual.evaluateStaleMonitoringCleanup);
  ruleMocks.discoverySeed.mockImplementation(actual.evaluateDiscoverySeed);
  return {
    evaluateRatingQualityUpgrade: ruleMocks.ratingQualityUpgrade,
    evaluateStaleMonitoringCleanup: ruleMocks.staleMonitoringCleanup,
    evaluateDiscoverySeed: ruleMocks.discoverySeed,
  };
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const MBID = {
  radiohead: "11111111-1111-4111-8111-111111111111",
  portishead: "22222222-2222-4222-8222-222222222222",
  duster: "33333333-3333-4333-8333-333333333333",
} as const;

/** Star ratings are normalized as `stars / 5` by `evaluateMediaFilterRule`. */
function stars(value: number): number {
  return value / 5;
}

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

const MATCHED_EXACT: readonly ReconciliationAuthoritativeItem[] = [
  authoritative("10", 41, "Radiohead", MBID.radiohead),
  authoritative("20", 88, "Portishead", MBID.portishead),
  authoritative("30", 12, "Duster", MBID.duster),
];

const REVIEW_SUGGESTED: readonly ReconciliationNormalizedNameReviewItem[] = [
  normalizedNameReview("40", 200, "Aphex Twin"),
  normalizedNameReview("50", 201, "Boards of Canada"),
];

function buildReport(): PlexLidarrReconciliationResultV1 {
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
      sourceArtistCount: 5,
      targetArtistCount: 5,
      resolutionCount: 5,
    },
    summary: {
      sourceArtistCount: 5,
      targetArtistCount: 5,
      primaryOutcomeCount: 5,
      matchedExactCount: MATCHED_EXACT.length,
      reviewSuggestedCount: REVIEW_SUGGESTED.length,
      reviewAmbiguousCount: 0,
      plexOnlyCount: 0,
      lidarrOnlyCount: 0,
      conflictCount: 0,
      unavailableCount: 0,
      duplicatesIncluded: false,
      duplicateFindingCount: 0,
      suggestionCount: 0,
    },
    matchedExact: MATCHED_EXACT,
    reviewSuggested: REVIEW_SUGGESTED,
    reviewAmbiguous: [],
    plexOnly: [],
    lidarrOnly: [],
    conflicts: [],
    unavailable: [],
    duplicates: [],
    suggestions: [],
  };
}

/** A Lidarr artist no authoritative Plex source claimed — the `lidarrOnly` gap. */
function targetUnmatched(lidarrId: number, title: string): ReconciliationTargetUnmatchedItem {
  return {
    category: "unmatched",
    reason: "no-authoritative-source-match",
    method: "none",
    source: null,
    target: { lidarrId, title, artistMbid: null },
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

/** A Plex artist Lidarr had no candidate for at all — the one honest seed signal. */
function sourceUnmatched(plexId: string, title: string): ReconciliationSourceUnmatchedItem {
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

const REPORT = buildReport();

function plexArtist(id: string, title: string, rating: number | null): MediaArtist {
  return { id, kind: "artist", title, rating, albumCount: 2 };
}

/** Radiohead is consumed, Portishead is highly rated, Duster is unrated and unplayed. */
const PLEX_ARTISTS: readonly MediaArtist[] = [
  plexArtist("10", "Radiohead", stars(5)),
  plexArtist("20", "Portishead", stars(4)),
  plexArtist("30", "Duster", null),
];

function plexTrack(id: string, artist: string, playCount: number): MediaTrack {
  return {
    id,
    kind: "track",
    title: `track ${id}`,
    rating: null,
    artist,
    album: "Album",
    playCount,
    durationMs: 180_000,
    filePath: `/music/${artist}/${id}.flac`,
  };
}

const TRACKS: readonly MediaTrack[] = [
  plexTrack("t1", "Radiohead", 5),
  plexTrack("t2", "Radiohead", 5),
  plexTrack("t3", "Duster", 0),
  plexTrack("t4", "Duster", 0),
];

function lidarrArtist(id: number, artistName: string, artistMbid: string): LidarrArtist {
  return {
    id,
    artistName,
    foreignArtistId: artistMbid,
    monitored: true,
    qualityProfileId: 2,
    metadataProfileId: 1,
    tags: [],
    statistics: { albumCount: 2, trackFileCount: 12, trackCount: 20, sizeOnDisk: 1_000 },
  };
}

const LIDARR_ARTISTS: readonly LidarrArtist[] = [
  lidarrArtist(41, "Radiohead", MBID.radiohead),
  lidarrArtist(88, "Portishead", MBID.portishead),
  lidarrArtist(12, "Duster", MBID.duster),
];

const PROFILES: readonly LidarrProfile[] = [
  { id: 2, name: "Standard" },
  { id: 6, name: "Lossless" },
];

const AVAILABLE_PROFILES: PolicySignalSlot<readonly LidarrProfile[]> = {
  status: "available",
  data: PROFILES,
};

/* ── Run harness ─────────────────────────────────────────────────────────── */

function unavailable(
  reason: PolicySignalUnavailableReason,
  detail: string,
): PolicySignalSlot<never> {
  return { status: "unavailable", reason, detail };
}

function buildSignals(overrides: Partial<PolicySignalBundle> = {}): PolicySignalBundle {
  return {
    bridgeIdentity: { status: "available", data: REPORT },
    lidarrArtists: { status: "available", data: LIDARR_ARTISTS },
    lidarrQualityProfiles: AVAILABLE_PROFILES,
    plexArtistRatings: { status: "available", data: PLEX_ARTISTS },
    plexTrackPlays: { status: "available", data: TRACKS },
    ...overrides,
  };
}

/** Enables `rating-quality-upgrade` against the "Lossless" profile. */
function ratingEnabled(targetQualityProfile = "Lossless"): PolicyConfigOptions {
  return { rules: { "rating-quality-upgrade": { enabled: true, targetQualityProfile } } };
}

/** Enables both consumption rules, which is the two-rules-running shape §10.2 shows. */
const BOTH_ENABLED: PolicyConfigOptions = {
  rules: {
    "rating-quality-upgrade": { enabled: true, targetQualityProfile: "Lossless" },
    "stale-monitoring-cleanup": { enabled: true },
  },
};

function run(
  options: {
    readonly config?: PolicyConfigOptions;
    readonly selected?: readonly PolicyRuleId[];
    readonly signals?: Partial<PolicySignalBundle>;
    readonly overrides?: PolicyEvaluationOverrides;
  } = {},
): PolicyEvaluationReport {
  return runLidarrPolicyEvaluation({
    evaluatedAt: "2026-07-28T18:04:11.000Z",
    plexOrigin: "https://plex.example.test",
    lidarrOrigin: "https://lidarr.example.test",
    selected: new Set(options.selected ?? POLICY_RULE_IDS),
    signals: buildSignals(options.signals),
    config: options.config,
    overrides: options.overrides ?? {},
  });
}

function withSuppression(
  config: PolicyConfigOptions,
  key: string,
  evidenceFingerprint: PolicyDecisionEvidenceFingerprint,
): PolicyConfigOptions {
  return {
    ...config,
    overrides: {
      [key]: {
        action: "suppress",
        evidenceFingerprint,
        reason: "Reviewed with the library owner",
      },
    },
  };
}

function ruleResult(report: PolicyEvaluationReport, id: PolicyRuleId) {
  const result = report.rules.find((entry) => entry.id === id);
  if (result === undefined) {
    throw new Error(`rule ${id} missing from the report`);
  }
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── Guarantee 1 ─────────────────────────────────────────────────────────── */

describe("structural guarantee 1 — every registered rule appears exactly once", () => {
  it("reports all three rules on a zero-config run, in registry declaration order", () => {
    const report = run();

    expect(report.rules.map((entry) => entry.id)).toEqual([...POLICY_RULE_IDS]);
    for (const entry of report.rules) {
      expect(entry.status).toBe("skipped");
      expect(entry).toMatchObject({
        skipReason: "disabled",
        detail: `disabled in policy.rules.${entry.id}.enabled`,
      });
    }
  });

  it("reports deselected rules as not-selected rather than omitting them", () => {
    const report = run({ config: BOTH_ENABLED, selected: ["stale-monitoring-cleanup"] });

    expect(report.rules).toHaveLength(POLICY_RULE_IDS.length);
    expect(ruleResult(report, "rating-quality-upgrade")).toMatchObject({
      status: "skipped",
      skipReason: "not-selected",
    });
    expect(ruleResult(report, "discovery-seed")).toMatchObject({
      status: "skipped",
      skipReason: "not-selected",
    });
    expect(ruleResult(report, "stale-monitoring-cleanup").status).toBe("proposals");
    expect(ruleMocks.ratingQualityUpgrade).not.toHaveBeenCalled();
  });

  it("reports an errored rule without dropping its key", () => {
    ruleMocks.staleMonitoringCleanup.mockImplementationOnce(() => {
      throw new Error("evaluator exploded");
    });
    const report = run({ config: BOTH_ENABLED });

    expect(report.rules.map((entry) => entry.id)).toEqual([...POLICY_RULE_IDS]);
  });
});

/* ── Guarantee 2 ─────────────────────────────────────────────────────────── */

describe("structural guarantee 2 — requirement gating", () => {
  it("skips a rule whose required slot is unavailable, carrying that slot's reason", () => {
    const report = run({
      config: BOTH_ENABLED,
      signals: { plexTrackPlays: unavailable("data-unavailable", "Plex track drain failed") },
    });

    const stale = ruleResult(report, "stale-monitoring-cleanup");
    expect(stale).toMatchObject({ status: "skipped", skipReason: "signal-unavailable" });
    expect(stale.status === "skipped" && stale.detail).toContain("data-unavailable");
    expect(stale.status === "skipped" && stale.detail).toContain("Plex track drain failed");
  });

  it("never gates a rule on an unavailable enriching slot", () => {
    // `plexTrackPlays` only ENRICHES `rating-quality-upgrade`.
    const report = run({
      config: ratingEnabled(),
      selected: ["rating-quality-upgrade"],
      signals: { plexTrackPlays: unavailable("not-requested", "plays were not gathered") },
    });

    expect(ruleResult(report, "rating-quality-upgrade").status).toBe("proposals");
    expect(report.status).toBe("proposals");
  });

  it("degrades on a consumed slot that failed to load", () => {
    const report = run({
      config: BOTH_ENABLED,
      signals: { plexTrackPlays: unavailable("data-unavailable", "Plex track drain failed") },
    });

    expect(report.status).toBe("degraded");
  });

  it("does not degrade on an expected absence", () => {
    const report = run({
      config: ratingEnabled(),
      selected: ["rating-quality-upgrade"],
      signals: { plexArtistRatings: unavailable("plex-not-configured", "Plex is not configured") },
    });

    expect(ruleResult(report, "rating-quality-upgrade")).toMatchObject({
      status: "skipped",
      skipReason: "signal-unavailable",
    });
    expect(report.status).toBe("clean");
  });

  it("echoes slot availability verbatim in the signals map", () => {
    const report = run({
      config: BOTH_ENABLED,
      signals: { plexTrackPlays: unavailable("data-unavailable", "Plex track drain failed") },
    });

    expect(report.signals).toEqual({
      bridgeIdentity: { status: "available" },
      lidarrArtists: { status: "available" },
      lidarrQualityProfiles: { status: "available" },
      plexArtistRatings: { status: "available" },
      plexTrackPlays: { status: "unavailable", detail: "Plex track drain failed" },
    });
  });
});

/* ── Guarantee 3 ─────────────────────────────────────────────────────────── */

describe("structural guarantee 3 — a throwing evaluator costs exactly one rule", () => {
  it("converts the throw into a rule-error skip and still runs every sibling", () => {
    ruleMocks.staleMonitoringCleanup.mockImplementationOnce(() => {
      throw new Error("evaluator exploded");
    });
    const report = run({ config: BOTH_ENABLED });

    expect(ruleResult(report, "stale-monitoring-cleanup")).toMatchObject({
      status: "skipped",
      skipReason: "rule-error",
      detail: "evaluator exploded",
    });
    expect(ruleResult(report, "rating-quality-upgrade").status).toBe("proposals");
    expect(report.proposals.length).toBeGreaterThan(0);
    expect(report.status).toBe("degraded");
  });

  it("bounds a non-Error throw to a string message", () => {
    ruleMocks.ratingQualityUpgrade.mockImplementationOnce(() => {
      throw "raw string failure";
    });
    const report = run({ config: BOTH_ENABLED });

    expect(ruleResult(report, "rating-quality-upgrade")).toMatchObject({
      status: "skipped",
      skipReason: "rule-error",
      detail: "raw string failure",
    });
  });
});

/* ── Guarantee 4 ─────────────────────────────────────────────────────────── */

describe("structural guarantee 4 — status precedence degraded > proposals > clean", () => {
  it("reports clean when a rule ran and proposed nothing", () => {
    // Every artist is already on "Standard", so the rule converges without proposing.
    const report = run({
      config: ratingEnabled("Standard"),
      selected: ["rating-quality-upgrade"],
    });

    expect(ruleResult(report, "rating-quality-upgrade").status).toBe("clean");
    expect(report.summary.proposed).toBe(0);
    expect(report.status).toBe("clean");
  });

  it("reports proposals when a rule proposed and nothing failed", () => {
    expect(run({ config: BOTH_ENABLED }).status).toBe("proposals");
  });

  it("lets degraded outrank proposals", () => {
    ruleMocks.staleMonitoringCleanup.mockImplementationOnce(() => {
      throw new Error("evaluator exploded");
    });
    const report = run({ config: BOTH_ENABLED });

    expect(report.summary.proposed).toBeGreaterThan(0);
    expect(report.status).toBe("degraded");
  });
});

/* ── Guarantee 5 ─────────────────────────────────────────────────────────── */

describe("structural guarantee 5 — deterministic order and a deep-frozen report", () => {
  it("orders decisions by rule declaration order, then lidarrId, then plexId", () => {
    const report = run({ config: BOTH_ENABLED });

    expect(report.proposals.map((proposal) => proposal.key)).toEqual([
      "rating-quality-upgrade:artist:41",
      "rating-quality-upgrade:artist:88",
      "stale-monitoring-cleanup:artist:12",
    ]);

    const ruleRank = new Map(POLICY_RULE_IDS.map((id, index) => [id, index] as const));
    let previous = -1;
    for (const skip of report.skips) {
      const rank = ruleRank.get(skip.ruleId) ?? POLICY_RULE_IDS.length;
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it("produces byte-identical reports across repeated runs", () => {
    expect(JSON.stringify(run({ config: BOTH_ENABLED }))).toBe(
      JSON.stringify(run({ config: BOTH_ENABLED })),
    );
  });

  it("deep-freezes the report, including nested arrays and records", () => {
    const report = run({ config: BOTH_ENABLED });

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.rules)).toBe(true);
    expect(Object.isFrozen(report.rules[0])).toBe(true);
    expect(Object.isFrozen(report.proposals)).toBe(true);
    expect(Object.isFrozen(report.proposals[0])).toBe(true);
    expect(Object.isFrozen(report.proposals[0]?.checks)).toBe(true);
    expect(Object.isFrozen(report.proposals[0]?.before)).toBe(true);
    expect(Object.isFrozen(report.skips)).toBe(true);
    expect(Object.isFrozen(report.skips[0])).toBe(true);
    expect(Object.isFrozen(report.overrides)).toBe(true);
    expect(Object.isFrozen(report.summary)).toBe(true);
    expect(Object.isFrozen(report.coverage)).toBe(true);
    expect(Object.isFrozen(report.signals)).toBe(true);
    expect(Object.isFrozen(report.signals.bridgeIdentity)).toBe(true);
    expect(Object.isFrozen(report.policy)).toBe(true);
    expect(Object.isFrozen(report.policy.rules)).toBe(true);
    expect(Object.isFrozen(report.policy.rules["rating-quality-upgrade"])).toBe(true);
  });

  it("builds the §10.3 envelope, with coverage derived from the slots alone", () => {
    const report = run();

    expect(report).toMatchObject({
      schema: "rfmedia.lidarr-consumption-policy.v3",
      engineVersion: 3,
      evaluatedAt: "2026-07-28T18:04:11.000Z",
      plexOrigin: "https://plex.example.test",
      lidarrOrigin: "https://lidarr.example.test",
      plexLibrary: "Music",
    });
    // Every rule is disabled here, yet coverage still describes the evidence.
    expect(report.coverage).toEqual({
      plexArtistsExamined: 3,
      plexTracksExamined: 4,
      authoritativeLinks: 3,
      nonAuthoritativeArtists: 2,
      ambiguousNameArtists: 0,
      sentinelArtistTracks: 0,
      unjoinedTracks: 0,
      totalPlaysObserved: 10,
    });
    expect(report.summary).toEqual({
      proposed: 0,
      skipped: report.skips.length,
      suppressed: 0,
      staleOverrides: 0,
      notEvaluatedOverrides: 0,
      rulesRun: 0,
      rulesSkipped: 3,
    });
  });

  it("passes pinned time and the shared play/recency index to a dispatched rule", () => {
    const report = run({
      config: {
        rules: {
          "stale-monitoring-cleanup": { enabled: true, minDaysSinceLastViewed: 90 },
        },
      },
      selected: ["stale-monitoring-cleanup"],
    });

    expect(report.evaluatedAt).toBe("2026-07-28T18:04:11.000Z");
    expect(report.policy.rules["stale-monitoring-cleanup"]).toMatchObject({
      minDaysSinceLastViewed: 90,
    });
    const evaluatorInput = ruleMocks.staleMonitoringCleanup.mock.calls[0]?.[0];
    expect(evaluatorInput?.evaluatedAt).toBe(report.evaluatedAt);
    expect(evaluatorInput?.plays.byNormalizedName.get("radiohead")).toMatchObject({
      plays: 10,
      latestLastViewedAt: null,
      lastViewedAtSampleSize: 0,
    });
  });
});

/* ── Policy overrides ───────────────────────────────────────────────────── */

describe("policy override integration — one actionable cohort", () => {
  it("suppresses an exact post-cap proposal without refilling the cohort", () => {
    const firstRun = run({
      config: ratingEnabled(),
      selected: ["rating-quality-upgrade"],
      overrides: { maxProposals: 1 },
    });
    const reviewed = firstRun.proposals[0]!;
    const report = run({
      config: withSuppression(ratingEnabled(), reviewed.key, reviewed.evidenceFingerprint),
      selected: ["rating-quality-upgrade"],
      overrides: { maxProposals: 1 },
    });

    expect(report.proposals).toEqual([]);
    expect(report.skips.some((skip) => skip.code === "cohort-cap-exceeded")).toBe(true);
    expect(ruleResult(report, "rating-quality-upgrade")).toMatchObject({
      status: "clean",
      proposedCount: 0,
    });
    expect(report.summary).toMatchObject({
      proposed: 0,
      suppressed: 1,
      staleOverrides: 0,
      notEvaluatedOverrides: 0,
    });
    expect(report.overrides).toEqual([
      expect.objectContaining({
        key: reviewed.key,
        status: "suppressed",
        decision: expect.objectContaining({
          key: reviewed.key,
          evidenceFingerprint: reviewed.evidenceFingerprint,
        }),
      }),
    ]);
    expect(report.status).toBe("clean");
    expect(shouldFailPolicyEvaluation(report, "proposals")).toBe(false);
    expect(Object.isFrozen(report.overrides)).toBe(true);
    expect(Object.isFrozen(report.overrides[0])).toBe(true);
    expect(Object.isFrozen(report.overrides[0]?.decision)).toBe(true);
  });

  it("withholds stale evidence, retains unrelated proposals, and rebuilds per-rule counts", () => {
    const firstRun = run({ config: BOTH_ENABLED });
    const disputed = firstRun.proposals[0]!;
    const report = run({
      config: withSuppression(
        BOTH_ENABLED,
        disputed.key,
        `sha256:${"0".repeat(64)}` as PolicyDecisionEvidenceFingerprint,
      ),
    });

    expect(report.proposals.map((proposal) => proposal.key)).toEqual([
      "rating-quality-upgrade:artist:88",
      "stale-monitoring-cleanup:artist:12",
    ]);
    expect(ruleResult(report, "rating-quality-upgrade")).toMatchObject({
      status: "proposals",
      proposedCount: 1,
    });
    expect(ruleResult(report, "stale-monitoring-cleanup")).toMatchObject({
      status: "proposals",
      proposedCount: 1,
    });
    expect(report.overrides[0]).toMatchObject({
      key: disputed.key,
      status: "stale",
      staleReason: "evidence-changed",
      decision: { key: disputed.key },
    });
    expect(report.summary).toMatchObject({ proposed: 2, suppressed: 0, staleOverrides: 1 });
  });

  it("keeps a stale-only report clean-looking but trips fail-on proposals after rendering", () => {
    const firstRun = run({
      config: ratingEnabled(),
      selected: ["rating-quality-upgrade"],
      overrides: { maxProposals: 1 },
    });
    const disputed = firstRun.proposals[0]!;
    const report = run({
      config: withSuppression(
        ratingEnabled(),
        disputed.key,
        `sha256:${"f".repeat(64)}` as PolicyDecisionEvidenceFingerprint,
      ),
      selected: ["rating-quality-upgrade"],
      overrides: { maxProposals: 1 },
    });

    expect(report.proposals).toEqual([]);
    expect(report.summary.staleOverrides).toBe(1);
    expect(report.status).toBe("clean");
    expect(shouldFailPolicyEvaluation(report, "proposals")).toBe(true);
  });

  it("counts an override for a skipped rule as not evaluated", () => {
    const reviewed = run({ config: ratingEnabled() }).proposals[0]!;
    const report = run({
      config: withSuppression(ratingEnabled(), reviewed.key, reviewed.evidenceFingerprint),
      selected: ["stale-monitoring-cleanup"],
    });

    expect(report.overrides[0]).toMatchObject({
      key: reviewed.key,
      status: "not-evaluated",
      staleReason: null,
      decision: null,
    });
    expect(report.summary.notEvaluatedOverrides).toBe(1);
  });
});

/* ── §16.1 ───────────────────────────────────────────────────────────────── */

describe("§16.1 — an unresolvable targetQualityProfile degrades, it never throws", () => {
  it("skips only the misconfigured rule and names the available profiles", () => {
    const report = run({
      config: {
        rules: {
          "rating-quality-upgrade": { enabled: true, targetQualityProfile: "Vinyl Rip" },
          "stale-monitoring-cleanup": { enabled: true },
        },
      },
    });

    const rating = ruleResult(report, "rating-quality-upgrade");
    expect(rating).toMatchObject({ status: "skipped", skipReason: "signal-unavailable" });
    expect(rating.status === "skipped" && rating.detail).toContain("Vinyl Rip");
    expect(rating.status === "skipped" && rating.detail).toContain("Standard, Lossless");
    expect(ruleMocks.ratingQualityUpgrade).not.toHaveBeenCalled();
  });

  it("never suppresses a sibling rule and still degrades the report", () => {
    const report = run({
      config: {
        rules: {
          "rating-quality-upgrade": { enabled: true, targetQualityProfile: "Vinyl Rip" },
          "stale-monitoring-cleanup": { enabled: true },
        },
      },
    });

    expect(ruleResult(report, "stale-monitoring-cleanup").status).toBe("proposals");
    expect(report.proposals.map((proposal) => proposal.ruleId)).toEqual([
      "stale-monitoring-cleanup",
    ]);
    expect(report.status).toBe("degraded");
    expect(report.policy.rules["rating-quality-upgrade"]).toMatchObject({
      targetQualityProfile: "Vinyl Rip",
      resolvedProfileId: null,
    });
  });
});

/* ── R4 ──────────────────────────────────────────────────────────────────── */

describe("R4 — identity-not-authoritative refusals are emitted once, not per rule", () => {
  function refusals(report: PolicyEvaluationReport) {
    return report.skips.filter((skip) => skip.code === "identity-not-authoritative");
  }

  it("emits one refusal per non-authoritative subject across two running rules", () => {
    const report = run({ config: BOTH_ENABLED });
    const emitted = refusals(report);

    expect(emitted).toHaveLength(REVIEW_SUGGESTED.length);
    expect(emitted.map((skip) => skip.subject.plexId).sort()).toEqual(["40", "50"]);
    expect(report.summary.skipped).toBe(report.skips.length);
  });

  it("attributes every refusal to the first registered rule that ran", () => {
    const report = run({ config: BOTH_ENABLED });

    for (const skip of refusals(report)) {
      expect(skip.ruleId).toBe("rating-quality-upgrade");
    }
  });

  it("falls through to the next running rule when the first is disabled", () => {
    const report = run({
      config: { rules: { "stale-monitoring-cleanup": { enabled: true } } },
    });

    const emitted = refusals(report);
    expect(emitted).toHaveLength(REVIEW_SUGGESTED.length);
    for (const skip of emitted) {
      expect(skip.ruleId).toBe("stale-monitoring-cleanup");
    }
  });

  it("attributes to the first registered rule id when no rule ran", () => {
    const report = run();

    const emitted = refusals(report);
    expect(emitted).toHaveLength(REVIEW_SUGGESTED.length);
    for (const skip of emitted) {
      expect(skip.ruleId).toBe(POLICY_RULE_IDS[0]);
    }
  });

  it("keeps every refusal when the owning rule alone exhausts the per-rule skip bound", () => {
    // A rule emits one skip per authoritative link, so any real library with more
    // matched artists than the bound trips this. The refusals must not be the rows
    // that get cut — `coverage.nonAuthoritativeArtists` would report N while the
    // report carried zero of them.
    const bulk: readonly PolicySkip[] = Array.from(
      { length: POLICY_MAX_SKIPS_PER_RULE + 100 },
      (_unused, index) =>
        createPolicySkip({
          ruleId: "rating-quality-upgrade",
          code: "already-converged",
          subject: {
            kind: "artist",
            name: `Bulk ${index}`,
            plexId: `bulk-${index}`,
            artistId: 10_000 + index,
            artistMbid: null,
          },
          identity: { category: "authoritative", reason: "unique-exact-mbid" },
          detail: "already on the target profile",
        }),
    );
    ruleMocks.ratingQualityUpgrade.mockImplementationOnce(() => ({ proposals: [], skips: bulk }));

    const report = run({ config: BOTH_ENABLED });
    const owned = report.skips.filter((skip) => skip.ruleId === "rating-quality-upgrade");

    expect(refusals(report)).toHaveLength(REVIEW_SUGGESTED.length);
    expect(report.coverage.nonAuthoritativeArtists).toBe(REVIEW_SUGGESTED.length);
    // The rule's OWN skips are still bounded; the refusals ride on top of the bound.
    expect(owned).toHaveLength(POLICY_MAX_SKIPS_PER_RULE + REVIEW_SUGGESTED.length);
    expect(report.summary.skipped).toBe(report.skips.length);
  });
});

/* ── Decision-key totality ───────────────────────────────────────────────── */

describe("decision keys — one key, one decision", () => {
  function keys(report: PolicyEvaluationReport): readonly string[] {
    return policyDecisionKeys(report);
  }

  it("separates a lidarrOnly rule skip from the §6.0 refusal for the same artist", () => {
    // `stale-monitoring-cleanup` refuses every lidarrOnly artist with
    // `no-consumption-coverage`, and as the only running rule it also owns that
    // artist's `identity-not-authoritative` refusal. Rule + subject alone would
    // key both rows identically.
    const report = run({
      config: { rules: { "stale-monitoring-cleanup": { enabled: true } } },
      signals: {
        bridgeIdentity: {
          status: "available",
          data: { ...REPORT, lidarrOnly: [targetUnmatched(999, "Ghost Artist")] },
        },
      },
    });

    const ghost = report.skips.filter((skip) => skip.subject.artistId === 999);
    expect(ghost.map((skip) => skip.key).sort()).toEqual([
      "stale-monitoring-cleanup:artist:999:identity-not-authoritative",
      "stale-monitoring-cleanup:artist:999:no-consumption-coverage",
    ]);
    expect(new Set(keys(report)).size).toBe(keys(report).length);
  });

  it("separates a discovery seed from the §6.0 refusal for the same Plex artist", () => {
    // `seedCandidates` is a strict subset of `plexOnly`, which is entirely inside
    // `nonAuthoritative`, so the seeded artist ALWAYS draws a refusal too.
    const seeded = sourceUnmatched("60", "Seedling");
    const report = run({
      config: { rules: { "discovery-seed": { enabled: true } } },
      signals: {
        bridgeIdentity: { status: "available", data: { ...REPORT, plexOnly: [seeded] } },
        plexArtistRatings: {
          status: "available",
          data: [...PLEX_ARTISTS, plexArtist("60", "Seedling", stars(5))],
        },
      },
    });

    expect(report.proposals.map((proposal) => proposal.key)).toEqual(["discovery-seed:plex:60"]);
    expect(report.skips.map((skip) => skip.key)).toContain(
      "discovery-seed:plex:60:identity-not-authoritative",
    );
    expect(new Set(keys(report)).size).toBe(keys(report).length);
  });
});

/* ── resolvePolicyConfig ─────────────────────────────────────────────────── */

describe("resolvePolicyConfig — every default is applied here, none by the validator", () => {
  it("applies the whole default table to an absent config", () => {
    const resolved = resolvePolicyConfig(undefined, {}, AVAILABLE_PROFILES);

    expect(resolved).toEqual({
      plexLibrary: "Music",
      rules: {
        "rating-quality-upgrade": {
          kind: "rating-quality-upgrade",
          enabled: false,
          minRating: 4,
          targetQualityProfile: null,
          resolvedProfileId: null,
          maxProposals: 25,
        },
        "stale-monitoring-cleanup": {
          kind: "stale-monitoring-cleanup",
          enabled: false,
          maxPlays: 0,
          minDaysSinceLastViewed: null,
          protectRatingAtOrAbove: 4,
          requireTrackCoverage: true,
          minTrackFileCount: 1,
          maxProposals: 25,
        },
        "discovery-seed": {
          kind: "discovery-seed",
          enabled: false,
          minRating: 5,
          minPlays: null,
          maxSeeds: 10,
        },
      },
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.rules)).toBe(true);
  });

  it("keeps operator values, including the falsy ones", () => {
    const resolved = resolvePolicyConfig(
      {
        rules: {
          "stale-monitoring-cleanup": {
            enabled: false,
            maxPlays: 0,
            minDaysSinceLastViewed: 90,
            requireTrackCoverage: false,
            minTrackFileCount: 0,
          },
        },
      },
      {},
      AVAILABLE_PROFILES,
    );

    expect(resolved.rules["stale-monitoring-cleanup"]).toMatchObject({
      maxPlays: 0,
      minDaysSinceLastViewed: 90,
      requireTrackCoverage: false,
      minTrackFileCount: 0,
    });
  });

  it("resolves targetQualityProfile by name, case-insensitively", () => {
    const resolved = resolvePolicyConfig(
      { rules: { "rating-quality-upgrade": { targetQualityProfile: "lossless" } } },
      {},
      AVAILABLE_PROFILES,
    );

    expect(resolved.rules["rating-quality-upgrade"]).toMatchObject({
      targetQualityProfile: "lossless",
      resolvedProfileId: 6,
    });
  });

  it("resolves targetQualityProfile by numeric id", () => {
    const resolved = resolvePolicyConfig(
      { rules: { "rating-quality-upgrade": { targetQualityProfile: "6" } } },
      {},
      AVAILABLE_PROFILES,
    );

    expect(resolved.rules["rating-quality-upgrade"]).toMatchObject({ resolvedProfileId: 6 });
  });

  it("resolves to null for an unknown name and for an unavailable profile slot", () => {
    const unknown = resolvePolicyConfig(
      { rules: { "rating-quality-upgrade": { targetQualityProfile: "Vinyl Rip" } } },
      {},
      AVAILABLE_PROFILES,
    );
    const ungathered = resolvePolicyConfig(
      { rules: { "rating-quality-upgrade": { targetQualityProfile: "Lossless" } } },
      {},
      unavailable("not-requested", "profiles were not gathered"),
    );

    expect(unknown.rules["rating-quality-upgrade"]).toMatchObject({ resolvedProfileId: null });
    expect(ungathered.rules["rating-quality-upgrade"]).toMatchObject({ resolvedProfileId: null });
  });

  it("§16.2 — applies the single global --max-proposals to every rule cap", () => {
    const resolved = resolvePolicyConfig(
      {
        rules: {
          "rating-quality-upgrade": { maxProposals: 25 },
          "stale-monitoring-cleanup": { maxProposals: 25 },
          "discovery-seed": { maxSeeds: 10 },
        },
      },
      { maxProposals: 3 },
      AVAILABLE_PROFILES,
    );

    expect(resolved.rules["rating-quality-upgrade"]).toMatchObject({ maxProposals: 3 });
    expect(resolved.rules["stale-monitoring-cleanup"]).toMatchObject({ maxProposals: 3 });
    expect(resolved.rules["discovery-seed"]).toMatchObject({ maxSeeds: 3 });
  });

  it("prefers the plexLibrary override over config, and config over the default", () => {
    expect(
      resolvePolicyConfig({ plexLibrary: "Vinyl" }, { plexLibrary: "Flac" }, AVAILABLE_PROFILES)
        .plexLibrary,
    ).toBe("Flac");
    expect(resolvePolicyConfig({ plexLibrary: "Vinyl" }, {}, AVAILABLE_PROFILES).plexLibrary).toBe(
      "Vinyl",
    );
    expect(resolvePolicyConfig(undefined, {}, AVAILABLE_PROFILES).plexLibrary).toBe("Music");
  });

  it("caps a rule cohort with the global override, ranking by evidence before the cut", () => {
    const report = run({ config: ratingEnabled(), overrides: { maxProposals: 1 } });

    // Radiohead (5 stars) outranks Portishead (4 stars) under `rating desc`.
    expect(report.proposals.map((proposal) => proposal.key)).toEqual([
      "rating-quality-upgrade:artist:41",
    ]);
    expect(report.skips.some((skip) => skip.code === "cohort-cap-exceeded")).toBe(true);
  });
});

/* ── #221 override seam ──────────────────────────────────────────────────── */

describe("#221 — the additive per-invocation override seam", () => {
  it("lets each threshold override win over both config and POLICY_DEFAULTS", () => {
    const resolved = resolvePolicyConfig(
      {
        rules: {
          "rating-quality-upgrade": { minRating: 3, targetQualityProfile: "Standard" },
          "stale-monitoring-cleanup": { maxPlays: 9 },
        },
      },
      { ratingMinRating: 2, ratingTargetQualityProfile: "Lossless", staleMaxPlays: 7 },
      AVAILABLE_PROFILES,
    );

    expect(resolved.rules["rating-quality-upgrade"]).toMatchObject({
      minRating: 2,
      targetQualityProfile: "Lossless",
      resolvedProfileId: 6,
    });
    expect(resolved.rules["stale-monitoring-cleanup"]).toMatchObject({ maxPlays: 7 });
    // `discovery-seed` keeps its OWN default; `ratingMinRating` is rule-scoped.
    expect(resolved.rules["discovery-seed"]).toMatchObject({ minRating: 5 });
  });

  it("force-enables only the named rule, contaminating the echoed enabled flag", () => {
    const report = run({
      overrides: {
        forceEnable: new Set<PolicyRuleId>(["rating-quality-upgrade"]),
        ratingTargetQualityProfile: "Lossless",
      },
    });

    expect(ruleResult(report, "rating-quality-upgrade").status).toBe("proposals");
    expect(ruleResult(report, "stale-monitoring-cleanup")).toMatchObject({
      skipReason: "disabled",
    });
    expect(ruleResult(report, "discovery-seed")).toMatchObject({ skipReason: "disabled" });
    // Config never set `enabled`, yet the report echoes the EFFECTIVE value.
    expect(report.policy.rules["rating-quality-upgrade"].enabled).toBe(true);
  });

  it("stays inert against the pre-gather not-requested profile slot", () => {
    const resolved = resolvePolicyConfig(
      undefined,
      { ratingTargetQualityProfile: "Lossless" },
      unavailable("not-requested", "profiles were not gathered"),
    );

    expect(resolved.rules["rating-quality-upgrade"]).toMatchObject({
      targetQualityProfile: "Lossless",
      resolvedProfileId: null,
    });
  });

  it("keeps the not-selected gate ahead of the force-enabled disabled gate", () => {
    const report = run({
      selected: ["rating-quality-upgrade", "stale-monitoring-cleanup"],
      overrides: {
        forceEnable: new Set<PolicyRuleId>(POLICY_RULE_IDS),
        ratingTargetQualityProfile: "Lossless",
      },
    });

    expect(ruleResult(report, "discovery-seed")).toMatchObject({
      status: "skipped",
      skipReason: "not-selected",
    });
    expect(ruleResult(report, "stale-monitoring-cleanup").status).toBe("proposals");
  });

  it("resolves unchanged for an overrides object carrying none of the new fields", () => {
    // The `policy evaluate` no-regression pin: that leaf supplies exactly these two.
    const resolved = resolvePolicyConfig(
      BOTH_ENABLED,
      { plexLibrary: "Vinyl", maxProposals: 5 },
      AVAILABLE_PROFILES,
    );

    expect(resolved).toEqual({
      plexLibrary: "Vinyl",
      rules: {
        "rating-quality-upgrade": {
          kind: "rating-quality-upgrade",
          enabled: true,
          minRating: 4,
          targetQualityProfile: "Lossless",
          resolvedProfileId: 6,
          maxProposals: 5,
        },
        "stale-monitoring-cleanup": {
          kind: "stale-monitoring-cleanup",
          enabled: true,
          maxPlays: 0,
          minDaysSinceLastViewed: null,
          protectRatingAtOrAbove: 4,
          requireTrackCoverage: true,
          minTrackFileCount: 1,
          maxProposals: 5,
        },
        "discovery-seed": {
          kind: "discovery-seed",
          enabled: false,
          minRating: 5,
          minPlays: null,
          maxSeeds: 5,
        },
      },
    });
  });
});

/* ── Exit gate ───────────────────────────────────────────────────────────── */

describe("shouldFailPolicyEvaluation — the full truth table", () => {
  const clean = () =>
    run({ config: ratingEnabled("Standard"), selected: ["rating-quality-upgrade"] });
  const withProposals = () => run({ config: BOTH_ENABLED });
  const degradedWithoutProposals = () =>
    run({
      config: ratingEnabled(),
      selected: ["rating-quality-upgrade"],
      signals: { plexArtistRatings: unavailable("data-unavailable", "Plex artist drain failed") },
    });

  it("never trips at fail-on none", () => {
    expect(shouldFailPolicyEvaluation(clean(), "none")).toBe(false);
    expect(shouldFailPolicyEvaluation(withProposals(), "none")).toBe(false);
    expect(shouldFailPolicyEvaluation(degradedWithoutProposals(), "none")).toBe(false);
  });

  it("does not trip at fail-on proposals for a clean report", () => {
    expect(shouldFailPolicyEvaluation(clean(), "proposals")).toBe(false);
  });

  it("trips at fail-on proposals when proposals exist", () => {
    expect(shouldFailPolicyEvaluation(withProposals(), "proposals")).toBe(true);
  });

  it("trips at fail-on proposals for a degraded report with ZERO proposals", () => {
    const report = degradedWithoutProposals();

    expect(report.status).toBe("degraded");
    expect(report.summary.proposed).toBe(0);
    expect(shouldFailPolicyEvaluation(report, "proposals")).toBe(true);
  });
});
