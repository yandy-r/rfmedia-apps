/**
 * The seven `sync-ratings.ts` behaviours that decide whether this command can
 * mutate Lidarr by accident (issue #221, design §8.2).
 *
 * The pure projection and the threshold resolver are the REAL ones: they perform
 * zero I/O, and injecting stubs for them would prove the wiring against a fake
 * gate instead of the shipped one. Only the I/O seams — evaluate, the two
 * producers, apply, the loaded config, and the approval prompt — are `vi.fn()`s,
 * and no Lidarr client or Plex adapter module is mocked at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildRatingSyncPlan, resolveSyncRatingsThresholds } from "../../lib/bridge/rating-sync.js";
import { buildLidarrMutationPlanV3 } from "../../lib/lidarr/plan-engine.js";
import { clearMocksPreservingImplementations } from "../../test-utils/mock-lifecycle.js";
import { POLICY_ENGINE_VERSION, POLICY_EVALUATION_SCHEMA } from "../../types/lidarr-policy.js";
import { executeLidarrSyncRatings } from "./sync-ratings.js";
import type { BuildLidarrMutationPlanV3Input } from "../../lib/lidarr/plan-engine.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { PolicyConfigOptions } from "../../types/config.js";
import type {
  LidarrCascadePolicy,
  LidarrMutationPlanV3,
  LidarrPlanApplyResult,
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
import type { LidarrSyncRatingsPlan } from "../../types/lidarr-sync-ratings.js";
import type { LidarrPolicyEvaluateActionResult } from "./policy-evaluate.js";
import type { LidarrSyncRatingsDependencies } from "./sync-ratings.js";

const CURRENT_FINGERPRINT = `sha256:${"a".repeat(64)}` as PolicyDecisionEvidenceFingerprint;

/* ── Report fixture ──────────────────────────────────────────────────────── */

const IDENTITY: PolicyIdentityBasis = { category: "authoritative", reason: "unique-exact-mbid" };

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

const RATING_PROPOSAL: PolicyEvaluatedProposal = {
  key: "rating-quality-upgrade:artist:4",
  ruleId: "rating-quality-upgrade",
  code: "rating-below-target-profile",
  subject: {
    kind: "artist",
    name: "Artist 4",
    plexId: "p4",
    artistId: 4,
    artistMbid: "mbid-4",
  },
  identity: IDENTITY,
  before: { qualityProfileId: 3, qualityProfileName: "MP3-320" },
  after: { qualityProfileId: 7, qualityProfileName: "FLAC" },
  checks: [],
  observations: { rating: { status: "observed", value: 5, join: "exact-plex-id" } },
  summary: "Rated 5 stars in Plex while assigned a lower quality profile.",
  handoff: { producer: "artist-profile-assignment", argv: ["lidarr", "plan", "artist-profiles"] },
  evidenceFingerprint: CURRENT_FINGERPRINT,
};

const MONITORING_PROPOSAL: PolicyEvaluatedProposal = {
  key: "stale-monitoring-cleanup:artist:9",
  ruleId: "stale-monitoring-cleanup",
  code: "monitored-artist-unconsumed",
  subject: {
    kind: "artist",
    name: "Artist 9",
    plexId: "p9",
    artistId: 9,
    artistMbid: "mbid-9",
  },
  identity: IDENTITY,
  before: { monitored: true },
  after: { monitored: false },
  checks: [],
  observations: { plays: { status: "observed", value: 0, join: "normalized-name" } },
  summary: "Monitored in Lidarr with no demonstrated Plex consumption.",
  handoff: { producer: "artist-monitoring", argv: ["lidarr", "plan", "artist-monitoring"] },
  evidenceFingerprint: CURRENT_FINGERPRINT,
};

function evaluatedRule(id: PolicyRuleId): PolicyRuleResult {
  return { id, title: id, status: "proposals", proposedCount: 1, skippedCount: 0 };
}

function notSelectedRule(id: PolicyRuleId): PolicyRuleResult {
  return { id, title: id, status: "skipped", skipReason: "not-selected", detail: "not selected" };
}

const EXECUTION: LidarrExecutionSuccessMetadata = {
  taskId: "lidarr-policy-evaluate",
  operation: "lidarr policy evaluate",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
};

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

interface EvaluationParts {
  readonly rules?: readonly PolicyRuleResult[];
  readonly proposals?: readonly PolicyEvaluatedProposal[];
  readonly overrides?: readonly PolicyOverrideResult[];
}

