/**
 * Command-boundary suite for `rfmedia lidarr sync-ratings` (design §8.3).
 *
 * The command layer owns the option surface, the mutation gate, and the exit
 * code, so a regression here is invisible to every pure test in the feature.
 * Four things are pinned: the declared option surface, the recorded `argParser`
 * regression (a throwing parser exits the process before `.action()` can build
 * the failure envelope), the machine-format apply gate, and `--explain`
 * failing loudly in a machine format.
 *
 * The option surface is asserted against
 * {@link LIDARR_SYNC_RATINGS_OPTION_LONGS} — the same const
 * `src/lib/shell-completions/templates.spec.ts` asserts its completion tuple
 * against. This file is the only thing in the repo that reconciles the leaf's
 * Commander options with the generated completion templates.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutputFormat } from "@rfmedia/common";

import { POLICY_ENGINE_VERSION, POLICY_EVALUATION_SCHEMA } from "../types/lidarr-policy.js";
import {
  LIDARR_SYNC_RATINGS_OPTION_LONGS,
  SYNC_RATINGS_SCHEMA,
} from "../types/lidarr-sync-ratings.js";
import type { LidarrSyncRatingsActionResult } from "../actions/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyEvaluatedProposal,
  PolicyEvaluationReport,
  PolicyOverrideResult,
} from "../types/lidarr-policy.js";
import type { LidarrSyncRatingsReport } from "../types/lidarr-sync-ratings.js";

const mockFormatOutput = vi.hoisted(() => vi.fn());
const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedPolicyConfig: vi.fn<() => unknown>(() => undefined),
}));

vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mockFormatOutput,
}));

vi.mock("../lib/loaded-config.js", () => ({
  getLoadedPolicyConfig: mockLoadedConfig.getLoadedPolicyConfig,
}));

import { createLidarrSyncRatingsCommand } from "./lidarr-sync-ratings.js";

const EXECUTION: LidarrExecutionSuccessMetadata = {
  taskId: "lidarr-policy-evaluate",
  operation: "lidarr policy evaluate",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
};

const CURRENT_FINGERPRINT = `sha256:${"a".repeat(64)}` as PolicyDecisionEvidenceFingerprint;
const EXPECTED_FINGERPRINT = `sha256:${"b".repeat(64)}` as PolicyDecisionEvidenceFingerprint;

const WITHHELD_PROPOSAL: PolicyEvaluatedProposal = Object.freeze({
  key: "stale-monitoring-cleanup:artist:233",
  ruleId: "stale-monitoring-cleanup",
  code: "monitored-artist-unconsumed",
  subject: Object.freeze({
    kind: "artist",
    name: "Reviewed Artist",
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
  ]),
  observations: Object.freeze({
    plays: Object.freeze({
      status: "observed",
      value: 0,
      join: "normalized-name",
      sampleSize: 31,
    }),
  }),
  summary: "0 plays and unrated in Plex while monitored in Lidarr.",
  handoff: Object.freeze({
    producer: "artist-monitoring",
    argv: Object.freeze(["lidarr", "plan", "artist-monitoring", "--ids", "233", "--unmonitored"]),
  }),
  evidenceFingerprint: CURRENT_FINGERPRINT,
});

const SUPPRESSED_OVERRIDE: PolicyOverrideResult = Object.freeze({
  key: WITHHELD_PROPOSAL.key,
  action: "suppress",
  status: "suppressed",
  staleReason: null,
  reason: "Compilation listening is intentionally excluded",
  expectedEvidenceFingerprint: CURRENT_FINGERPRINT,
  currentEvidenceFingerprint: CURRENT_FINGERPRINT,
  decision: WITHHELD_PROPOSAL,
});

const STALE_OVERRIDE: PolicyOverrideResult = Object.freeze({
  ...SUPPRESSED_OVERRIDE,
  status: "stale",
  staleReason: "evidence-changed",
  reason: "The reviewed evidence no longer matches the current artist state",
  expectedEvidenceFingerprint: EXPECTED_FINGERPRINT,
});

const NOT_EVALUATED_OVERRIDE: PolicyOverrideResult = Object.freeze({
  ...SUPPRESSED_OVERRIDE,
  key: "discovery-seed:plex:88",
  status: "not-evaluated",
  staleReason: null,
  reason: "Discovery seeds are intentionally managed outside this run",
  expectedEvidenceFingerprint: EXPECTED_FINGERPRINT,
  currentEvidenceFingerprint: null,
  decision: null,
});

const EVALUATION: PolicyEvaluationReport = {
  schema: POLICY_EVALUATION_SCHEMA,
  engineVersion: POLICY_ENGINE_VERSION,
  evaluatedAt: "2026-07-28T18:04:11.000Z",
  plexOrigin: "https://plex.example.test",
  lidarrOrigin: "https://lidarr.example.test",
  plexLibrary: "Music",
  status: "clean",
  policy: {
    plexLibrary: "Music",
    rules: {
      "rating-quality-upgrade": {
        kind: "rating-quality-upgrade",
        enabled: true,
        minRating: 4,
        targetQualityProfile: "Lossless",
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
        minRating: 4,
        minPlays: null,
        maxSeeds: 10,
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
    proposed: 0,
    skipped: 0,
    suppressed: 0,
    staleOverrides: 0,
    notEvaluatedOverrides: 0,
    rulesRun: 2,
    rulesSkipped: 1,
  },
  rules: [
    {
      id: "rating-quality-upgrade",
      title: "Rating-informed quality upgrade",
      status: "clean",
      proposedCount: 0,
      skippedCount: 0,
    },
    {
      id: "stale-monitoring-cleanup",
      title: "Stale monitoring cleanup",
      status: "clean",
      proposedCount: 0,
      skippedCount: 0,
    },
    {
      id: "discovery-seed",
      title: "Discovery seed generation",
      status: "skipped",
      skipReason: "not-selected",
      detail: "not selected for this run",
    },
  ],
  proposals: [],
  skips: [],
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
};

const REPORT: LidarrSyncRatingsReport = {
  schema: SYNC_RATINGS_SCHEMA,
  mode: "recommend",
  decisions: ["quality-profile", "monitoring"],
  thresholds: {
    minStars: {
      value: 4,
      source: "config",
      configPath: "policy.rules.rating-quality-upgrade.minRating",
    },
    maxPlays: {
      value: 0,
      source: "default",
      configPath: "policy.rules.stale-monitoring-cleanup.maxPlays",
    },
    qualityProfile: { value: "Lossless", source: "flag", configPath: null },
    maxProposals: { value: 25, source: "default", configPath: null },
  },
  cohorts: [],
  refusals: [],
  footprint: { authoritativeLinks: 586, changedArtists: 0, fraction: 0 },
  outcomes: [],
  evaluation: EVALUATION,
  decisionStates: { "quality-profile": "on", monitoring: "on" },
};

function reportWithOverrides(overrides: readonly PolicyOverrideResult[]): LidarrSyncRatingsReport {
  return {
    ...REPORT,
    evaluation: {
      ...EVALUATION,
      summary: {
        ...EVALUATION.summary,
        suppressed: overrides.filter((override) => override.status === "suppressed").length,
        staleOverrides: overrides.filter((override) => override.status === "stale").length,
        notEvaluatedOverrides: overrides.filter((override) => override.status === "not-evaluated")
          .length,
      },
      overrides,
    },
  };
}

function createHarness(format: OutputFormat = "text", report: LidarrSyncRatingsReport = REPORT) {
  const executeLidarrSyncRatings = vi.fn().mockResolvedValue({
    report,
    execution: EXECUTION,
  } satisfies LidarrSyncRatingsActionResult);
  const loadActions = vi.fn().mockResolvedValue({ executeLidarrSyncRatings });
  const renderExecutionSummary = vi.fn();
  const reportLidarrFailure = vi.fn(
    async (
      _subcommand: string,
      _error: unknown,
      _options: {
        readonly staleHint: boolean;
        readonly format: OutputFormat;
        readonly sensitiveValues?: readonly unknown[];
      },
    ) => {
      process.exitCode = 1;
    },
  );
  const command = createLidarrSyncRatingsCommand({
    resolveFormat: () => format,
    reportLidarrFailure,
    renderExecutionSummary,
    loadActions,
  });
  return {
    command,
    executeLidarrSyncRatings,
    loadActions,
    renderExecutionSummary,
    reportLidarrFailure,
  };
}

/** Attaches the leaf under `rfmedia lidarr` so help renders the full path. */
function nestUnderRoot(leaf: Command): void {
  const program = new Command("rfmedia");
  const lidarr = new Command("lidarr");
  program.addCommand(lidarr);
  lidarr.addCommand(leaf);
}

