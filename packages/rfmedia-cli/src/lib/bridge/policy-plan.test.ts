/** Critical safety contracts for the pure policy-plan projector. */

import { describe, expect, it } from "vitest";

import { LIDARR_PLAN_MAX_BATCH } from "../../types/lidarr-plan.js";
import { POLICY_ENGINE_VERSION, POLICY_EVALUATION_SCHEMA } from "../../types/lidarr-policy.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyEvaluatedProposal,
  PolicyEvaluationReport,
  PolicyIdentityBasis,
  PolicyOverrideResult,
  PolicyProposal,
  PolicyResolvedRule,
  PolicyRuleId,
  PolicyRuleResult,
  PolicySignalStatusMap,
} from "../../types/lidarr-policy.js";
import { PolicyPlanProjectionError, projectPolicyPlan } from "./policy-plan.js";

const CURRENT_FINGERPRINT = `sha256:${"a".repeat(64)}` as PolicyDecisionEvidenceFingerprint;
const REVIEWED_FINGERPRINT = `sha256:${"b".repeat(64)}` as PolicyDecisionEvidenceFingerprint;

const AUTHORITATIVE: PolicyIdentityBasis = {
  category: "authoritative",
  reason: "unique-exact-mbid",
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
    enabled: true,
    minRating: 5,
    minPlays: null,
    maxSeeds: 10,
  },
};

const RULES: readonly PolicyRuleResult[] = [
  {
    id: "rating-quality-upgrade",
    title: "Rating-informed quality upgrade",
    status: "proposals",
    proposedCount: 1,
    skippedCount: 0,
  },
  {
    id: "stale-monitoring-cleanup",
    title: "Stale monitoring cleanup",
    status: "proposals",
    proposedCount: 1,
    skippedCount: 0,
  },
  {
    id: "discovery-seed",
    title: "Discovery seed generation",
    status: "proposals",
    proposedCount: 1,
    skippedCount: 0,
  },
];