function buildEvaluation(parts: EvaluationParts = {}): LidarrPolicyEvaluateActionResult {
  const rules = parts.rules ?? [
    evaluatedRule("rating-quality-upgrade"),
    evaluatedRule("stale-monitoring-cleanup"),
    notSelectedRule("discovery-seed"),
  ];
  const proposals =
    parts.proposals ??
    [RATING_PROPOSAL, MONITORING_PROPOSAL].filter(
      (proposal) => rules.find((rule) => rule.id === proposal.ruleId)?.status !== "skipped",
    );
  const overrides = parts.overrides ?? [];
  const report: PolicyEvaluationReport = {
    schema: POLICY_EVALUATION_SCHEMA,
    engineVersion: POLICY_ENGINE_VERSION,
    evaluatedAt: "2026-07-28T12:00:00.000Z",
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
      rulesRun: rules.filter((rule) => rule.status !== "skipped").length,
      rulesSkipped: rules.filter((rule) => rule.status === "skipped").length,
    },
    rules,
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
      totalPlaysObserved: 250,
    },
  };
  return { report, execution: EXECUTION };
}

/* ── Artifact fixtures ───────────────────────────────────────────────────── */

const CASCADE_POLICY: LidarrCascadePolicy = {
  assumptions: { albumsPerArtist: 2, indexerQueriesPerCandidate: 3 },
  budgets: { indexerQueries: 8, acquisitionCandidates: 4 },
};

/** The exact arms the two producers declare; each mock must return its own. */
type ProfilePlanV3 = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-profile-assignment" } }
>;
type MonitoringPlanV3 = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" } }
>;

function isProfilePlan(plan: LidarrMutationPlanV3): plan is ProfilePlanV3 {
  return plan.operation.kind === "artist-profile-assignment";
}

function isMonitoringPlan(plan: LidarrMutationPlanV3): plan is MonitoringPlanV3 {
  return plan.operation.kind === "artist-monitoring";
}

function sealArtifact<TPlan extends LidarrMutationPlanV3>(
  input: BuildLidarrMutationPlanV3Input,
  planId: string,
  isExpectedKind: (plan: LidarrMutationPlanV3) => plan is TPlan,
): LidarrPlanGenerationResultV3<TPlan> {
  const plan = buildLidarrMutationPlanV3(input, {
    randomUUID: () => planId,
    now: () => new Date("2026-07-28T12:00:00.000Z"),
    hostname: () => "sync-host",
    username: () => "sync-user",
    cwd: () => "/sync/cwd",
    cliVersion: "0.5.0-sync",
  });
  if (!isExpectedKind(plan)) {
    throw new Error(`fixture built an unexpected plan kind: ${plan.operation.kind}`);
  }
  return { planPath: `/plans/${planId}.json`, plan };
}

const PROFILE_ARTIFACT = sealArtifact(
  {
    origin: "https://lidarr.example.test",
    selection: { kind: "ids", artistIds: [4] },
    operation: { kind: "artist-profile-assignment", qualityProfile: { id: 7, name: "FLAC" } },
    maxBatch: 1,
    entries: [
      {
        kind: "artist-profile-assignment",
        artistId: 4,
        artistName: "Artist 4",
        qualityProfile: { id: 3, name: "MP3-320" },
      },
    ],
    cascadePolicy: CASCADE_POLICY,
  },
  "11111111-1111-4111-8111-111111111111",
  isProfilePlan,
);

const MONITORING_ARTIFACT = sealArtifact(
  {
    origin: "https://lidarr.example.test",
    selection: { kind: "ids", artistIds: [9] },
    operation: { kind: "artist-monitoring", desiredMonitored: false },
    maxBatch: 1,
    entries: [{ kind: "artist-monitoring", artistId: 9, artistName: "Artist 9", monitored: true }],
    cascadePolicy: CASCADE_POLICY,
  },
  "22222222-2222-4222-8222-222222222222",
  isMonitoringPlan,
);

function applyResultFor(
  generated: LidarrPlanGenerationResultV3<LidarrSyncRatingsPlan>,
): LidarrPlanApplyResult {
  return {
    planId: generated.plan.id,
    planChecksum: generated.plan.payloadChecksum,
    planPath: generated.planPath,
    status: "completed",
    dryRun: false,
    resumed: false,
    risk: generated.plan.risk,
    cascadeAnalysis: { status: "recorded", analysis: generated.plan.cascadeAnalysis },
    summary: {
      total: 1,
      succeeded: 1,
      satisfied: 0,
      failed: 0,
      deferred: 0,
      uncertain: 0,
      blockedStale: 0,
      notAttempted: 0,
      skippedResume: 0,
      wouldApply: 0,
    },
    entries: [],
  };
}

