/**
 * Command-boundary suite for `rfmedia lidarr policy evaluate|plan`.
 *
 * The command layer owns the output boundary and the exit code, so a regression
 * here is invisible to every pure test in the feature. Four things are pinned:
 * the stdout/stderr split, the lazy-load contract (a validation failure must
 * never reach `loadActions`), the render-then-gate ordering of `--fail-on`, and
 * the redacted failure envelope.
 *
 * The declared option surface is asserted against
 * {@link LIDARR_POLICY_EVALUATE_OPTION_LONGS} — the same const
 * `src/lib/shell-completions/templates.spec.ts` asserts its completion tuple
 * against. This file is the only thing in the repo that reconciles the leaf's
 * Commander options with the generated completion templates.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutputFormat } from "@rfmedia/common";

import type {
  LidarrPolicyEvaluateActionResult,
  LidarrPolicyPlanActionOptions,
  LidarrPolicyPlanActionResult,
} from "../actions/lidarr/index.js";
import { buildLidarrMutationPlanV3 } from "../lib/lidarr/plan-engine.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type { LidarrCascadePolicy, LidarrMutationPlanV3 } from "../types/lidarr-plan.js";
import {
  LIDARR_POLICY_EVALUATE_OPTION_LONGS,
  POLICY_ENGINE_VERSION,
  POLICY_EVALUATION_SCHEMA,
} from "../types/lidarr-policy.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyEvaluatedProposal,
  PolicyEvaluationReport,
  PolicyOverrideResult,
  PolicySkip,
} from "../types/lidarr-policy.js";
import {
  LIDARR_POLICY_PLAN_OPTION_LONGS,
  POLICY_PLAN_SCHEMA,
} from "../types/lidarr-policy-plan.js";
import { LIDARR_POLICY_EVALUATE_CSV_COLUMNS } from "./lidarr-policy-presenter.js";
import type {
  LidarrPolicyPlanReport,
  PolicyPlanCohort,
  PolicyPlanOutcome,
  PolicyPlanRefusal,
} from "../types/lidarr-policy-plan.js";

const mockFormatOutput = vi.hoisted(() => vi.fn());

vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mockFormatOutput,
}));

import { createLidarrPolicyCommand, parsePolicyRuleIds } from "./lidarr-policy.js";

const EXECUTION: LidarrExecutionSuccessMetadata = Object.freeze({
  taskId: "lidarr-policy-evaluate",
  operation: "lidarr policy evaluate",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
});

const CURRENT_FINGERPRINT = `sha256:${"a".repeat(64)}` as PolicyDecisionEvidenceFingerprint;
const EXPECTED_FINGERPRINT = `sha256:${"b".repeat(64)}` as PolicyDecisionEvidenceFingerprint;
const LAST_VIEWED_AT = 1_767_225_600;
const LAST_VIEWED_AT_ISO = "2026-01-01T00:00:00.000Z";

const PROPOSAL: PolicyEvaluatedProposal = Object.freeze({
  key: "stale-monitoring-cleanup:artist:233",
  ruleId: "stale-monitoring-cleanup",
  code: "monitored-artist-unconsumed",
  subject: Object.freeze({
    kind: "artist",
    name: "Generic Chillhop",
    plexId: "29104",
    artistId: 233,
    artistMbid: "c8da2e40-bd28-4d4e-813a-bd2f51958ba8",
  }),
  identity: Object.freeze({ category: "authoritative", reason: "unique-exact-mbid" }),
  before: Object.freeze({ monitored: true }),
  after: Object.freeze({ monitored: false }),
  checks: Object.freeze([
    Object.freeze({
      signal: "plexTrackPlays",
      label: "plays",
      comparator: "<=",
      bound: 0,
      observed: 0,
      satisfied: true,
      configPath: "policy.rules.stale-monitoring-cleanup.maxPlays",
    }),
    Object.freeze({
      signal: "plexTrackPlays",
      label: "lastViewedAt",
      comparator: "older-than-days",
      bound: 90,
      observed: LAST_VIEWED_AT_ISO,
      satisfied: true,
      configPath: "policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed",
    }),
  ]),
  observations: Object.freeze({
    plays: Object.freeze({
      status: "observed",
      value: 0,
      join: "normalized-name",
      sampleSize: 31,
    }),
    lastViewedAt: Object.freeze({
      status: "observed",
      value: LAST_VIEWED_AT,
      join: "normalized-name",
      sampleSize: 31,
    }),
  }),
  summary:
    "0 plays and unrated in Plex while monitored in Lidarr. Last viewed 208 whole days before evaluation.",
  handoff: Object.freeze({
    producer: "artist-monitoring",
    argv: Object.freeze(["lidarr", "plan", "artist-monitoring", "--ids", "233", "--unmonitored"]),
  }),
  evidenceFingerprint: CURRENT_FINGERPRINT,
});

const SKIP: PolicySkip = Object.freeze({
  key: "stale-monitoring-cleanup:plex:31402",
  ruleId: "stale-monitoring-cleanup",
  code: "identity-not-authoritative",
  subject: Object.freeze({
    kind: "artist",
    name: "Aphex Twin",
    plexId: "31402",
    artistMbid: null,
  }),
  identity: Object.freeze({ category: "review-fuzzy-name", reason: "unique-fuzzy-name" }),
  checks: Object.freeze([]),
  detail: "review-grade name evidence is never auto-consumed by a policy decision",
});

function createRecencyRefusal(
  artistId: number,
  coverage: "no-recency-coverage" | "partial-recency-coverage",
): PolicySkip {
  return Object.freeze({
    key: `stale-monitoring-cleanup:artist:${artistId}`,
    ruleId: "stale-monitoring-cleanup",
    code: "signal-unavailable",
    subject: Object.freeze({
      kind: "artist",
      name: coverage === "no-recency-coverage" ? "No Recency Artist" : "Partial Recency Artist",
      plexId: String(29_000 + artistId),
      artistId,
      artistMbid: "c8da2e40-bd28-4d4e-813a-bd2f51958ba8",
    }),
    identity: Object.freeze({ category: "authoritative", reason: "unique-exact-mbid" }),
    checks: Object.freeze([]),
    detail: `${coverage}: no trustworthy Plex last-viewed timestamp is available for this artist`,
  });
}

const NO_RECENCY_REFUSAL = createRecencyRefusal(235, "no-recency-coverage");
const PARTIAL_RECENCY_REFUSAL = createRecencyRefusal(236, "partial-recency-coverage");

const SUPPRESSED_PROPOSAL: PolicyEvaluatedProposal = Object.freeze({
  ...PROPOSAL,
  key: "stale-monitoring-cleanup:artist:234",
  subject: Object.freeze({
    ...PROPOSAL.subject,
    name: "Reviewed Artist",
    plexId: "29105",
    artistId: 234,
  }),
  handoff: Object.freeze({
    producer: "artist-monitoring",
    argv: Object.freeze(["lidarr", "plan", "artist-monitoring", "--ids", "234", "--unmonitored"]),
  }),
});

const SUPPRESSED_OVERRIDE: PolicyOverrideResult = Object.freeze({
  key: SUPPRESSED_PROPOSAL.key,
  action: "suppress",
  status: "suppressed",
  staleReason: null,
  reason: "Compilation listening is intentionally excluded",
  expectedEvidenceFingerprint: CURRENT_FINGERPRINT,
  currentEvidenceFingerprint: CURRENT_FINGERPRINT,
  decision: SUPPRESSED_PROPOSAL,
});

const STALE_OVERRIDE: PolicyOverrideResult = Object.freeze({
  ...SUPPRESSED_OVERRIDE,
  key: PROPOSAL.key,
  status: "stale",
  staleReason: "evidence-changed",
  reason: "Compilation listening is not represented by the artist-name play join",
  expectedEvidenceFingerprint: EXPECTED_FINGERPRINT,
  decision: PROPOSAL,
});

const NOT_EVALUATED_OVERRIDE: PolicyOverrideResult = Object.freeze({
  ...SUPPRESSED_OVERRIDE,
  key: "rating-quality-upgrade:artist:88",
  status: "not-evaluated",
  staleReason: null,
  reason: "Quality profile is intentionally managed outside this run",
  expectedEvidenceFingerprint: EXPECTED_FINGERPRINT,
  currentEvidenceFingerprint: null,
  decision: null,
});

const OUTCOME_CHANGED_OVERRIDE: PolicyOverrideResult = Object.freeze({
  ...NOT_EVALUATED_OVERRIDE,
  key: SKIP.key,
  status: "stale",
  staleReason: "outcome-changed",
  reason: "The reviewed proposal is now refused by an identity safety gate",
  decision: SKIP,
});

const ABSENT_OVERRIDE: PolicyOverrideResult = Object.freeze({
  ...NOT_EVALUATED_OVERRIDE,
  key: "discovery-seed:plex:404",
  status: "stale",
  staleReason: "decision-absent",
  reason: "The historical seed no longer appears in the completed evaluation",
});

function createReport(overrides: Partial<PolicyEvaluationReport> = {}): PolicyEvaluationReport {
  return {
    schema: POLICY_EVALUATION_SCHEMA,
    engineVersion: POLICY_ENGINE_VERSION,
    evaluatedAt: "2026-07-28T18:04:11.000Z",
    plexOrigin: "https://plex.example.test",
    lidarrOrigin: "https://lidarr.example.test",
    plexLibrary: "Music",
    status: "proposals",
    policy: {
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
          enabled: true,
          maxPlays: 0,
          minDaysSinceLastViewed: 90,
          protectRatingAtOrAbove: 4,
          requireTrackCoverage: true,
          minTrackFileCount: 1,
          maxProposals: 25,
        },
        "discovery-seed": {
          kind: "discovery-seed",
          enabled: false,
          minRating: 4,
          minPlays: null,
          maxSeeds: 25,
        },
      },
    },
    signals: {
      bridgeIdentity: { status: "available" },
      lidarrArtists: { status: "available" },
      lidarrQualityProfiles: { status: "available" },
      plexArtistRatings: { status: "available" },
      plexTrackPlays: { status: "available" },
    },
    summary: {
      proposed: 1,
      skipped: 1,
      suppressed: 0,
      staleOverrides: 0,
      notEvaluatedOverrides: 0,
      rulesRun: 1,
      rulesSkipped: 2,
    },
    rules: [
      {
        id: "rating-quality-upgrade",
        title: "Rating-informed quality upgrade",
        status: "skipped",
        skipReason: "disabled",
        detail: "disabled in policy.rules.rating-quality-upgrade.enabled",
      },
      {
        id: "stale-monitoring-cleanup",
        title: "Stale monitoring cleanup",
        status: "proposals",
        proposedCount: 1,
        skippedCount: 1,
      },
      {
        id: "discovery-seed",
        title: "Discovery seed generation",
        status: "skipped",
        skipReason: "disabled",
        detail: "disabled in policy.rules.discovery-seed.enabled",
      },
    ],
    proposals: [PROPOSAL],
    skips: [SKIP],
    overrides: [],
    coverage: {
      plexArtistsExamined: 604,
      plexTracksExamined: 18220,
      authoritativeLinks: 586,
      nonAuthoritativeArtists: 18,
      ambiguousNameArtists: 1,
      sentinelArtistTracks: 12,
      unjoinedTracks: 4,
      totalPlaysObserved: 18204,
    },
    ...overrides,
  };
}

function createWithheldReport(
  configuredOverrides: readonly PolicyOverrideResult[],
): PolicyEvaluationReport {
  const base = createReport();
  return createReport({
    status: "clean",
    summary: {
      proposed: 0,
      skipped: base.skips.length,
      suppressed: configuredOverrides.filter((override) => override.status === "suppressed").length,
      staleOverrides: configuredOverrides.filter((override) => override.status === "stale").length,
      notEvaluatedOverrides: configuredOverrides.filter(
        (override) => override.status === "not-evaluated",
      ).length,
      rulesRun: 1,
      rulesSkipped: 2,
    },
    rules: base.rules.map((rule) =>
      rule.id === "stale-monitoring-cleanup" && rule.status !== "skipped"
        ? {
            ...rule,
            status: "clean",
            proposedCount: 0,
          }
        : rule,
    ),
    proposals: [],
    overrides: configuredOverrides,
  });
}

function createResult(
  report: PolicyEvaluationReport = createReport(),
): LidarrPolicyEvaluateActionResult {
  return { report, execution: EXECUTION };
}

const PLAN_COHORT: PolicyPlanCohort = Object.freeze({
  producer: "artist-monitoring",
  monitored: false,
  artistIds: Object.freeze([233] as const),
  changes: Object.freeze([
    Object.freeze({
      decisionKey: PROPOSAL.key,
      ruleId: PROPOSAL.ruleId,
      artistId: 233,
      artistName: PROPOSAL.subject.name,
      before: PROPOSAL.before,
      after: PROPOSAL.after,
      checks: PROPOSAL.checks,
      summary: PROPOSAL.summary,
    }),
  ] as const),
});

const PLAN_REFUSAL: PolicyPlanRefusal = Object.freeze({
  decisionKey: PROPOSAL.key,
  code: "conflicting-intent",
  producer: "artist-monitoring",
  artistId: 233,
  detail: "artist 233 has conflicting policy intents",
  remedy: "narrow the selected rules and review again",
});

const CASCADE_POLICY: LidarrCascadePolicy = Object.freeze({
  assumptions: Object.freeze({ albumsPerArtist: 2, indexerQueriesPerCandidate: 3 }),
  budgets: Object.freeze({ indexerQueries: 8, acquisitionCandidates: 4 }),
});

type MonitoringPlan = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" } }
>;

function assertMonitoringPlan(plan: LidarrMutationPlanV3): asserts plan is MonitoringPlan {
  if (plan.operation.kind !== "artist-monitoring") {
    throw new Error("policy command fixture must build an artist-monitoring plan");
  }
}

const BUILT_PLAN = buildLidarrMutationPlanV3(
  {
    origin: "https://lidarr.example.test",
    selection: { kind: "ids", artistIds: [233] },
    operation: { kind: "artist-monitoring", desiredMonitored: false },
    maxBatch: 1,
    entries: [
      {
        kind: "artist-monitoring",
        artistId: 233,
        artistName: "Generic Chillhop",
        monitored: true,
      },
    ],
    cascadePolicy: CASCADE_POLICY,
  },
  {
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    hostname: () => "policy-host",
    username: () => "policy-user",
    cwd: () => "/policy/cwd",
    cliVersion: "0.5.0-policy",
  },
);

assertMonitoringPlan(BUILT_PLAN);

const PLAN_OUTCOME: PolicyPlanOutcome = Object.freeze({
  producer: "artist-monitoring",
  decisionKeys: Object.freeze([PROPOSAL.key] as const),
  generated: Object.freeze({
    planPath: "/plans/policy monitoring.json",
    plan: BUILT_PLAN,
  }),
});

function createPlanReport(
  state:
    | "reviewed"
    | "reviewed-refusal"
    | "no-changes"
    | "refused"
    | "sealed"
    | "partial"
    | "failed" = "reviewed",
): LidarrPolicyPlanReport {
  const evaluation = createReport();
  const base = { schema: POLICY_PLAN_SCHEMA, evaluation } as const;
  switch (state) {
    case "reviewed":
      return {
        ...base,
        mode: "recommend",
        status: "reviewed",
        cohorts: [PLAN_COHORT],
        refusals: [],
        outcomes: [],
        summary: { proposals: 1, projectable: 1, refused: 0, artifacts: 0 },
      };
    case "reviewed-refusal":
      return {
        ...base,
        mode: "recommend",
        status: "reviewed",
        cohorts: [],
        refusals: [PLAN_REFUSAL],
        outcomes: [],
        summary: { proposals: 1, projectable: 0, refused: 1, artifacts: 0 },
      };
    case "no-changes":
      return {
        ...base,
        mode: "plan",
        status: "no-changes",
        evaluation: createReport({
          status: "clean",
          proposals: [],
          summary: {
            proposed: 0,
            skipped: 1,
            suppressed: 0,
            staleOverrides: 0,
            notEvaluatedOverrides: 0,
            rulesRun: 1,
            rulesSkipped: 2,
          },
        }),
        cohorts: [],
        refusals: [],
        outcomes: [],
        summary: { proposals: 0, projectable: 0, refused: 0, artifacts: 0 },
      };
    case "refused":
      return {
        ...base,
        mode: "plan",
        status: "refused",
        cohorts: [],
        refusals: [PLAN_REFUSAL],
        outcomes: [],
        summary: { proposals: 1, projectable: 0, refused: 1, artifacts: 0 },
      };
    case "sealed":
      return {
        ...base,
        mode: "plan",
        status: "sealed",
        cohorts: [PLAN_COHORT],
        refusals: [],
        outcomes: [PLAN_OUTCOME],
        summary: { proposals: 1, projectable: 1, refused: 0, artifacts: 1 },
      };
    case "partial":
      return {
        ...base,
        mode: "plan",
        status: "partial",
        cohorts: [PLAN_COHORT],
        refusals: [],
        outcomes: [PLAN_OUTCOME],
        failure: {
          stage: "producer",
          producer: "artist-profile-assignment",
          detail: "artist-profile-assignment plan producer failed",
        },
        summary: { proposals: 1, projectable: 1, refused: 0, artifacts: 1 },
      };
    case "failed":
      return {
        ...base,
        mode: "plan",
        status: "failed",
        cohorts: [PLAN_COHORT],
        refusals: [],
        outcomes: [],
        failure: {
          stage: "producer",
          producer: "artist-monitoring",
          detail: "artist-monitoring plan producer failed",
        },
        summary: { proposals: 1, projectable: 1, refused: 0, artifacts: 0 },
      };
  }
}

function createPlanResult(report = createPlanReport()): LidarrPolicyPlanActionResult {
  return { report, execution: EXECUTION };
}

function redact(message: string, sensitiveValues: readonly unknown[] | undefined): string {
  let output = message;
  for (const value of sensitiveValues ?? []) {
    if (typeof value === "string" && value.length > 0) {
      output = output.split(value).join("[REDACTED]");
    }
  }
  return output;
}

function createHarness(
  format: OutputFormat = "text",
  result: LidarrPolicyEvaluateActionResult = createResult(),
  planResult: LidarrPolicyPlanActionResult = createPlanResult(),
) {
  const executeLidarrPolicyEvaluate = vi.fn().mockResolvedValue(result);
  const executeLidarrPolicyPlan = vi.fn(async (options: LidarrPolicyPlanActionOptions) => {
    options.validateEvaluation?.(planResult.report.evaluation);
    return planResult;
  });
  const loadActions = vi.fn().mockResolvedValue({
    executeLidarrPolicyEvaluate,
    executeLidarrPolicyPlan,
  });
  const processSignal = new AbortController().signal;
  const resolveSignal = vi.fn(() => processSignal);
  const renderExecutionSummary = vi.fn();
  const parseIdList = vi.fn(() => [] as number[]);
  const reportLidarrFailure = vi.fn(
    async (
      subcommand: string,
      error: unknown,
      options: {
        readonly format: OutputFormat;
        readonly sensitiveValues?: readonly unknown[];
      },
    ) => {
      const raw = error instanceof Error ? error.message : String(error);
      await mockFormatOutput(options.format, {
        command: `lidarr-${subcommand}`,
        error: { message: redact(raw, options.sensitiveValues), outcome: "failed" },
      });
      process.exitCode = 1;
    },
  );
  const policy = createLidarrPolicyCommand({
    resolveFormat: () => format,
    reportLidarrFailure,
    renderExecutionSummary,
    parseIdList,
    resolveSignal,
    loadActions,
  });
  const evaluate = policy.commands.find((command) => command.name() === "evaluate");
  if (evaluate === undefined) {
    throw new Error("the policy parent must carry an evaluate leaf");
  }
  const plan = policy.commands.find((command) => command.name() === "plan");
  if (plan === undefined) {
    throw new Error("the policy parent must carry a plan leaf");
  }
  return {
    policy,
    evaluate,
    plan,
    executeLidarrPolicyEvaluate,
    executeLidarrPolicyPlan,
    loadActions,
    processSignal,
    resolveSignal,
    renderExecutionSummary,
    reportLidarrFailure,
  };
}

/** Attaches the subtree under `rfmedia lidarr` so help renders the full path. */
function nestUnderRoot(policy: Command): Command {
  const program = new Command("rfmedia");
  const lidarr = new Command("lidarr");
  program.addCommand(lidarr);
  lidarr.addCommand(policy);
  return policy;
}

