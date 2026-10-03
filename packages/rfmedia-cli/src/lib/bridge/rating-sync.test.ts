/**
 * The seven `rating-sync.ts` behaviours that carry the feature's only new
 * decision logic (issue #221, design §8.1).
 *
 * Pure module: frozen-literal `PolicyEvaluationReport` fixtures, no mocks. Every
 * case here is a gate whose regression seals the wrong artists — the three
 * refusal gates, the diff fidelity the artifact is built from, the selection
 * filter, the invariant throws, and the threshold provenance a reviewer reads to
 * tell a persistent policy from a one-off experiment.
 */

import { describe, expect, it } from "vitest";

import type { PolicyConfigOptions } from "../../types/config.js";
import { POLICY_ENGINE_VERSION, POLICY_EVALUATION_SCHEMA } from "../../types/lidarr-policy.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyEvaluatedProposal,
  PolicyEvaluationReport,
  PolicyIdentityBasis,
  PolicyOverrideResult,
  PolicyResolvedRule,
  PolicyRuleId,
  PolicyRuleResult,
  PolicyRuleSkipReason,
  PolicySignalStatusMap,
  PolicySkip,
  PolicyThresholdCheck,
} from "../../types/lidarr-policy.js";
import type { SyncRatingsDecision } from "../../types/lidarr-sync-ratings.js";
import {
  SyncRatingsProjectionError,
  buildRatingSyncPlan,
  resolveSyncRatingsThresholds,
} from "./rating-sync.js";

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const CURRENT_FINGERPRINT = `sha256:${"a".repeat(64)}` as PolicyDecisionEvidenceFingerprint;
const REVIEWED_FINGERPRINT = `sha256:${"b".repeat(64)}` as PolicyDecisionEvidenceFingerprint;

const IDENTITY: PolicyIdentityBasis = { category: "authoritative", reason: "unique-exact-mbid" };

const RATING_CHECK: PolicyThresholdCheck = {
  signal: "plexArtistRatings",
  label: "Plex artist rating >= 4 stars",
  comparator: ">=",
  bound: 4,
  observed: 5,
  satisfied: true,
  configPath: "policy.rules.rating-quality-upgrade.minRating",
};

const SIGNALS: PolicySignalStatusMap = {
  bridgeIdentity: { status: "available" },
  lidarrArtists: { status: "available" },
  lidarrQualityProfiles: { status: "available" },
  plexArtistRatings: { status: "available" },
  plexTrackPlays: { status: "available" },
};

const RESOLVED_RULES: Readonly<Record<PolicyRuleId, PolicyResolvedRule>> = {
  "rating-quality-upgrade": {
    kind: "rating-quality-upgrade",
    enabled: true,
    minRating: 4,
    targetQualityProfile: "FLAC",
    resolvedProfileId: 7,
    maxProposals: 25,
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
  },
  "discovery-seed": {
    kind: "discovery-seed",
    enabled: false,
    minRating: 5,
    minPlays: null,
    maxSeeds: 10,
  },
};

const BOTH_DECISIONS: readonly SyncRatingsDecision[] = ["quality-profile", "monitoring"];
const NOTHING_DISABLED: ReadonlySet<SyncRatingsDecision> = new Set<SyncRatingsDecision>();

function evaluated(id: PolicyRuleId): PolicyRuleResult {
  return { id, title: id, status: "proposals", proposedCount: 1, skippedCount: 0 };
}

function skippedRule(
  id: PolicyRuleId,
  skipReason: PolicyRuleSkipReason,
  detail: string,
): PolicyRuleResult {
  return { id, title: id, status: "skipped", skipReason, detail };
}

const EVALUATED_RULES: readonly PolicyRuleResult[] = [
  evaluated("rating-quality-upgrade"),
  evaluated("stale-monitoring-cleanup"),
  evaluated("discovery-seed"),
];

