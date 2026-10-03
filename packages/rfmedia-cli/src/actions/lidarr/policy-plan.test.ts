/** Critical orchestration contracts for the Lidarr policy-plan action. */

import { describe, expect, it, vi } from "vitest";

import { projectPolicyPlan } from "../../lib/bridge/policy-plan.js";
import { buildLidarrMutationPlanV3 } from "../../lib/lidarr/plan-engine.js";
import { POLICY_ENGINE_VERSION, POLICY_EVALUATION_SCHEMA } from "../../types/lidarr-policy.js";
import { executeLidarrPolicyPlan } from "./policy-plan.js";
import type { BuildLidarrMutationPlanV3Input } from "../../lib/lidarr/plan-engine.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type {
  LidarrCascadePolicy,
  LidarrMutationPlanV3,
  LidarrPlanGenerationResultV3,
} from "../../types/lidarr-plan.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyEvaluatedProposal,
  PolicyEvaluationReport,
  PolicyIdentityBasis,
  PolicyOverrideResult,
  PolicyResolvedRule,
  PolicyRuleId,
  PolicyRuleResult,
  PolicySignalStatusMap,
} from "../../types/lidarr-policy.js";
import type { LidarrPolicyPlanDependencies } from "./policy-plan.js";

const CURRENT_FINGERPRINT = `sha256:${"a".repeat(64)}` as PolicyDecisionEvidenceFingerprint;

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

function profileProposal(artistId: number): PolicyEvaluatedProposal {
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
    after: { qualityProfileId: 7, qualityProfileName: "FLAC" },
    checks: [],
    observations: {},
    summary: `Assign Artist ${artistId} to profile 7`,
    handoff: { producer: "artist-profile-assignment", argv: ["lidarr", "plan"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
  };
}

function monitoringProposal(artistId: number): PolicyEvaluatedProposal {
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
    before: { monitored: true },
    after: { monitored: false },
    checks: [],
    observations: {},
    summary: `Stop monitoring Artist ${artistId}`,
    handoff: { producer: "artist-monitoring", argv: ["lidarr", "plan"] },
    evidenceFingerprint: CURRENT_FINGERPRINT,
  };
}