describe("lidarr sync-ratings command", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockFormatOutput.mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit must never be called by this leaf");
    }) as never);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("declares exactly the completion-bound option surface without loading actions", () => {
    const { command, loadActions } = createHarness();
    nestUnderRoot(command);

    expect(command.options.map((option) => option.long)).toEqual([
      ...LIDARR_SYNC_RATINGS_OPTION_LONGS,
    ]);

    const help = command.helpInformation();
    expect(help).toContain("Usage: rfmedia lidarr sync-ratings [options]");
    // Root flags are reconciled by cli.ts's preAction hook; redeclaring shadows them.
    expect(help).not.toContain("--output");
    expect(help).not.toContain("--json");
    // The rung selector is a single value-taking --mode; --apply is a plan-file
    // option elsewhere in this CLI and may not also be a boolean here.
    expect(help).not.toContain("--apply");
    expect(help).not.toContain("--plan ");
    expect(loadActions).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown --decision kind", ["--decision", "zzz"]],
    ["an out-of-range --min-stars", ["--min-stars", "9"]],
    ["a negative --max-plays", ["--max-plays", "-1"]],
    ["an unknown --mode rung", ["--mode", "zzz"]],
  ])("rejects %s before loading the action", async (_label, args) => {
    const { command, loadActions, reportLidarrFailure } = createHarness("json");

    await command.parseAsync(["--quality-profile", "Lossless", ...args], { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    expect(reportLidarrFailure.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses a blank --quality-profile instead of shadowing the configured target", async () => {
    // `??` in resolvePolicyConfig falls through only on undefined, so an empty
    // string would outrank policy.rules.rating-quality-upgrade.targetQualityProfile,
    // resolve to nothing, and silently degrade the run.
    mockLoadedConfig.getLoadedPolicyConfig.mockReturnValue({
      rules: { "rating-quality-upgrade": { targetQualityProfile: "Lossless" } },
    });
    const { command, loadActions, reportLidarrFailure } = createHarness("json");

    await command.parseAsync(["--quality-profile", "   "], { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    expect(reportLidarrFailure.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("lets an explicitly disabled rating rule run without --quality-profile", async () => {
    // `enabled: false` is refused as decision-disabled rather than evaluated,
    // so demanding a target it will never use would let one rule's kill switch
    // block its healthy monitoring sibling.
    mockLoadedConfig.getLoadedPolicyConfig.mockReturnValue({
      rules: { "rating-quality-upgrade": { enabled: false } },
    });
    const { command, executeLidarrSyncRatings, reportLidarrFailure } = createHarness("json");

    await command.parseAsync([], { from: "user" });

    expect(reportLidarrFailure).not.toHaveBeenCalled();
    expect(executeLidarrSyncRatings).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a machine-format apply that carries no --yes", async () => {
    const { command, loadActions, reportLidarrFailure } = createHarness("json");

    await command.parseAsync(["--quality-profile", "Lossless", "--mode", "apply"], {
      from: "user",
    });

    expect(loadActions).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    const error = reportLidarrFailure.mock.calls[0]?.[1];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("MissingRequiredArgumentError");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["active", SUPPRESSED_OVERRIDE, "ACTIVE SUPPRESSION"],
    ["stale", STALE_OVERRIDE, "STALE — REVIEW REQUIRED"],
    ["not evaluated", NOT_EVALUATED_OVERRIDE, "NOT EVALUATED"],
  ] as const)(
    "makes a withheld-only %s override explicit on stderr",
    async (_state, override, label) => {
      const report = reportWithOverrides([override]);
      const { command, renderExecutionSummary, reportLidarrFailure } = createHarness(
        "text",
        report,
      );

      await command.parseAsync(["--quality-profile", "Lossless"], { from: "user" });

      const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
      expect(stderr).toContain("Overrides (1)");
      expect(stderr).toContain(label);
      expect(stderr).toContain(override.key);
      expect(stderr).toContain(override.reason);
      expect(renderExecutionSummary).toHaveBeenCalledWith(EXECUTION);
      expect(reportLidarrFailure).not.toHaveBeenCalled();
      expect(mockFormatOutput).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("delegates withheld override explain with full copy-grade evidence", async () => {
    const report = reportWithOverrides([STALE_OVERRIDE]);
    const { command, renderExecutionSummary, reportLidarrFailure } = createHarness("text", report);

    await command.parseAsync(["--quality-profile", "Lossless", "--explain", STALE_OVERRIDE.key], {
      from: "user",
    });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Override");
    expect(stderr).toContain(STALE_OVERRIDE.key);
    expect(stderr).toContain(STALE_OVERRIDE.expectedEvidenceFingerprint);
    expect(stderr).toContain(STALE_OVERRIDE.currentEvidenceFingerprint);
    expect(stderr).toContain(STALE_OVERRIDE.reason);
    expect(renderExecutionSummary).not.toHaveBeenCalled();
    expect(reportLidarrFailure).not.toHaveBeenCalled();
    expect(mockFormatOutput).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("keeps the outer sync v1 envelope and embedded policy v3 report on machine stdout", async () => {
    const report = reportWithOverrides([STALE_OVERRIDE]);
    const { command, renderExecutionSummary, reportLidarrFailure } = createHarness("json", report);

    await command.parseAsync(["--quality-profile", "Lossless", "--explain", STALE_OVERRIDE.key], {
      from: "user",
    });

    expect(report.schema).toBe("rfmedia.lidarr-ratings-sync.v1");
    expect(report.evaluation.schema).toBe("rfmedia.lidarr-consumption-policy.v3");
    expect(report.evaluation.engineVersion).toBe(3);
    expect(report.evaluation.overrides).toEqual([STALE_OVERRIDE]);
    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(mockFormatOutput).toHaveBeenCalledWith("json", {
      command: "lidarr-sync-ratings",
      result: report,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(renderExecutionSummary).not.toHaveBeenCalled();
    expect(reportLidarrFailure).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects an --explain key no decision owns even under a machine format", async () => {
    const { command, executeLidarrSyncRatings, reportLidarrFailure } = createHarness("json");

    await command.parseAsync(["--quality-profile", "Lossless", "--explain", "no-such:artist:1"], {
      from: "user",
    });

    expect(executeLidarrSyncRatings).toHaveBeenCalledOnce();
    expect(mockFormatOutput).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    const error = reportLidarrFailure.mock.calls[0]?.[1];
    expect((error as Error).name).toBe("LookupNotFoundError");
    expect(process.exitCode).toBe(1);
  });
});