function ratingProposal(
  artistId: number,
  overrides: Partial<PolicyEvaluatedProposal> = {},
): PolicyEvaluatedProposal {
  return {
    key: `rating-quality-upgrade:artist:${artistId}`,
    ruleId: "rating-quality-upgrade",
    code: "rating-below-target-profile",
    subject: {
      kind: "artist",
      name: `Artist ${artistId}`,
      plexId: `p${artistId}`,
      artistId,
      artistMbid: `mbid-${artistId}`,
    },
    identity: IDENTITY,
    before: { qualityProfileId: 3, qualityProfileName: "MP3-320" },
    after: { qualityProfileId: 7, qualityProfileName: "FLAC" },
    checks: [RATING_CHECK],
    observations: { rating: { status: "observed", value: 5, join: "exact-plex-id" } },
    summary: `Rated 5 stars in Plex while assigned quality profile "MP3-320" instead of "FLAC".`,
    handoff: { producer: "artist-profile-assignment", argv: ["lidarr", "plan", "artist-profiles"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
    ...overrides,
  };
}

function monitoringProposal(
  artistId: number,
  overrides: Partial<PolicyEvaluatedProposal> = {},
): PolicyEvaluatedProposal {
  return {
    key: `stale-monitoring-cleanup:artist:${artistId}`,
    ruleId: "stale-monitoring-cleanup",
    code: "monitored-artist-unconsumed",
    subject: {
      kind: "artist",
      name: `Artist ${artistId}`,
      plexId: `p${artistId}`,
      artistId,
      artistMbid: `mbid-${artistId}`,
    },
    identity: IDENTITY,
    before: { monitored: true },
    after: { monitored: false },
    checks: [],
    observations: { plays: { status: "observed", value: 0, join: "normalized-name" } },
    summary: "Monitored in Lidarr with no demonstrated Plex consumption.",
    handoff: { producer: "artist-monitoring", argv: ["lidarr", "plan", "artist-monitoring"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
    ...overrides,
  };
}

function seedProposal(plexId: string): PolicyEvaluatedProposal {
  return {
    key: `discovery-seed:plex:${plexId}`,
    ruleId: "discovery-seed",
    code: "high-signal-discovery-seed",
    subject: { kind: "artist", name: "Seedling", plexId, artistMbid: null },
    identity: { category: "unmatched", reason: "no-candidate" },
    before: { inLidarr: false },
    after: { inLidarr: false },
    checks: [],
    observations: { rating: { status: "observed", value: 5, join: "exact-plex-id" } },
    summary: "Rated 5 stars in Plex with no Lidarr candidate at all.",
    handoff: { producer: "discovery", argv: ["lidarr", "discover", "--artist", "Seedling"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
  };
}

function retainedOverride(
  decision: PolicyEvaluatedProposal,
  status: "suppressed" | "stale",
): PolicyOverrideResult {
  const suppressed = status === "suppressed";
  return {
    key: decision.key,
    action: "suppress",
    status,
    staleReason: suppressed ? null : "evidence-changed",
    reason: "Reviewed with the library owner",
    expectedEvidenceFingerprint: suppressed ? decision.evidenceFingerprint : REVIEWED_FINGERPRINT,
    currentEvidenceFingerprint: decision.evidenceFingerprint,
    decision,
  };
}

interface ReportParts {
  readonly rules?: readonly PolicyRuleResult[];
  readonly proposals?: readonly PolicyEvaluatedProposal[];
  readonly skips?: readonly PolicySkip[];
  readonly overrides?: readonly PolicyOverrideResult[];
  readonly resolvedRules?: Readonly<Record<PolicyRuleId, PolicyResolvedRule>>;
}

function buildReport(parts: ReportParts = {}): PolicyEvaluationReport {
  const proposals = parts.proposals ?? [];
  const skips = parts.skips ?? [];
  const overrides = parts.overrides ?? [];
  const rules =
    parts.rules ??
    EVALUATED_RULES.map((rule): PolicyRuleResult => {
      const proposedCount = proposals.filter((proposal) => proposal.ruleId === rule.id).length;
      return proposedCount === 0
        ? { id: rule.id, title: rule.title, status: "clean", proposedCount: 0, skippedCount: 0 }
        : {
            id: rule.id,
            title: rule.title,
            status: "proposals",
            proposedCount,
            skippedCount: 0,
          };
    });
  return {
    schema: POLICY_EVALUATION_SCHEMA,
    engineVersion: POLICY_ENGINE_VERSION,
    evaluatedAt: "2026-01-15T10:30:00.000Z",
    plexOrigin: "http://plex.local:32400",
    lidarrOrigin: "http://lidarr.local:8686",
    plexLibrary: "Music",
    status: "proposals",
    policy: { plexLibrary: "Music", rules: parts.resolvedRules ?? RESOLVED_RULES },
    signals: SIGNALS,
    summary: {
      proposed: proposals.length,
      skipped: skips.length,
      suppressed: overrides.filter((override) => override.status === "suppressed").length,
      staleOverrides: overrides.filter((override) => override.status === "stale").length,
      notEvaluatedOverrides: overrides.filter((override) => override.status === "not-evaluated")
        .length,
      rulesRun: 3,
      rulesSkipped: 0,
    },
    rules,
    proposals,
    skips,
    overrides,
    coverage: {
      plexArtistsExamined: 10,
      plexTracksExamined: 100,
      authoritativeLinks: 10,
      nonAuthoritativeArtists: 0,
      ambiguousNameArtists: 0,
      sentinelArtistTracks: 0,
      unjoinedTracks: 0,
      totalPlaysObserved: 250,
    },
  };
}

/* ── Gates ───────────────────────────────────────────────────────────────── */

describe("buildRatingSyncPlan — the three refusal gates", () => {
  it("G1 refuses a decision the operator switched off and leaves its sibling alone", () => {
    const plan = buildRatingSyncPlan({
      report: buildReport({ proposals: [ratingProposal(4), monitoringProposal(9)] }),
      decisions: BOTH_DECISIONS,
      disabledDecisions: new Set<SyncRatingsDecision>(["quality-profile"]),
    });

    expect(plan.cohorts[0]?.gate).toBe("refused");
    expect(plan.cohorts[0]?.changes).toEqual([]);
    expect(plan.refusals).toEqual([
      {
        code: "decision-disabled",
        scope: "decision",
        decision: "quality-profile",
        artistId: null,
        ruleSkipReason: null,
        detail:
          "policy.rules.rating-quality-upgrade.enabled is false, so this decision is deliberately switched off",
        remedy: "policy.rules.rating-quality-upgrade.enabled",
      },
    ]);
    expect(plan.sealable).toEqual(["monitoring"]);
    expect(plan.cohorts[1]?.artistIds).toEqual([9]);
  });

  it("G2 refuses a rule the engine skipped, carrying its own reason and detail", () => {
    const plan = buildRatingSyncPlan({
      report: buildReport({
        rules: [
          evaluated("rating-quality-upgrade"),
          skippedRule(
            "stale-monitoring-cleanup",
            "consumption-signal-empty",
            "the resolved Plex token observed zero library-wide plays",
          ),
          evaluated("discovery-seed"),
        ],
        proposals: [ratingProposal(4), monitoringProposal(9)],
      }),
      decisions: BOTH_DECISIONS,
      disabledDecisions: NOTHING_DISABLED,
    });

    expect(plan.refusals).toEqual([
      {
        code: "rule-not-evaluated",
        scope: "decision",
        decision: "monitoring",
        artistId: null,
        ruleSkipReason: "consumption-signal-empty",
        detail: "the resolved Plex token observed zero library-wide plays",
        remedy: null,
      },
    ]);
    expect(plan.cohorts[1]?.gate).toBe("refused");
    expect(plan.sealable).toEqual(["quality-profile"]);
  });

  it("G3 drops an artist proposed by both decisions from BOTH cohorts, once", () => {
    const plan = buildRatingSyncPlan({
      report: buildReport({
        proposals: [
          ratingProposal(5),
          ratingProposal(6),
          monitoringProposal(5),
          monitoringProposal(8),
        ],
      }),
      decisions: BOTH_DECISIONS,
      disabledDecisions: NOTHING_DISABLED,
    });

    expect(plan.cohorts[0]?.artistIds).toEqual([6]);
    expect(plan.cohorts[1]?.artistIds).toEqual([8]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({
      code: "cross-decision-conflict",
      scope: "artist",
      decision: null,
      artistId: 5,
    });
    expect(plan.sealable).toEqual(["quality-profile", "monitoring"]);
  });
});

/* ── Projection ──────────────────────────────────────────────────────────── */

describe("buildRatingSyncPlan — projection", () => {
  it("projects only actionable v2 proposals, not decisions retained by overrides", () => {
    const suppressed = ratingProposal(4);
    const stale = monitoringProposal(9);
    const actionable = ratingProposal(6);
    const evaluation = buildReport({
      proposals: [actionable],
      overrides: [retainedOverride(suppressed, "suppressed"), retainedOverride(stale, "stale")],
    });
    const plan = buildRatingSyncPlan({
      report: evaluation,
      decisions: BOTH_DECISIONS,
      disabledDecisions: NOTHING_DISABLED,
    });

    expect(evaluation.rules).toEqual([
      expect.objectContaining({ id: "rating-quality-upgrade", proposedCount: 1 }),
      expect.objectContaining({
        id: "stale-monitoring-cleanup",
        status: "clean",
        proposedCount: 0,
      }),
      expect.objectContaining({ id: "discovery-seed", status: "clean", proposedCount: 0 }),
    ]);
    expect(plan.cohorts).toEqual([
      expect.objectContaining({
        decision: "quality-profile",
        gate: "sealable",
        artistIds: [6],
        changes: [expect.objectContaining({ decisionKey: actionable.key })],
      }),
      expect.objectContaining({ decision: "monitoring", gate: "no-changes", artistIds: [] }),
    ]);
    expect(plan.refusals).toEqual([]);
    expect(plan.sealable).toEqual(["quality-profile"]);
    expect(plan.footprint.changedArtists).toBe(1);
  });

  it("carries the diff verbatim, sorts and deduplicates ids, and omits a converged artist", () => {
    const plan = buildRatingSyncPlan({
      report: buildReport({
        proposals: [ratingProposal(9), ratingProposal(3), ratingProposal(9)],
        skips: [
          {
            key: "rating-quality-upgrade:artist:12:already-converged",
            ruleId: "rating-quality-upgrade",
            code: "already-converged",
            subject: {
              kind: "artist",
              name: "Artist 12",
              plexId: "p12",
              artistId: 12,
              artistMbid: null,
            },
            identity: IDENTITY,
            checks: [],
            detail: 'artist is already assigned quality profile "FLAC"',
          },
        ],
      }),
      decisions: ["quality-profile"],
      disabledDecisions: NOTHING_DISABLED,
    });

    const cohort = plan.cohorts[0];
    expect(cohort?.gate).toBe("sealable");
    expect(cohort?.artistIds).toEqual([3, 9]);
    expect(cohort?.resolvedProfileId).toBe(7);
    expect(cohort?.qualityProfileName).toBe("FLAC");
    expect(cohort?.changes.find((change) => change.artistId === 3)).toEqual({
      decisionKey: "rating-quality-upgrade:artist:3",
      artistId: 3,
      artistName: "Artist 3",
      plexId: "p3",
      artistMbid: "mbid-3",
      before: { qualityProfileId: 3, qualityProfileName: "MP3-320" },
      after: { qualityProfileId: 7, qualityProfileName: "FLAC" },
      checks: [RATING_CHECK],
      summary: `Rated 5 stars in Plex while assigned quality profile "MP3-320" instead of "FLAC".`,
    });
    expect(plan.footprint).toEqual({
      authoritativeLinks: 10,
      changedArtists: 2,
      fraction: 0.2,
    });
  });

  it("excludes a non-selected decision's proposals before any invariant runs", () => {
    const plan = buildRatingSyncPlan({
      report: buildReport({
        proposals: [ratingProposal(4), seedProposal("p77"), monitoringProposal(9)],
      }),
      decisions: ["monitoring"],
      disabledDecisions: NOTHING_DISABLED,
    });

    expect(plan.cohorts).toHaveLength(1);
    expect(plan.cohorts[0]?.decision).toBe("monitoring");
    expect(plan.cohorts[0]?.artistIds).toEqual([9]);
    expect(plan.cohorts[0]?.desiredMonitored).toBe(false);
  });

  it("throws rather than dropping a proposal that violates an engine invariant", () => {
    const subjectless = ratingProposal(4, {
      subject: { kind: "artist", name: "Ghost", plexId: "p4", artistMbid: null },
    });

    expect(() =>
      buildRatingSyncPlan({
        report: buildReport({ proposals: [subjectless] }),
        decisions: BOTH_DECISIONS,
        disabledDecisions: NOTHING_DISABLED,
      }),
    ).toThrow(SyncRatingsProjectionError);

    expect(() =>
      buildRatingSyncPlan({
        report: buildReport({
          proposals: [monitoringProposal(9, { after: { monitored: "false" } })],
        }),
        decisions: BOTH_DECISIONS,
        disabledDecisions: NOTHING_DISABLED,
      }),
    ).toThrow(SyncRatingsProjectionError);

    expect(() =>
      buildRatingSyncPlan({
        report: buildReport({
          proposals: [ratingProposal(4, { after: { qualityProfileId: "7" } })],
        }),
        decisions: BOTH_DECISIONS,
        disabledDecisions: NOTHING_DISABLED,
      }),
    ).toThrow(SyncRatingsProjectionError);

    expect(() =>
      buildRatingSyncPlan({
        report: buildReport({
          proposals: [
            ratingProposal(4),
            ratingProposal(5, { after: { qualityProfileId: 9, qualityProfileName: "ALAC" } }),
          ],
        }),
        decisions: BOTH_DECISIONS,
        disabledDecisions: NOTHING_DISABLED,
      }),
    ).toThrow(SyncRatingsProjectionError);

    expect(() =>
      buildRatingSyncPlan({
        report: buildReport({
          proposals: [ratingProposal(4)],
          resolvedRules: {
            ...RESOLVED_RULES,
            "rating-quality-upgrade": {
              kind: "rating-quality-upgrade",
              enabled: true,
              minRating: 4,
              targetQualityProfile: "FLAC",
              resolvedProfileId: null,
              maxProposals: 25,
            },
          },
        }),
        decisions: BOTH_DECISIONS,
        disabledDecisions: NOTHING_DISABLED,
      }),
    ).toThrow(SyncRatingsProjectionError);
  });

  it("throws when monitoring proposals disagree, rather than last-write-wins", () => {
    // The cohort seals ONE monitored scalar over every artistId, so silently
    // taking the last value would mutate artists to the opposite of what their
    // own proposal decided — the mirror of the profile branch's target guard.
    expect(() =>
      buildRatingSyncPlan({
        report: buildReport({
          proposals: [
            monitoringProposal(9),
            monitoringProposal(10, { after: { monitored: true } }),
          ],
        }),
        decisions: BOTH_DECISIONS,
        disabledDecisions: NOTHING_DISABLED,
      }),
    ).toThrow(SyncRatingsProjectionError);
  });

  it("accepts agreeing monitoring proposals and seals their shared target", () => {
    const plan = buildRatingSyncPlan({
      report: buildReport({ proposals: [monitoringProposal(9), monitoringProposal(10)] }),
      decisions: BOTH_DECISIONS,
      disabledDecisions: NOTHING_DISABLED,
    });
    const monitoring = plan.cohorts.find((cohort) => cohort.decision === "monitoring");
    expect(monitoring?.desiredMonitored).toBe(false);
    expect(monitoring?.artistIds).toEqual([9, 10]);
  });
});

/* ── Thresholds ──────────────────────────────────────────────────────────── */

describe("resolveSyncRatingsThresholds", () => {
  it("tags each of the four thresholds flag, config, or default", () => {
    const report = buildReport();
    const config: PolicyConfigOptions = {
      rules: {
        "rating-quality-upgrade": { minRating: 4, targetQualityProfile: "FLAC", maxProposals: 25 },
        "stale-monitoring-cleanup": { maxPlays: 0 },
      },
    };

    const flagged = resolveSyncRatingsThresholds({
      report,
      config,
      overrides: { minStars: 4, maxPlays: 0, qualityProfile: "FLAC", maxProposals: 25 },
    });
    expect([
      flagged.minStars.source,
      flagged.maxPlays.source,
      flagged.qualityProfile.source,
      flagged.maxProposals.source,
    ]).toEqual(["flag", "flag", "flag", "flag"]);

    const configured = resolveSyncRatingsThresholds({ report, config, overrides: {} });
    expect([
      configured.minStars.source,
      configured.maxPlays.source,
      configured.qualityProfile.source,
      configured.maxProposals.source,
    ]).toEqual(["config", "config", "config", "config"]);

    const defaulted = resolveSyncRatingsThresholds({ report, config: undefined, overrides: {} });
    expect([
      defaulted.minStars.source,
      defaulted.maxPlays.source,
      defaulted.qualityProfile.source,
      defaulted.maxProposals.source,
    ]).toEqual(["default", "default", "default", "default"]);
    expect(defaulted.minStars).toEqual({
      value: 4,
      source: "default",
      configPath: "policy.rules.rating-quality-upgrade.minRating",
    });
    expect(defaulted.maxPlays.value).toBe(0);
    expect(defaulted.qualityProfile.value).toBe("FLAC");
    expect(defaulted.maxProposals.value).toBe(25);
  });
});