function discoveryProposal(): PolicyEvaluatedProposal {
  return {
    key: "discovery-seed:plex:seed-1",
    ruleId: "discovery-seed",
    code: "high-signal-discovery-seed",
    subject: { kind: "artist", name: "Seed Artist", plexId: "seed-1", artistMbid: null },
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

function retainedSuppression(decision: PolicyEvaluatedProposal): PolicyOverrideResult {
  return {
    key: decision.key,
    action: "suppress",
    status: "suppressed",
    staleReason: null,
    reason: "Reviewed with the library owner",
    expectedEvidenceFingerprint: decision.evidenceFingerprint,
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
    plexOrigin: "https://plex.example.test",
    lidarrOrigin: "https://lidarr.example.test",
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

function degradedReport(
  proposals: readonly PolicyEvaluatedProposal[],
  ruleId: PolicyRuleId,
  skipReason: "signal-unavailable" | "consumption-signal-empty" | "rule-error",
): PolicyEvaluationReport {
  const evaluation = report(proposals);
  return {
    ...evaluation,
    status: "degraded",
    rules: evaluation.rules.map((rule) =>
      rule.id === ruleId
        ? {
            id: rule.id,
            title: rule.title,
            status: "skipped" as const,
            skipReason,
            detail: "apiKey=raw-secret",
          }
        : rule,
    ),
  };
}

const EXECUTION: LidarrExecutionSuccessMetadata = {
  taskId: "lidarr-policy-evaluate",
  operation: "lidarr policy evaluate",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
};

const CASCADE_POLICY: LidarrCascadePolicy = {
  assumptions: { albumsPerArtist: 2, indexerQueriesPerCandidate: 3 },
  budgets: { indexerQueries: 8, acquisitionCandidates: 4 },
};

type ProfilePlan = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-profile-assignment" } }
>;
type MonitoringPlan = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" } }
>;

function isProfilePlan(plan: LidarrMutationPlanV3): plan is ProfilePlan {
  return plan.operation.kind === "artist-profile-assignment";
}

function isMonitoringPlan(plan: LidarrMutationPlanV3): plan is MonitoringPlan {
  return plan.operation.kind === "artist-monitoring";
}

function sealArtifact<TPlan extends LidarrMutationPlanV3>(
  input: BuildLidarrMutationPlanV3Input,
  planId: string,
  isExpectedKind: (plan: LidarrMutationPlanV3) => plan is TPlan,
): LidarrPlanGenerationResultV3<TPlan> {
  const plan = buildLidarrMutationPlanV3(input, {
    randomUUID: () => planId,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    hostname: () => "policy-host",
    username: () => "policy-user",
    cwd: () => "/policy/cwd",
    cliVersion: "0.5.0-policy",
  });
  if (!isExpectedKind(plan)) {
    throw new Error(`fixture built an unexpected plan kind: ${plan.operation.kind}`);
  }
  return { planPath: `/plans/${planId}.json`, plan };
}

const PROFILE_ARTIFACT = sealArtifact<ProfilePlan>(
  {
    origin: "https://lidarr.example.test",
    selection: { kind: "ids", artistIds: [3, 8] },
    operation: { kind: "artist-profile-assignment", qualityProfile: { id: 7, name: "FLAC" } },
    maxBatch: 2,
    entries: [
      {
        kind: "artist-profile-assignment",
        artistId: 3,
        artistName: "Artist 3",
        qualityProfile: { id: 2, name: "Lossy" },
      },
      {
        kind: "artist-profile-assignment",
        artistId: 8,
        artistName: "Artist 8",
        qualityProfile: { id: 2, name: "Lossy" },
      },
    ],
    cascadePolicy: CASCADE_POLICY,
  },
  "11111111-1111-4111-8111-111111111111",
  isProfilePlan,
);

const MONITORING_ARTIFACT = sealArtifact<MonitoringPlan>(
  {
    origin: "https://lidarr.example.test",
    selection: { kind: "ids", artistIds: [5] },
    operation: { kind: "artist-monitoring", desiredMonitored: false },
    maxBatch: 1,
    entries: [{ kind: "artist-monitoring", artistId: 5, artistName: "Artist 5", monitored: true }],
    cascadePolicy: CASCADE_POLICY,
  },
  "22222222-2222-4222-8222-222222222222",
  isMonitoringPlan,
);

interface Harness {
  readonly dependencies: LidarrPolicyPlanDependencies;
  readonly executeEvaluate: ReturnType<typeof vi.fn>;
  readonly projectPlan: ReturnType<typeof vi.fn>;
  readonly executeArtistProfilePlan: ReturnType<typeof vi.fn>;
  readonly executeMonitoringPlan: ReturnType<typeof vi.fn>;
}

function createHarness(evaluationReport: PolicyEvaluationReport): Harness {
  const executeEvaluate = vi.fn(async () => ({ report: evaluationReport, execution: EXECUTION }));
  const projectPlan = vi.fn(projectPolicyPlan);
  const executeArtistProfilePlan = vi.fn(async () => PROFILE_ARTIFACT);
  const executeMonitoringPlan = vi.fn(async () => MONITORING_ARTIFACT);
  const dependencies = {
    executeEvaluate,
    projectPlan,
    executeArtistProfilePlan,
    executeMonitoringPlan,
  } satisfies LidarrPolicyPlanDependencies;
  return {
    dependencies,
    executeEvaluate,
    projectPlan,
    executeArtistProfilePlan,
    executeMonitoringPlan,
  };
}

describe("executeLidarrPolicyPlan", () => {
  it("validates an unknown plan-mode explain key before projection or producer artifacts", async () => {
    const evaluationReport = report([profileProposal(8)]);
    const harness = createHarness(evaluationReport);
    const explainKey = "no-such:artist:1";
    const onPlanSealed = vi.fn();
    const validateEvaluation = vi.fn((evaluation: PolicyEvaluationReport) => {
      const known = [...evaluation.proposals, ...evaluation.skips].some(
        (decision) => decision.key === explainKey,
      );
      if (!known) {
        throw new Error(`unknown policy-plan decision key: ${explainKey}`);
      }
    });

    await expect(
      executeLidarrPolicyPlan(
        { mode: "plan", validateEvaluation, onPlanSealed },
        harness.dependencies,
      ),
    ).rejects.toThrow(`unknown policy-plan decision key: ${explainKey}`);

    expect(harness.executeEvaluate).toHaveBeenCalledOnce();
    expect(validateEvaluation).toHaveBeenCalledOnce();
    expect(validateEvaluation).toHaveBeenCalledWith(evaluationReport);
    expect(harness.projectPlan).not.toHaveBeenCalled();
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(onPlanSealed).not.toHaveBeenCalled();
  });

  it("evaluates and projects exactly once but writes nothing in recommend mode", async () => {
    const harness = createHarness(report([profileProposal(8)]));
    const controller = new AbortController();

    const result = await executeLidarrPolicyPlan(
      {
        mode: "recommend",
        rules: ["rating-quality-upgrade"],
        maxProposals: 12,
        plexLibrary: "Library Override",
        plexUrl: "https://plex.override.test",
        plexToken: "plex-secret",
        lidarrUrl: "https://lidarr.override.test",
        lidarrApiKey: "lidarr-secret",
        signal: controller.signal,
      },
      harness.dependencies,
    );

    expect(harness.executeEvaluate).toHaveBeenCalledOnce();
    expect(harness.executeEvaluate).toHaveBeenCalledWith({
      rules: ["rating-quality-upgrade"],
      maxProposals: 12,
      plexLibrary: "Library Override",
      plexUrl: "https://plex.override.test",
      plexToken: "plex-secret",
      lidarrUrl: "https://lidarr.override.test",
      lidarrApiKey: "lidarr-secret",
      signal: controller.signal,
    });
    expect(harness.projectPlan).toHaveBeenCalledOnce();
    expect(harness.projectPlan).toHaveBeenCalledWith(result.report.evaluation);
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(result.report.status).toBe("reviewed");
    expect(result.report.summary.artifacts).toBe(0);
    expect(result.execution).toBe(EXECUTION);
  });

  it("uses every refusal as a global plan-mode gate", async () => {
    const harness = createHarness(report([profileProposal(8), discoveryProposal()]));

    const result = await executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies);

    expect(result.report.status).toBe("refused");
    expect(result.report.cohorts).toHaveLength(1);
    expect(result.report.refusals).toHaveLength(1);
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("returns no-changes without dispatching an empty artifact", async () => {
    const harness = createHarness(report([]));

    const result = await executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies);

    expect(result.report.status).toBe("no-changes");
    expect(result.report.summary).toEqual({
      proposals: 0,
      projectable: 0,
      refused: 0,
      artifacts: 0,
    });
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("withholds a suppressed-only plan before any producer or artifact callback", async () => {
    const suppressed = profileProposal(8);
    const harness = createHarness(report([], [retainedSuppression(suppressed)]));
    const onPlanSealed = vi.fn();

    const result = await executeLidarrPolicyPlan(
      { mode: "plan", onPlanSealed },
      harness.dependencies,
    );

    expect(result.report.status).toBe("no-changes");
    expect(result.report.evaluation.summary).toMatchObject({ proposed: 0, suppressed: 1 });
    expect(result.report.evaluation.overrides).toEqual([
      expect.objectContaining({ key: suppressed.key, status: "suppressed", decision: suppressed }),
    ]);
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(onPlanSealed).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when a selected sibling rule is degraded", async () => {
    const harness = createHarness(
      degradedReport([profileProposal(8)], "stale-monitoring-cleanup", "signal-unavailable"),
    );

    await expect(
      executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies),
    ).rejects.toMatchObject({
      name: "PolicyPlanProjectionError",
      decisionKey: "stale-monitoring-cleanup",
      message: "stale-monitoring-cleanup: rule outcome signal-unavailable blocks artifact planning",
    });

    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it.each(["consumption-signal-empty", "rule-error"] as const)(
    "fails closed before no-changes when the selected degraded-only rule reports %s",
    async (skipReason) => {
      const harness = createHarness(degradedReport([], "stale-monitoring-cleanup", skipReason));

      await expect(
        executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies),
      ).rejects.toMatchObject({
        name: "PolicyPlanProjectionError",
        decisionKey: "stale-monitoring-cleanup",
        message: `stale-monitoring-cleanup: rule outcome ${skipReason} blocks artifact planning`,
      });

      expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
      expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    },
  );

  it("seals sequentially in producer order with exact targets, sorted IDs, and cohort caps", async () => {
    const trace: string[] = [];
    const harness = createHarness(
      report([monitoringProposal(5), profileProposal(8), profileProposal(3)]),
    );
    harness.executeArtistProfilePlan.mockImplementation(async () => {
      trace.push("profile");
      return PROFILE_ARTIFACT;
    });
    harness.executeMonitoringPlan.mockImplementation(async () => {
      trace.push("monitoring");
      return MONITORING_ARTIFACT;
    });

    const result = await executeLidarrPolicyPlan(
      {
        mode: "plan",
        lidarrUrl: "https://lidarr.override.test",
        lidarrApiKey: "lidarr-secret",
        onPlanSealed: (outcome) => trace.push(`sealed:${outcome.producer}`),
      },
      harness.dependencies,
    );

    expect(trace).toEqual([
      "profile",
      "sealed:artist-profile-assignment",
      "monitoring",
      "sealed:artist-monitoring",
    ]);
    expect(harness.executeArtistProfilePlan).toHaveBeenCalledWith({
      artistIds: [3, 8],
      qualityProfile: "7",
      maxBatch: 2,
      lidarrUrl: "https://lidarr.override.test",
      lidarrApiKey: "lidarr-secret",
    });
    expect(harness.executeMonitoringPlan).toHaveBeenCalledWith({
      artistIds: [5],
      monitored: false,
      maxBatch: 1,
      lidarrUrl: "https://lidarr.override.test",
      lidarrApiKey: "lidarr-secret",
    });
    expect(result.report.status).toBe("sealed");
    expect(result.report.summary.artifacts).toBe(2);
  });

  it("returns a typed failed result with no raw first-producer error detail", async () => {
    const harness = createHarness(report([profileProposal(3), monitoringProposal(5)]));
    harness.executeArtistProfilePlan.mockRejectedValue(new Error("token=raw-secret"));

    const result = await executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies);

    expect(result.report.status).toBe("failed");
    expect(result.report.outcomes).toEqual([]);
    expect(result.report.failure).toEqual({
      stage: "producer",
      producer: "artist-profile-assignment",
      detail: "artist-profile-assignment plan producer failed",
    });
    expect(JSON.stringify(result.report)).not.toContain("raw-secret");
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("returns partial while preserving and emitting the first sealed outcome", async () => {
    const trace: string[] = [];
    const harness = createHarness(report([profileProposal(3), monitoringProposal(5)]));
    harness.executeMonitoringPlan.mockImplementation(async () => {
      trace.push("monitoring-failed");
      throw new Error("apiKey=raw-secret");
    });

    const result = await executeLidarrPolicyPlan(
      {
        mode: "plan",
        onPlanSealed: (outcome) => trace.push(`sealed:${outcome.producer}`),
      },
      harness.dependencies,
    );

    expect(trace).toEqual(["sealed:artist-profile-assignment", "monitoring-failed"]);
    expect(result.report.status).toBe("partial");
    expect(result.report.outcomes).toEqual([
      expect.objectContaining({
        producer: "artist-profile-assignment",
        decisionKeys: ["rating-quality-upgrade:artist:3"],
        generated: PROFILE_ARTIFACT,
      }),
    ]);
    expect(result.report.failure).toEqual({
      stage: "producer",
      producer: "artist-monitoring",
      detail: "artist-monitoring plan producer failed",
    });
    expect(result.report.summary.artifacts).toBe(1);
    expect(JSON.stringify(result.report)).not.toContain("raw-secret");
  });

  it("returns sanitized partial evidence when cancellation occurs between producers", async () => {
    const harness = createHarness(report([profileProposal(3), monitoringProposal(5)]));
    const controller = new AbortController();

    const result = await executeLidarrPolicyPlan(
      {
        mode: "plan",
        signal: controller.signal,
        onPlanSealed: () => {
          controller.abort(new DOMException("apiKey=raw-secret", "AbortError"));
        },
      },
      harness.dependencies,
    );

    expect(result.report.status).toBe("partial");
    expect(result.report.outcomes).toEqual([
      expect.objectContaining({ producer: "artist-profile-assignment" }),
    ]);
    expect(result.report.failure).toEqual({
      stage: "producer",
      producer: "artist-monitoring",
      detail: "artist-monitoring plan producer failed",
    });
    expect(result.report.summary.artifacts).toBe(1);
    expect(JSON.stringify(result.report)).not.toContain("raw-secret");
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("returns sanitized partial evidence when a later producer aborts", async () => {
    const harness = createHarness(report([profileProposal(3), monitoringProposal(5)]));
    harness.executeMonitoringPlan.mockRejectedValue(
      new DOMException("apiKey=raw-secret", "AbortError"),
    );

    const result = await executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies);

    expect(result.report.status).toBe("partial");
    expect(result.report.outcomes).toEqual([
      expect.objectContaining({ producer: "artist-profile-assignment" }),
    ]);
    expect(result.report.failure).toEqual({
      stage: "producer",
      producer: "artist-monitoring",
      detail: "artist-monitoring plan producer failed",
    });
    expect(result.report.summary.artifacts).toBe(1);
    expect(JSON.stringify(result.report)).not.toContain("raw-secret");
  });

  it("rejects a pre-aborted run before evaluation, projection, or producer dispatch", async () => {
    const harness = createHarness(report([profileProposal(3)]));
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeLidarrPolicyPlan({ mode: "plan", signal: controller.signal }, harness.dependencies),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.executeEvaluate).not.toHaveBeenCalled();
    expect(harness.projectPlan).not.toHaveBeenCalled();
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("propagates projection errors unchanged before producer dispatch", async () => {
    const harness = createHarness(report([profileProposal(3)]));
    const failure = new Error("projection invariant failed");
    harness.projectPlan.mockImplementation(() => {
      throw failure;
    });

    await expect(executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies)).rejects.toBe(
      failure,
    );

    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("propagates producer cancellation instead of converting it to a failed report", async () => {
    const harness = createHarness(report([profileProposal(3), monitoringProposal(5)]));
    const failure = new DOMException("cancelled", "AbortError");
    harness.executeArtistProfilePlan.mockRejectedValue(failure);

    await expect(executeLidarrPolicyPlan({ mode: "plan" }, harness.dependencies)).rejects.toBe(
      failure,
    );

    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });
});