const authDir = mkdtempSync(join(tmpdir(), "rfmedia-policy-auth-"));

describe("lidarr policy command", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Without this the Plex credential resolver would read the developer's real
    // credential store on any run that omits --plex-token.
    process.env["RFMEDIA_PLEX_AUTH_DIR"] = authDir;
    process.exitCode = undefined;
    mockFormatOutput.mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
  });

  afterAll(() => {
    delete process.env["RFMEDIA_PLEX_AUTH_DIR"];
    rmSync(authDir, { recursive: true, force: true });
  });

  it("declares exactly the completion-bound option surface without loading actions", () => {
    const { policy, evaluate, plan, loadActions } = createHarness();
    nestUnderRoot(policy);

    expect(evaluate.options.map((option) => option.long)).toEqual([
      ...LIDARR_POLICY_EVALUATE_OPTION_LONGS,
    ]);

    const help = evaluate.helpInformation();
    expect(help).toContain("Usage: rfmedia lidarr policy evaluate [options]");
    expect(help).toContain("Evaluate consumption policy rules and report proposals");
    // Root flags are reconciled by cli.ts's preAction hook; redeclaring shadows them.
    expect(help).not.toContain("--output");
    expect(help).not.toContain("--json");
    expect(plan.options.map((option) => option.long)).toEqual([...LIDARR_POLICY_PLAN_OPTION_LONGS]);
    const planHelp = plan.helpInformation();
    expect(planHelp).toContain("Usage: rfmedia lidarr policy plan [options]");
    expect(planHelp).not.toContain("--output");
    expect(planHelp).not.toContain("--json");
    expect(planHelp).not.toContain("--yes");
    expect(policy.description()).toBe(
      "Evaluate Plex consumption signals and review or seal Lidarr plans (never applies)",
    );
    expect(policy.commands.map((command) => command.name())).toEqual(["evaluate", "plan"]);
    expect(loadActions).not.toHaveBeenCalled();
  });

  it("accumulates --rule occurrences without ever throwing from the argParser", () => {
    expect(parsePolicyRuleIds("discovery-seed")).toEqual(["discovery-seed"]);
    expect(parsePolicyRuleIds("b, c", ["a"])).toEqual(["a", "b", "c"]);
    expect(parsePolicyRuleIds(" , ")).toEqual([]);
    // An unknown id must survive parsing: throwing here would exit the process
    // through Command.error() before .action() can build the failure envelope.
    expect(() => parsePolicyRuleIds("not-a-rule")).not.toThrow();
  });

  it.each([
    ["an unknown --rule id", ["evaluate", "--rule", "not-a-rule"]],
    ["a --rule value carrying no id", ["evaluate", "--rule", " , "]],
    ["a non-integer --max-proposals", ["evaluate", "--max-proposals", "2.5"]],
    ["an out-of-range --max-proposals", ["evaluate", "--max-proposals", "0"]],
    ["an unsupported --fail-on level", ["evaluate", "--fail-on", "degraded"]],
  ])("rejects %s before loading the action", async (_label, args) => {
    const { policy, loadActions, reportLidarrFailure } = createHarness("json");

    await policy.parseAsync(args, { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("forwards the validated selection and the single global cap verbatim", async () => {
    const { policy, executeLidarrPolicyEvaluate } = createHarness();

    await policy.parseAsync(
      [
        "evaluate",
        "--plex-library",
        "Music",
        "--rule",
        "stale-monitoring-cleanup",
        "--rule",
        "discovery-seed",
        "--max-proposals",
        "7",
        "--plex-url",
        "https://plex.example.test",
        "--plex-token",
        "plex-secret",
        "--lidarr-url",
        "https://lidarr.example.test",
        "--lidarr-api-key",
        "lidarr-secret",
      ],
      { from: "user" },
    );

    expect(executeLidarrPolicyEvaluate).toHaveBeenCalledWith({
      plexLibrary: "Music",
      rules: ["stale-monitoring-cleanup", "discovery-seed"],
      maxProposals: 7,
      plexUrl: "https://plex.example.test",
      plexToken: "plex-secret",
      lidarrUrl: "https://lidarr.example.test",
      lidarrApiKey: "lidarr-secret",
    });
  });

  it.each(["json", "yaml"] as const)(
    "emits one complete prose-free policy-v3 %s envelope on stdout and nothing on stderr",
    async (format) => {
      const report = createWithheldReport([STALE_OVERRIDE]);
      const { policy, renderExecutionSummary } = createHarness(format, createResult(report));

      await policy.parseAsync(["evaluate", "--explain", STALE_OVERRIDE.key], { from: "user" });

      expect(mockFormatOutput).toHaveBeenCalledOnce();
      const call = mockFormatOutput.mock.calls[0];
      expect(call?.[0]).toBe(format);
      expect(call?.[1]).toEqual({ command: "lidarr-policy-evaluate", result: report });
      expect(report).toMatchObject({
        schema: "rfmedia.lidarr-consumption-policy.v3",
        engineVersion: 3,
        summary: { proposed: 0, staleOverrides: 1 },
        proposals: [],
        overrides: [
          {
            key: STALE_OVERRIDE.key,
            status: "stale",
            expectedEvidenceFingerprint: EXPECTED_FINGERPRINT,
            currentEvidenceFingerprint: CURRENT_FINGERPRINT,
            decision: { evidenceFingerprint: CURRENT_FINGERPRINT },
          },
        ],
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(renderExecutionSummary).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("renders every human byte on stderr and writes no machine output", async () => {
    const { policy, renderExecutionSummary } = createHarness();

    await policy.parseAsync(["evaluate"], { from: "user" });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Consumption policy evaluation — Music @ https://plex.example.test");
    expect(stderr).toContain("stale-monitoring-cleanup:artist:233");
    expect(stderr).toContain("minDaysSinceLastViewed 90");
    expect(stderr).toContain("Evaluation is read-only.");
    expect(renderExecutionSummary).toHaveBeenCalledWith(EXECUTION);
    expect(mockFormatOutput).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("always renders explicit override states and review guidance on stderr", async () => {
    const report = createWithheldReport([
      SUPPRESSED_OVERRIDE,
      STALE_OVERRIDE,
      ABSENT_OVERRIDE,
      NOT_EVALUATED_OVERRIDE,
    ]);
    const { policy } = createHarness("text", createResult(report));

    await policy.parseAsync(["evaluate"], { from: "user" });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Overrides (4)");
    expect(stderr).toContain("ACTIVE SUPPRESSION");
    expect(stderr).toContain("STALE — REVIEW REQUIRED");
    expect(stderr).toContain("NOT EVALUATED");
    expect(stderr).not.toContain("UNMATCHED");
    expect(stderr).toContain(STALE_OVERRIDE.reason);
    expect(stderr).toContain("withheld pending review");
    expect(stderr).toContain("state-specific recovery guidance");
    expect(mockFormatOutput).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("renders an Overrides section even when no override is configured", async () => {
    const { policy } = createHarness();

    await policy.parseAsync(["evaluate"], { from: "user" });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Overrides (0)");
    expect(stderr).toContain("None configured.");
  });

  it("applies the --fail-on gate only after the evidence has been rendered", async () => {
    const { policy } = createHarness();
    const exitCodesDuringRender: (typeof process.exitCode)[] = [];
    consoleErrorSpy.mockImplementation(() => {
      exitCodesDuringRender.push(process.exitCode);
    });

    await policy.parseAsync(["evaluate", "--fail-on", "proposals"], { from: "user" });

    expect(exitCodesDuringRender.length).toBeGreaterThan(0);
    expect(exitCodesDuringRender.every((code) => code === undefined)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("sets the stale-only fail gate after rendering the review evidence", async () => {
    const report = createWithheldReport([STALE_OVERRIDE]);
    const { policy } = createHarness("text", createResult(report));
    const exitCodesDuringRender: (typeof process.exitCode)[] = [];
    consoleErrorSpy.mockImplementation(() => {
      exitCodesDuringRender.push(process.exitCode);
    });

    await policy.parseAsync(["evaluate", "--fail-on", "proposals"], { from: "user" });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("STALE — REVIEW REQUIRED");
    expect(stderr).toContain(STALE_OVERRIDE.key);
    expect(exitCodesDuringRender.every((code) => code === undefined)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code untouched at --fail-on none and on a clean report", async () => {
    const { policy } = createHarness();
    await policy.parseAsync(["evaluate"], { from: "user" });
    expect(process.exitCode).toBeUndefined();

    const clean = createReport({
      status: "clean",
      summary: {
        proposed: 0,
        skipped: 0,
        suppressed: 0,
        staleOverrides: 0,
        notEvaluatedOverrides: 0,
        rulesRun: 1,
        rulesSkipped: 2,
      },
      proposals: [],
      skips: [],
    });
    const cleanRun = createHarness("text", createResult(clean));
    await cleanRun.policy.parseAsync(["evaluate", "--fail-on", "proposals"], { from: "user" });
    expect(process.exitCode).toBeUndefined();
  });

  it("explains one decision and rejects a key no decision owns", async () => {
    const known = createHarness();
    await known.policy.parseAsync(["evaluate", "--explain", PROPOSAL.key], { from: "user" });
    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Decision");
    expect(stderr).toContain(PROPOSAL.key);
    expect(stderr).toContain(LAST_VIEWED_AT_ISO);
    expect(stderr).toContain("older-than-days");
    expect(stderr).toContain("policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed");
    expect(stderr).not.toContain("Consumption policy evaluation —");
    expect(known.reportLidarrFailure).not.toHaveBeenCalled();

    const unknown = createHarness("json");
    await unknown.policy.parseAsync(["evaluate", "--explain", "no-such:artist:1"], {
      from: "user",
    });
    expect(unknown.reportLidarrFailure).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["missing", NO_RECENCY_REFUSAL, "no-recency-coverage"],
    ["partial", PARTIAL_RECENCY_REFUSAL, "partial-recency-coverage"],
  ] as const)(
    "explains a %s recency refusal through the generic skip path",
    async (_label, skip, detail) => {
      const report = createReport({
        status: "clean",
        proposals: [],
        skips: [skip],
        summary: {
          proposed: 0,
          skipped: 1,
          suppressed: 0,
          staleOverrides: 0,
          notEvaluatedOverrides: 0,
          rulesRun: 1,
          rulesSkipped: 2,
        },
      });
      const { policy, reportLidarrFailure } = createHarness("text", createResult(report));

      await policy.parseAsync(["evaluate", "--explain", skip.key], { from: "user" });

      const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
      expect(stderr).toContain("Refusal");
      expect(stderr).toContain("signal-unavailable");
      expect(stderr).toContain(detail);
      expect(stderr).toContain("no trustworthy Plex last-viewed timestamp is available");
      expect(reportLidarrFailure).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["suppressed", SUPPRESSED_OVERRIDE],
    ["stale", STALE_OVERRIDE],
  ] as const)(
    "explains a withheld %s override with full copy-grade evidence",
    async (_state, override) => {
      const report = createWithheldReport([override]);
      const { policy, reportLidarrFailure } = createHarness("text", createResult(report));

      await policy.parseAsync(["evaluate", "--explain", override.key], { from: "user" });

      const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
      expect(stderr).toContain(override.key);
      expect(stderr).toContain("Override");
      expect(stderr).toContain(override.expectedEvidenceFingerprint);
      expect(stderr).toContain(override.currentEvidenceFingerprint);
      expect(stderr).toContain(override.reason);
      expect(stderr).toContain(`policy.overrides[${JSON.stringify(override.key)}]`);
      expect(stderr).toContain("Evidence");
      if (override.staleReason === "evidence-changed") {
        expect(stderr).toContain("evidenceFingerprint with Current");
      }
      expect(reportLidarrFailure).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "outcome-changed",
      OUTCOME_CHANGED_OVERRIDE,
      [
        "Review the current refusal",
        "Wait for the proposal to return",
        "suppression is no longer needed",
      ],
    ],
    [
      "decision-absent",
      ABSENT_OVERRIDE,
      ["state converged", "identity changed", "Remove the override only if the record is obsolete"],
    ],
  ] as const)(
    "gives safe %s override recovery without suggesting a hash replacement",
    async (_reason, override, guidance) => {
      const report = createWithheldReport([override]);
      const { policy, reportLidarrFailure } = createHarness("text", createResult(report));

      await policy.parseAsync(["evaluate", "--explain", override.key], { from: "user" });

      const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
      expect(stderr).toContain("STALE — REVIEW REQUIRED");
      for (const phrase of guidance) {
        expect(stderr).toContain(phrase);
      }
      expect(stderr).not.toContain("replace evidenceFingerprint");
      expect(reportLidarrFailure).not.toHaveBeenCalled();
    },
  );

  it("redacts both provider credentials in the root --output yaml failure envelope", async () => {
    const { policy, executeLidarrPolicyEvaluate, reportLidarrFailure } = createHarness("yaml");
    executeLidarrPolicyEvaluate.mockRejectedValue(
      new Error("authentication failed for plex-secret and lidarr-secret"),
    );

    await policy.parseAsync(
      ["evaluate", "--plex-token", "plex-secret", "--lidarr-api-key", "lidarr-secret"],
      { from: "user" },
    );

    expect(reportLidarrFailure).toHaveBeenCalledWith(
      "policy-evaluate",
      expect.any(Error),
      expect.objectContaining({
        staleHint: false,
        format: "yaml",
        sensitiveValues: ["lidarr-secret", "plex-secret"],
      }),
    );
    const serialized = JSON.stringify(mockFormatOutput.mock.calls);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("plex-secret");
    expect(serialized).not.toContain("lidarr-secret");
    expect(process.exitCode).toBe(1);
  });

  it("emits fixed proposal and override CSV evidence through the shared formula-safe formatter", async () => {
    const formulaReason = '=HYPERLINK("https://example.test")';
    const override = Object.freeze({
      ...SUPPRESSED_OVERRIDE,
      reason: formulaReason,
    });
    const report = createReport({
      overrides: [override],
      summary: {
        proposed: 1,
        skipped: 1,
        suppressed: 1,
        staleOverrides: 0,
        notEvaluatedOverrides: 0,
        rulesRun: 1,
        rulesSkipped: 2,
      },
    });
    const { policy } = createHarness("csv", createResult(report));

    await policy.parseAsync(["evaluate"], { from: "user" });

    const [format, rows, options] = mockFormatOutput.mock.calls[0] ?? [];
    const csvRows = rows as readonly Record<string, unknown>[];
    expect(format).toBe("csv");
    expect(csvRows.map((row) => row["rowType"])).toEqual([
      "summary",
      "rule",
      "rule",
      "rule",
      "proposal",
      "skip",
      "override",
    ]);
    expect(csvRows[0]).toMatchObject({
      "summary.proposed": 1,
      "summary.suppressed": 1,
      "summary.staleOverrides": 0,
      "summary.notEvaluatedOverrides": 0,
    });
    expect(csvRows.find((row) => row["rowType"] === "proposal")).toMatchObject({
      "decision.key": PROPOSAL.key,
      "decision.evidenceFingerprint": CURRENT_FINGERPRINT,
      "decision.checksJson": JSON.stringify(PROPOSAL.checks),
      "decision.observationsJson": JSON.stringify(PROPOSAL.observations),
    });
    expect(csvRows.find((row) => row["rowType"] === "override")).toMatchObject({
      "override.key": override.key,
      "override.status": "suppressed",
      "override.reason": formulaReason,
      "override.expectedEvidenceFingerprint": CURRENT_FINGERPRINT,
      "override.currentEvidenceFingerprint": CURRENT_FINGERPRINT,
      "decision.evidenceFingerprint": CURRENT_FINGERPRINT,
    });
    expect(options).toEqual({ columns: [...LIDARR_POLICY_EVALUATE_CSV_COLUMNS] });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown plan --rule", ["plan", "--rule", "not-a-rule"]],
    ["an empty plan --rule", ["plan", "--rule", " , "]],
    ["an invalid plan cap", ["plan", "--max-proposals", "101"]],
    ["an unsupported plan mode", ["plan", "--mode", "apply"]],
  ])("rejects %s before lazy-loading actions", async (_label, args) => {
    const { policy, loadActions, reportLidarrFailure } = createHarness("json");

    await policy.parseAsync(args, { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("forwards the exact plan selection, safety mode, connection overrides, and process signal", async () => {
    const { policy, executeLidarrPolicyPlan, processSignal, resolveSignal } = createHarness();

    await policy.parseAsync(
      [
        "plan",
        "--plex-library",
        "Music",
        "--rule",
        "rating-quality-upgrade,stale-monitoring-cleanup",
        "--max-proposals",
        "9",
        "--mode",
        "plan",
        "--plex-url",
        "https://plex.example.test",
        "--plex-token",
        "plex-secret",
        "--lidarr-url",
        "https://lidarr.example.test",
        "--lidarr-api-key",
        "lidarr-secret",
      ],
      { from: "user" },
    );

    expect(executeLidarrPolicyPlan).toHaveBeenCalledWith({
      mode: "plan",
      rules: ["rating-quality-upgrade", "stale-monitoring-cleanup"],
      maxProposals: 9,
      plexLibrary: "Music",
      onPlanSealed: expect.any(Function),
      plexUrl: "https://plex.example.test",
      plexToken: "plex-secret",
      lidarrUrl: "https://lidarr.example.test",
      lidarrApiKey: "lidarr-secret",
      signal: processSignal,
    });
    expect(resolveSignal).toHaveBeenCalledOnce();
  });

  it("rejects an unknown plan explanation through the post-evaluation action preflight", async () => {
    const { policy, executeLidarrPolicyPlan, reportLidarrFailure } = createHarness("json");

    await policy.parseAsync(["plan", "--mode", "plan", "--explain", "no-such:artist:1"], {
      from: "user",
    });

    expect(executeLidarrPolicyPlan).toHaveBeenCalledOnce();
    expect(executeLidarrPolicyPlan).toHaveBeenCalledWith(
      expect.objectContaining({ validateEvaluation: expect.any(Function) }),
    );
    expect(reportLidarrFailure).toHaveBeenCalledWith(
      "policy-plan",
      expect.objectContaining({ name: "LookupNotFoundError" }),
      expect.objectContaining({ format: "json" }),
    );
    expect(process.exitCode).toBe(1);
  });

  it.each(["json", "yaml"] as const)(
    "emits one prose-free policy-plan %s envelope when explain is requested",
    async (format) => {
      const report = createPlanReport("reviewed");
      const { policy, executeLidarrPolicyPlan, renderExecutionSummary } = createHarness(
        format,
        createResult(),
        createPlanResult(report),
      );

      await policy.parseAsync(["plan", "--explain", PROPOSAL.key], { from: "user" });

      expect(executeLidarrPolicyPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "recommend",
          validateEvaluation: expect.any(Function),
          onPlanSealed: undefined,
        }),
      );
      expect(mockFormatOutput).toHaveBeenCalledOnce();
      expect(mockFormatOutput).toHaveBeenCalledWith(format, {
        command: "lidarr-policy-plan",
        result: report,
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(renderExecutionSummary).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("renders embedded override state in the human policy-plan review", async () => {
    const reviewed = createPlanReport("reviewed");
    const report: LidarrPolicyPlanReport = {
      ...reviewed,
      evaluation: createWithheldReport([SUPPRESSED_OVERRIDE]),
    };
    const { policy } = createHarness("text", createResult(), createPlanResult(report));

    await policy.parseAsync(["plan"], { from: "user" });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Lidarr policy plan — REVIEW ONLY");
    expect(stderr).toContain("Overrides (1)");
    expect(stderr).toContain("ACTIVE SUPPRESSION");
    expect(stderr).toContain(SUPPRESSED_OVERRIDE.key);
    expect(mockFormatOutput).not.toHaveBeenCalled();
  });

  it("emits fixed policy-plan CSV rows on stdout only", async () => {
    const sealed = createPlanReport("sealed");
    const report: LidarrPolicyPlanReport = {
      ...sealed,
      evaluation: createReport({
        overrides: [SUPPRESSED_OVERRIDE],
        summary: {
          proposed: 1,
          skipped: 1,
          suppressed: 1,
          staleOverrides: 0,
          notEvaluatedOverrides: 0,
          rulesRun: 1,
          rulesSkipped: 2,
        },
      }),
    };
    const { policy } = createHarness("csv", createResult(), createPlanResult(report));

    await policy.parseAsync(["plan", "--mode", "plan"], { from: "user" });

    expect(mockFormatOutput).toHaveBeenCalledOnce();
    const [format, rows, options] = mockFormatOutput.mock.calls[0] ?? [];
    expect(format).toBe("csv");
    const csvRows = rows as readonly Record<string, unknown>[];
    expect(csvRows.map((row) => row["rowType"])).toEqual([
      "summary",
      "rule",
      "rule",
      "rule",
      "cohort",
      "proposal",
      "skip",
      "override",
      "artifact",
    ]);
    expect(csvRows.find((row) => row["rowType"] === "skip")).toEqual({
      rowType: "skip",
      "decision.key": SKIP.key,
      "decision.ruleId": SKIP.ruleId,
      "decision.code": SKIP.code,
      "decision.subject.name": SKIP.subject.name,
      "decision.subject.plexId": SKIP.subject.plexId,
      "decision.subject.artistId": SKIP.subject.artistId,
      "decision.subject.artistMbid": SKIP.subject.artistMbid,
      "decision.identity.category": SKIP.identity.category,
      "decision.identity.reason": SKIP.identity.reason,
      "decision.detail": SKIP.detail,
      "decision.checksJson": JSON.stringify(SKIP.checks),
    });
    expect(options).toEqual({ columns: expect.arrayContaining(["artifact.planChecksum"]) });
    expect(csvRows.find((row) => row["rowType"] === "override")).toMatchObject({
      "override.key": SUPPRESSED_OVERRIDE.key,
      "override.status": "suppressed",
      "decision.evidenceFingerprint": CURRENT_FINGERPRINT,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("renders complete partial evidence beside a requested causal explanation", async () => {
    const { policy, renderExecutionSummary } = createHarness(
      "text",
      createResult(),
      createPlanResult(createPlanReport("partial")),
    );
    const exitCodesDuringRender: (typeof process.exitCode)[] = [];
    consoleErrorSpy.mockImplementation(() => {
      exitCodesDuringRender.push(process.exitCode);
    });

    await policy.parseAsync(["plan", "--mode", "plan", "--explain", PROPOSAL.key], {
      from: "user",
    });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Lidarr policy plan — PARTIAL");
    expect(stderr).toContain(PROPOSAL.key);
    expect(stderr).toContain("/plans/policy monitoring.json");
    expect(stderr).toContain(BUILT_PLAN.id);
    expect(stderr).toContain(BUILT_PLAN.payloadChecksum);
    expect(stderr).toContain("--expected-plan-id");
    expect(stderr).toContain("--expected-plan-checksum");
    expect(stderr).not.toContain("--yes");
    expect(stderr).toContain("artist-profile-assignment plan producer failed");
    expect(stderr).toContain("Decision");
    expect(exitCodesDuringRender.every((code) => code === undefined)).toBe(true);
    expect(renderExecutionSummary).toHaveBeenCalledWith(EXECUTION);
    expect(mockFormatOutput).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("renders complete failed evidence beside a requested causal explanation", async () => {
    const { policy, renderExecutionSummary } = createHarness(
      "text",
      createResult(),
      createPlanResult(createPlanReport("failed")),
    );

    await policy.parseAsync(["plan", "--mode", "plan", "--explain", PROPOSAL.key], {
      from: "user",
    });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Lidarr policy plan — FAILED");
    expect(stderr).toContain("artist-monitoring plan producer failed");
    expect(stderr).toContain("Decision");
    expect(stderr).toContain(PROPOSAL.key);
    expect(renderExecutionSummary).toHaveBeenCalledWith(EXECUTION);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["reviewed", undefined],
    ["reviewed-refusal", undefined],
    ["no-changes", undefined],
    ["sealed", undefined],
    ["refused", 1],
    ["partial", 1],
    ["failed", 1],
  ] as const)("applies the exact exit matrix for %s", async (state, expectedExitCode) => {
    const { policy } = createHarness(
      "text",
      createResult(),
      createPlanResult(createPlanReport(state)),
    );

    await policy.parseAsync(
      state === "reviewed" || state === "reviewed-refusal" ? ["plan"] : ["plan", "--mode", "plan"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(expectedExitCode);
  });

  it("uses the generic redacted failure envelope for a projection invariant", async () => {
    const { policy, executeLidarrPolicyPlan, reportLidarrFailure } = createHarness("json");
    executeLidarrPolicyPlan.mockRejectedValue(
      new Error("projection invariant exposed plex-secret and lidarr-secret"),
    );

    await policy.parseAsync(
      ["plan", "--plex-token", "plex-secret", "--lidarr-api-key", "lidarr-secret"],
      { from: "user" },
    );

    expect(reportLidarrFailure).toHaveBeenCalledWith(
      "policy-plan",
      expect.any(Error),
      expect.objectContaining({
        staleHint: false,
        format: "json",
        sensitiveValues: ["lidarr-secret", "plex-secret"],
      }),
    );
    const serialized = JSON.stringify(mockFormatOutput.mock.calls);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("plex-secret");
    expect(serialized).not.toContain("lidarr-secret");
    expect(process.exitCode).toBe(1);
  });

  it("redacts credentials from a typed producer-failure result before rendering", async () => {
    const partial = createPlanReport("partial");
    if (partial.status !== "partial") {
      throw new Error("expected a partial policy-plan fixture");
    }
    const report: LidarrPolicyPlanReport = {
      ...partial,
      failure: {
        ...partial.failure,
        detail: "producer failed for plex-secret and lidarr-secret",
      },
    };
    const { policy, reportLidarrFailure } = createHarness(
      "json",
      createResult(),
      createPlanResult(report),
    );

    await policy.parseAsync(
      [
        "plan",
        "--mode",
        "plan",
        "--plex-token",
        "plex-secret",
        "--lidarr-api-key",
        "lidarr-secret",
      ],
      { from: "user" },
    );

    expect(reportLidarrFailure).not.toHaveBeenCalled();
    const serialized = JSON.stringify(mockFormatOutput.mock.calls);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("plex-secret");
    expect(serialized).not.toContain("lidarr-secret");
    expect(process.exitCode).toBe(1);
  });
});