/* ── Harness ─────────────────────────────────────────────────────────────── */

interface Harness {
  readonly dependencies: LidarrSyncRatingsDependencies;
  readonly executeEvaluate: ReturnType<typeof vi.fn>;
  readonly executeArtistProfilePlan: ReturnType<typeof vi.fn>;
  readonly executeMonitoringPlan: ReturnType<typeof vi.fn>;
  readonly executeApply: ReturnType<typeof vi.fn>;
  readonly confirm: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  readonly config?: PolicyConfigOptions;
  readonly rules?: readonly PolicyRuleResult[];
  readonly evaluation?: LidarrPolicyEvaluateActionResult;
  readonly approve?: boolean;
  readonly trace?: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const trace = options.trace;
  const executeEvaluate = vi.fn(
    async () => options.evaluation ?? buildEvaluation({ rules: options.rules }),
  );
  const executeArtistProfilePlan = vi.fn(async () => PROFILE_ARTIFACT);
  const executeMonitoringPlan = vi.fn(async () => MONITORING_ARTIFACT);
  const executeApply = vi.fn(async () => {
    trace?.push("apply");
    return applyResultFor(PROFILE_ARTIFACT);
  });
  const confirm = vi.fn(async () => options.approve === true);
  const dependencies = {
    executeEvaluate,
    buildPlan: buildRatingSyncPlan,
    resolveThresholds: resolveSyncRatingsThresholds,
    executeArtistProfilePlan,
    executeMonitoringPlan,
    executeApply,
    loadedPolicyConfig: vi.fn(() => options.config),
    confirm,
  } satisfies LidarrSyncRatingsDependencies;

  return {
    dependencies,
    executeEvaluate,
    executeArtistProfilePlan,
    executeMonitoringPlan,
    executeApply,
    confirm,
  };
}

beforeEach(() => {
  clearMocksPreservingImplementations();
});

/* ── Cases ───────────────────────────────────────────────────────────────── */

describe("executeLidarrSyncRatings — the read-only default", () => {
  it("seals nothing and applies nothing in recommend mode", async () => {
    const harness = createHarness();

    const result = await executeLidarrSyncRatings({ mode: "recommend" }, harness.dependencies);

    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(harness.executeApply).not.toHaveBeenCalled();
    expect(result.report.outcomes).toEqual([]);
    // Not for lack of changes: both cohorts were sealable and were still left alone.
    expect(result.report.cohorts.map((cohort) => cohort.gate)).toEqual(["sealable", "sealable"]);
    expect(result.execution).toBe(EXECUTION);
  });
});

describe("executeLidarrSyncRatings — producer routing", () => {
  it("binds each producer to its own cohort, its own maxBatch, and the resolved profile id", async () => {
    const harness = createHarness();

    const result = await executeLidarrSyncRatings({ mode: "plan" }, harness.dependencies);

    expect(harness.executeArtistProfilePlan).toHaveBeenCalledTimes(1);
    expect(harness.executeArtistProfilePlan).toHaveBeenCalledWith({
      artistIds: [4],
      qualityProfile: "7",
      maxBatch: 1,
      lidarrUrl: undefined,
      lidarrApiKey: undefined,
    });
    expect(harness.executeMonitoringPlan).toHaveBeenCalledTimes(1);
    expect(harness.executeMonitoringPlan).toHaveBeenCalledWith({
      artistIds: [9],
      monitored: false,
      maxBatch: 1,
      lidarrUrl: undefined,
      lidarrApiKey: undefined,
    });
    expect(harness.executeApply).not.toHaveBeenCalled();
    expect(result.report.outcomes.map((outcome) => outcome.producer)).toEqual([
      "artist-profile-assignment",
      "artist-monitoring",
    ]);
  });

  it("wires the raw enabled tri-state to force-enable and to the disable gate", async () => {
    const harness = createHarness({
      config: { rules: { "stale-monitoring-cleanup": { enabled: false } } },
    });

    const result = await executeLidarrSyncRatings({ mode: "plan" }, harness.dependencies);

    expect(harness.executeEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: ["rating-quality-upgrade", "stale-monitoring-cleanup"],
        forceEnableRules: new Set(["rating-quality-upgrade"]),
      }),
    );
    expect(result.report.decisionStates).toEqual({
      "quality-profile": "unset",
      monitoring: "off",
    });
    expect(harness.executeArtistProfilePlan).toHaveBeenCalledTimes(1);
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
  });

  it("leaves a skipped rule's producer uncalled while its sibling still seals", async () => {
    const harness = createHarness({
      rules: [
        evaluatedRule("rating-quality-upgrade"),
        {
          id: "stale-monitoring-cleanup",
          title: "stale-monitoring-cleanup",
          status: "skipped",
          skipReason: "consumption-signal-empty",
          detail: "the resolved Plex token observed zero library-wide plays",
        },
        notSelectedRule("discovery-seed"),
      ],
    });

    const result = await executeLidarrSyncRatings({ mode: "plan" }, harness.dependencies);

    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(harness.executeArtistProfilePlan).toHaveBeenCalledTimes(1);
    expect(result.report.refusals.map((refusal) => refusal.code)).toEqual(["rule-not-evaluated"]);
  });
});

