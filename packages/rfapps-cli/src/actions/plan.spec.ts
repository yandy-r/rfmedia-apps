import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executePlan } from "./plan.js";
import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import { generatePlan } from "../lib/plan-generator.js";
import { savePlan } from "../lib/plan-storage.js";
import { loadPlanBaseline } from "../lib/plan-baseline.js";
import { executeApply } from "./apply.js";
import type { DeploymentPlan } from "../types/plan.js";
import {
  PLAN_INTELLIGENCE_SCHEMA_VERSION,
  type PlanIntelligence,
} from "../types/plan-intelligence.js";

vi.mock("../lib/index.js");
vi.mock("../lib/plan-baseline.js");
vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return {
    ...actual,
    formatOutput: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../lib/plan-generator.js");
vi.mock("../lib/plan-storage.js");
vi.mock("./apply.js", () => ({
  executeApply: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Plan Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env",
    profiles: {
      defaultProfile: "core",
      validProfiles: ["core", "all"],
      mapping: {},
    },
    sidecars: {
      enabled: true,
      mapping: {},
    },
    groups: {},
    healthCheck: {
      timeout: 60,
      interval: 1,
      retries: 2,
      waitForReady: true,
    },
    envTool: {
      tool: "none",
    },
    docker: {},
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: {
      enabled: false,
      workers: 4,
    },
  };

  const plan: DeploymentPlan = {
    id: "plan-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    composeHash: "",
    composePath: "compose.yml",
    targetServices: ["plex"],
    profiles: ["media"],
    services: [
      {
        service: "plex",
        changeType: "recreate",
        image: {
          current: "plex:v1",
          desired: "plex:v2",
          changed: true,
          updateAvailable: true,
        },
        environment: [
          {
            name: "PLEX_TOKEN",
            current: "old",
            desired: "new",
            changeType: "modified",
            isSecret: true,
          },
        ],
        ports: {
          current: [{ host: "32400", container: "32400", protocol: "tcp" }],
          desired: [{ host: "32400", container: "32400", protocol: "tcp" }],
          changed: false,
        },
        volumes: {
          current: [{ source: "/old", target: "/config" }],
          desired: [{ source: "/new", target: "/config" }],
          changed: true,
        },
        networks: {
          current: ["apps"],
          desired: ["apps"],
          changed: false,
        },
      },
      {
        service: "sonarr",
        changeType: "unchanged",
        image: { current: "sonarr:latest", desired: "sonarr:latest", changed: false },
        environment: [],
        ports: { current: [], desired: [], changed: false },
        volumes: { current: [], desired: [], changed: false },
        networks: { current: ["apps"], desired: ["apps"], changed: false },
      },
    ],
    summary: {
      toCreate: 0,
      toUpdate: 0,
      toRecreate: 1,
      toDelete: 0,
      unchanged: 1,
      updatesAvailable: 1,
      total: 2,
    },
  };

  let originalExitCode: typeof process.exitCode;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(generatePlan).mockResolvedValue(plan);
    vi.mocked(savePlan).mockResolvedValue("/tmp/plan.json");
    vi.mocked(common.formatDryRun).mockImplementation((message) => `[dry-run] ${message}`);
    vi.mocked(common.formatError).mockReturnValue({
      message: "formatted error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("formatted error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
    const passthroughColor = (value: string | number | null | undefined) => String(value);
    vi.mocked(common.colors.bold).mockImplementation(passthroughColor);
    vi.mocked(common.colors.dim).mockImplementation(passthroughColor);
    vi.mocked(common.colors.yellow).mockImplementation(passthroughColor);
    vi.mocked(common.colors.green).mockImplementation(passthroughColor);
    vi.mocked(common.colors.cyan).mockImplementation(passthroughColor);
    vi.mocked(common.colors.red).mockImplementation(passthroughColor);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("generates, saves, and displays a text plan", async () => {
    await executePlan({ service: "plex", showUnchanged: true }, { yes: true, verbose: true });

    expect(generatePlan).toHaveBeenCalledWith(
      {
        composePath: "compose.yml",
        services: ["plex"],
        profiles: ["media"],
        checkUpdates: false,
      },
      undefined,
    );
    expect(savePlan).toHaveBeenCalledWith(plan, undefined);
    expect(consoleErrorSpy).toHaveBeenCalledWith("Deployment Plan");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Plan saved to: /tmp/plan.json"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("outputs machine-readable plan data", async () => {
    await executePlan(
      { service: "plex", out: "saved.json", checkUpdates: true },
      { yes: true, output: "json" },
    );

    expect(savePlan).toHaveBeenCalledWith(plan, "saved.json");
    expect(formatOutput).toHaveBeenCalledWith("json", {
      planPath: "/tmp/plan.json",
      plan,
    });
  });

  it("supports dry-run and cancelled service resolution", async () => {
    await executePlan({ service: "plex" }, { dryRun: true, yes: true });
    expect(generatePlan).not.toHaveBeenCalled();

    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);
    await executePlan({ service: "plex" }, { yes: true });
    expect(generatePlan).not.toHaveBeenCalled();
  });

  it("formats plan generation failures", async () => {
    vi.mocked(generatePlan).mockResolvedValue(undefined);

    await executePlan({ service: "plex" }, { yes: true });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("loads a baseline and renders annotations under --explain", async () => {
    const intelligence: PlanIntelligence = {
      schemaVersion: PLAN_INTELLIGENCE_SCHEMA_VERSION,
      provenance: { baseline: "none", reason: "no-comparable-plan" },
      registryChecked: false,
      runtimeStateObserved: true,
      services: {
        plex: {
          reasons: [
            {
              code: "image-reference-changed",
              kind: "trigger",
              confidence: "confirmed",
              decisive: true,
              summary: "image reference changed",
              evidence: [],
            },
          ],
          impact: {
            effect: "replace",
            critical: false,
            dependentCount: 0,
            dependents: [],
            dependentsTruncated: false,
            runningDependentCount: 0,
            changingDependencies: [],
          },
        },
      },
      summary: { annotatedServices: 1, downstreamImpacted: 0, criticalServices: 0 },
    };
    vi.mocked(loadPlanBaseline).mockResolvedValue({
      status: "unavailable",
      reason: "no-comparable-plan",
    });
    vi.mocked(generatePlan).mockResolvedValue({ ...plan, intelligence });

    await executePlan({ service: "plex", explain: true }, { yes: true });

    expect(loadPlanBaseline).toHaveBeenCalledWith("compose.yml", ["media"]);
    expect(generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        intelligence: {
          profileMapping: {},
          baseline: { status: "unavailable", reason: "no-comparable-plan" },
        },
      }),
      undefined,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/^\s+why:/));
  });

  it("hands saved plans to apply when requested", async () => {
    await executePlan({ service: "plex", apply: true }, { yes: true, output: "json" });

    expect(executeApply).toHaveBeenCalledWith(
      { planFile: "/tmp/plan.json", force: false },
      {
        yes: true,
        output: "json",
      },
    );
  });
});