function profileProposal(
  artistId: number,
  qualityProfileId = 7,
  overrides: Partial<PolicyEvaluatedProposal> = {},
): PolicyEvaluatedProposal {
  return {
    key: `rating-quality-upgrade:artist:${artistId}`,
    ruleId: "rating-quality-upgrade",
    code: "rating-below-target-profile",
    subject: {
      kind: "artist",
      name: `Artist ${artistId}`,
      plexId: `plex-${artistId}`,
      artistId,
      artistMbid: `mbid-${artistId}`,
    },
    identity: AUTHORITATIVE,
    before: { qualityProfileId: 3 },
    after: { qualityProfileId, qualityProfileName: "FLAC" },
    checks: [],
    observations: {},
    summary: `Assign Artist ${artistId} to profile ${qualityProfileId}`,
    handoff: { producer: "artist-profile-assignment", argv: ["lidarr", "plan"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
    ...overrides,
  };
}

function monitoringProposal(
  artistId: number,
  monitored = false,
  overrides: Partial<PolicyEvaluatedProposal> = {},
): PolicyEvaluatedProposal {
  return {
    key: `stale-monitoring-cleanup:artist:${artistId}`,
    ruleId: "stale-monitoring-cleanup",
    code: "monitored-artist-unconsumed",
    subject: {
      kind: "artist",
      name: `Artist ${artistId}`,
      plexId: `plex-${artistId}`,
      artistId,
      artistMbid: `mbid-${artistId}`,
    },
    identity: AUTHORITATIVE,
    before: { monitored: !monitored },
    after: { monitored },
    checks: [],
    observations: {},
    summary: `Set Artist ${artistId} monitored=${monitored}`,
    handoff: { producer: "artist-monitoring", argv: ["lidarr", "plan"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
    ...overrides,
  };
}

function discoveryProposal(plexId: string): PolicyEvaluatedProposal {
  return {
    key: `discovery-seed:plex:${plexId}`,
    ruleId: "discovery-seed",
    code: "high-signal-discovery-seed",
    subject: { kind: "artist", name: "Seed Artist", plexId, artistMbid: null },
    identity: { category: "unmatched", reason: "no-candidate" },
    before: { inLidarr: false },
    after: { inLidarr: false },
    checks: [],
    observations: {},
    summary: "Offer an inert discovery seed",
    handoff: { producer: "discovery", argv: ["lidarr", "discover"] },
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

function report(
  proposals: readonly PolicyEvaluatedProposal[],
  overrides: readonly PolicyOverrideResult[] = [],
): PolicyEvaluationReport {
  return {
    schema: POLICY_EVALUATION_SCHEMA,
    engineVersion: POLICY_ENGINE_VERSION,
    evaluatedAt: "2026-07-31T00:00:00.000Z",
    plexOrigin: "http://plex.local:32400",
    lidarrOrigin: "http://lidarr.local:8686",
    plexLibrary: "Music",
    status: proposals.length === 0 ? "clean" : "proposals",
    policy: { plexLibrary: "Music", rules: RESOLVED_RULES },
    signals: SIGNALS,
    summary: {
      proposed: proposals.length,
      skipped: 0,
      suppressed: overrides.filter((override) => override.status === "suppressed").length,
      staleOverrides: overrides.filter((override) => override.status === "stale").length,
      notEvaluatedOverrides: overrides.filter((override) => override.status === "not-evaluated")
        .length,
      rulesRun: 3,
      rulesSkipped: 0,
    },
    rules: RULES.map((rule): PolicyRuleResult => {
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
    }),
    proposals,
    skips: [],
    overrides,
    coverage: {
      plexArtistsExamined: 10,
      plexTracksExamined: 100,
      authoritativeLinks: 10,
      nonAuthoritativeArtists: 0,
      ambiguousNameArtists: 0,
      sentinelArtistTracks: 0,
      unjoinedTracks: 0,
      totalPlaysObserved: 100,
    },
  };
}

describe("projectPolicyPlan", () => {
  it("projects only actionable v2 proposals, not decisions retained by overrides", () => {
    const suppressed = profileProposal(4);
    const stale = monitoringProposal(9);
    const actionable = profileProposal(12, 5);
    const evaluation = report(
      [actionable],
      [retainedOverride(suppressed, "suppressed"), retainedOverride(stale, "stale")],
    );
    const projection = projectPolicyPlan(evaluation);

    expect(evaluation.rules).toEqual([
      expect.objectContaining({ id: "rating-quality-upgrade", proposedCount: 1 }),
      expect.objectContaining({
        id: "stale-monitoring-cleanup",
        status: "clean",
        proposedCount: 0,
      }),
      expect.objectContaining({ id: "discovery-seed", status: "clean", proposedCount: 0 }),
    ]);
    expect(projection.cohorts).toEqual([
      expect.objectContaining({
        producer: "artist-profile-assignment",
        artistIds: [12],
        changes: [expect.objectContaining({ decisionKey: actionable.key })],
      }),
    ]);
    expect(projection.refusals).toEqual([]);
    expect(projection.summary).toEqual({
      proposals: 1,
      projectable: 1,
      refused: 0,
      artifacts: 0,
    });
  });

  it("groups, orders, deduplicates, freezes, and accounts for both supported producers", () => {
    const duplicateIntent = profileProposal(9, 7, {
      key: "rating-quality-upgrade:artist:9:second-evidence",
    });
    const projection = projectPolicyPlan(
      report([
        monitoringProposal(8, true),
        profileProposal(9),
        monitoringProposal(3, false),
        profileProposal(4, 5),
        duplicateIntent,
        profileProposal(2, 7),
      ]),
    );

    expect(projection.cohorts).toHaveLength(4);
    expect(projection.cohorts.map((cohort) => cohort.producer)).toEqual([
      "artist-profile-assignment",
      "artist-profile-assignment",
      "artist-monitoring",
      "artist-monitoring",
    ]);
    expect(projection.cohorts[0]).toMatchObject({ qualityProfileId: 5, artistIds: [4] });
    expect(projection.cohorts[1]).toMatchObject({ qualityProfileId: 7, artistIds: [2, 9] });
    expect(projection.cohorts[1]?.changes.map((change) => change.artistId)).toEqual([2, 9, 9]);
    expect(projection.cohorts[2]).toMatchObject({ monitored: false, artistIds: [3] });
    expect(projection.cohorts[3]).toMatchObject({ monitored: true, artistIds: [8] });
    expect(projection.summary).toEqual({
      proposals: 6,
      projectable: 6,
      refused: 0,
      artifacts: 0,
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.cohorts)).toBe(true);
    expect(Object.isFrozen(projection.cohorts[1]?.changes[0]?.after)).toBe(true);
  });

  it("keeps discovery visible as an unsupported-producer refusal", () => {
    const projection = projectPolicyPlan(report([discoveryProposal("plex-44")]));

    expect(projection.cohorts).toEqual([]);
    expect(projection.refusals).toEqual([
      expect.objectContaining({
        code: "unsupported-producer",
        decisionKey: "discovery-seed:plex:plex-44",
        producer: "discovery",
        artistId: null,
      }),
    ]);
    expect(projection.summary).toEqual({
      proposals: 1,
      projectable: 0,
      refused: 1,
      artifacts: 0,
    });
  });

  it("withholds every proposal for cross-producer and contradictory same-producer intents", () => {
    const projection = projectPolicyPlan(
      report([
        profileProposal(5),
        monitoringProposal(5),
        monitoringProposal(9),
        monitoringProposal(9, true, {
          key: "stale-monitoring-cleanup:artist:9:opposite",
        }),
        profileProposal(2),
      ]),
    );

    expect(projection.cohorts).toHaveLength(1);
    expect(projection.cohorts[0]).toMatchObject({
      producer: "artist-profile-assignment",
      artistIds: [2],
    });
    expect(projection.refusals).toHaveLength(4);
    expect(projection.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "conflicting-intent", artistId: 5 }),
        expect.objectContaining({ code: "conflicting-intent", artistId: 9 }),
      ]),
    );
    expect(projection.summary).toEqual({
      proposals: 5,
      projectable: 1,
      refused: 4,
      artifacts: 0,
    });
  });

  it.each([
    ["duplicate decision key", [profileProposal(4), profileProposal(4)]],
    [
      "descriptor/handoff mismatch",
      [profileProposal(4, 7, { handoff: { producer: "artist-monitoring", argv: [] } })],
    ],
    [
      "non-authoritative identity",
      [
        profileProposal(4, 7, {
          identity: { category: "review-normalized-name", reason: "unique-normalized-name" },
        }),
      ],
    ],
    ["non-positive artist id", [profileProposal(0)]],
    ["non-numeric profile target", [profileProposal(4, 7, { after: { qualityProfileId: "7" } })]],
    ["non-boolean monitoring target", [monitoringProposal(4, false, { after: { monitored: 0 } })]],
    [
      "decision code outside descriptor",
      [profileProposal(4, 7, { code: "monitored-artist-unconsumed" })],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly PolicyProposal[]]>)(
    "rejects $0 before returning a projection",
    (_case, proposals) => {
      expect(() => projectPolicyPlan(report(proposals))).toThrow(PolicyPlanProjectionError);
    },
  );

  it("rejects a cohort above the existing Lidarr plan bound", () => {
    const proposals = Array.from({ length: LIDARR_PLAN_MAX_BATCH + 1 }, (_, index) =>
      profileProposal(index + 1),
    );

    expect(() => projectPolicyPlan(report(proposals))).toThrow(
      new RegExp(`expected 1\\.\\.${LIDARR_PLAN_MAX_BATCH}`),
    );
  });
});