describe("executeLidarrSyncRatings — the mutation gates", () => {
  it("withholds suppressed-only apply input before producers, artifact callbacks, or approval", async () => {
    const evaluation = buildEvaluation({
      proposals: [],
      overrides: [retainedSuppression(RATING_PROPOSAL), retainedSuppression(MONITORING_PROPOSAL)],
      rules: [
        {
          id: "rating-quality-upgrade",
          title: "rating-quality-upgrade",
          status: "clean",
          proposedCount: 0,
          skippedCount: 0,
        },
        {
          id: "stale-monitoring-cleanup",
          title: "stale-monitoring-cleanup",
          status: "clean",
          proposedCount: 0,
          skippedCount: 0,
        },
        {
          id: "discovery-seed",
          title: "discovery-seed",
          status: "skipped",
          skipReason: "not-selected",
          detail: "rule was not selected",
        },
      ],
    });
    const harness = createHarness({ evaluation, approve: true });
    const onPlanSealed = vi.fn();

    const result = await executeLidarrSyncRatings(
      { mode: "apply", onPlanSealed },
      harness.dependencies,
    );

    expect(result.report.evaluation.summary).toMatchObject({ proposed: 0, suppressed: 2 });
    expect(result.report.cohorts.map((cohort) => cohort.gate)).toEqual([
      "no-changes",
      "no-changes",
    ]);
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(onPlanSealed).not.toHaveBeenCalled();
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.executeApply).not.toHaveBeenCalled();
  });

  it("applies each artifact only behind an approval, pinning its id and checksum", async () => {
    const approved = createHarness({ approve: true });

    const granted = await executeLidarrSyncRatings({ mode: "apply" }, approved.dependencies);

    expect(approved.confirm).toHaveBeenCalledTimes(2);
    expect(approved.executeApply).toHaveBeenCalledTimes(2);
    expect(approved.executeApply).toHaveBeenNthCalledWith(1, {
      planPath: PROFILE_ARTIFACT.planPath,
      dryRun: false,
      approved: true,
      expectedPlanId: PROFILE_ARTIFACT.plan.id,
      expectedPlanChecksum: PROFILE_ARTIFACT.plan.payloadChecksum,
      lidarrUrl: undefined,
      lidarrApiKey: undefined,
      signal: undefined,
    });
    expect(granted.report.outcomes.every((outcome) => outcome.apply !== undefined)).toBe(true);

    const declined = createHarness();

    const refused = await executeLidarrSyncRatings({ mode: "apply" }, declined.dependencies);

    expect(declined.executeApply).not.toHaveBeenCalled();
    expect(refused.report.outcomes.every((outcome) => outcome.apply === undefined)).toBe(true);
  });

  it("emits every sealed artifact path before the first apply runs", async () => {
    const trace: string[] = [];
    const harness = createHarness({ approve: true, trace });

    await executeLidarrSyncRatings(
      {
        mode: "apply",
        onPlanSealed: (outcome) => trace.push(`sealed:${outcome.producer}`),
      },
      harness.dependencies,
    );

    expect(trace).toEqual([
      "sealed:artist-profile-assignment",
      "sealed:artist-monitoring",
      "apply",
      "apply",
    ]);
  });

  it("rejects a pre-aborted run before the evaluation or either producer", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeLidarrSyncRatings({ mode: "apply", signal: controller.signal }, harness.dependencies),
    ).rejects.toThrow();

    expect(harness.executeEvaluate).not.toHaveBeenCalled();
    expect(harness.executeArtistProfilePlan).not.toHaveBeenCalled();
    expect(harness.executeMonitoringPlan).not.toHaveBeenCalled();
    expect(harness.executeApply).not.toHaveBeenCalled();
  });
});
