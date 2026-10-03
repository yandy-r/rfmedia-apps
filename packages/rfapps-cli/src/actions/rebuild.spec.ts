import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executeRebuild } from "./rebuild.js";
import * as lib from "../lib/index.js";

vi.mock("../lib/index.js");
vi.mock("@rfmedia/common");

describe("Rebuild Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env",
    profiles: { defaultProfile: "core", validProfiles: ["core", "all"], mapping: {} },
    sidecars: { enabled: true, mapping: {} },
    groups: {},
    healthCheck: { timeout: 60, interval: 1, retries: 2, waitForReady: true },
    envTool: { tool: "none" },
    docker: {},
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: { enabled: false, workers: 4 },
  };

  const ok = { success: true, stdout: "", stderr: "", code: 0 };
  const readySummary = {
    ready: true,
    timedOut: false,
    totalDependencies: 1,
    readyDependencies: ["db"],
    pendingDependencies: [],
    failedDependencies: [],
    elapsedMs: 1000,
    attempts: 1,
    signalAvailability: { available: true, unavailableSignals: [] },
    services: [],
  };
  const graph = {
    phases: [["db"], ["plex"]],
    dependencyMap: new Map([["plex", ["db"]]]),
    hasCycles: false,
  };
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.pullImages).mockResolvedValue(ok);
    vi.mocked(lib.buildImages).mockResolvedValue(ok);
    vi.mocked(lib.startServices).mockResolvedValue(ok);
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: true,
      stdout: "rfapps-plex-1\n",
      stderr: "",
      code: 0,
    });
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue(readySummary as any);
    vi.mocked(lib.initializeDatabase).mockResolvedValue({} as any);
    vi.mocked(lib.inspectContainersWithRetry).mockResolvedValue(new Map([["plex", "plex:latest"]]));
    vi.mocked(lib.recordDeployments).mockReturnValue([1] as any);
    vi.mocked(lib.closeDatabase).mockReturnValue(undefined);
    vi.mocked(lib.computeExecutionPhases).mockResolvedValue(graph as any);
    vi.mocked(lib.executeParallelPhases).mockResolvedValue({
      succeeded: ["plex"],
      failed: [],
    } as any);
    vi.mocked(lib.formatExecutionPlan).mockReturnValue("execution plan");
    vi.mocked(lib.formatOutput).mockResolvedValue(undefined as any);
    vi.mocked(common.formatDryRun).mockImplementation((message) => `[dry-run] ${message}`);
    vi.mocked(common.isMachineFormat).mockReturnValue(false);
    vi.mocked(common.confirm).mockResolvedValue(true);
    vi.mocked(common.formatError).mockReturnValue({
      message: "formatted error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("formatted error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("runs the sequential rebuild phases, checks readiness, records state, and outputs results", async () => {
    await executeRebuild({ service: "plex" }, { yes: true, output: "json" });

    expect(lib.stopServices).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      envTool: undefined,
    });
    expect(lib.pullImages).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      envTool: undefined,
    });
    expect(lib.buildImages).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      envTool: undefined,
    });
    expect(lib.startServices).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      forceRecreate: true,
      envTool: undefined,
    });
    expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        composePath: "compose.yml",
        targetServices: ["plex"],
        profiles: ["media"],
        waitForReady: true,
      }),
    );
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({
        service: "plex",
        action: "rebuild",
        imageTag: "plex:latest",
        status: "success",
      }),
    ]);
    expect(lib.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        services: ["plex"],
        healthy: ["rfapps-plex-1"],
        rebuilt: 1,
        completedPhases: ["stop", "pull", "build", "start"],
      }),
    );
  });

  it("skips pull, handles all-services rebuild status fallback, and records healthy containers", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: [],
      profiles: ["all"],
      preSidecarCount: 0,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "ssh unavailable",
      code: 1,
    });

    await executeRebuild({ skipPull: true, waitForReady: false }, { yes: true, output: "json" });

    expect(lib.pullImages).not.toHaveBeenCalled();
    expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ targetServices: [], waitForReady: false }),
    );
    expect(lib.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        services: ["all"],
        rebuilt: 1,
        completedPhases: ["stop", "build", "start"],
      }),
    );
  });

  it("supports dry-run output and parallel dry-run dependency plans", async () => {
    await executeRebuild(
      { service: "plex", parallel: true, workers: "2", healthTimeout: "30" },
      { dryRun: true, output: "json" },
    );

    expect(lib.computeExecutionPhases).toHaveBeenCalledWith(
      "compose.yml",
      mockConfig,
      ["plex"],
      undefined,
    );
    expect(lib.formatExecutionPlan).toHaveBeenCalledWith(graph.phases, 2);
    expect(lib.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        dryRun: true,
        parallel: true,
        workers: 2,
        healthTimeout: 30,
      }),
    );
    expect(lib.stopServices).not.toHaveBeenCalled();
  });

  it("returns when service selection is cancelled or confirmation is denied", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);
    await executeRebuild({ service: "plex" }, { yes: true });
    expect(lib.stopServices).not.toHaveBeenCalled();

    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(common.confirm).mockResolvedValue(false);
    await executeRebuild({ service: "plex" }, {});
    expect(lib.stopServices).not.toHaveBeenCalled();
  });

  it("formats sequential phase failures and stops before later phases", async () => {
    vi.mocked(lib.stopServices).mockResolvedValueOnce({
      success: false,
      stdout: "",
      stderr: "stop failed",
      code: 2,
    });

    await executeRebuild({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.pullImages).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.pullImages).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "pull failed",
      code: 3,
    });

    await executeRebuild({ service: "plex" }, { yes: true, output: "json" });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.buildImages).not.toHaveBeenCalled();

    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.pullImages).mockResolvedValue(ok);
    vi.mocked(lib.buildImages).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "build failed",
      code: 4,
    });

    await executeRebuild({ service: "plex" }, { yes: true, output: "json" });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.startServices).not.toHaveBeenCalled();
  });

  it("marks readiness and running-container mismatches unhealthy", async () => {
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ...readySummary,
      ready: false,
      pendingDependencies: ["db"],
    } as any);
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: true,
      stdout: "rfapps-other-1\n",
      stderr: "",
      code: 0,
    });

    await executeRebuild({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        unhealthy: expect.arrayContaining(["db", "plex"]),
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("records failed state for unexpected sequential errors", async () => {
    vi.mocked(lib.stopServices).mockRejectedValue(new Error("docker unavailable"));

    await executeRebuild({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({ service: "plex", action: "rebuild", status: "failed" }),
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("handles parallel cycle detection and dry-run cycle detection", async () => {
    vi.mocked(lib.computeExecutionPhases).mockResolvedValue({
      phases: [],
      dependencyMap: new Map(),
      hasCycles: true,
      cycleServices: ["plex", "db"],
    } as any);

    await executeRebuild({ service: "plex", parallel: true }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.executeParallelPhases).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.computeExecutionPhases).mockResolvedValue({
      phases: [],
      dependencyMap: new Map(),
      hasCycles: true,
      cycleServices: ["plex", "db"],
    } as any);

    await executeRebuild({ service: "plex", parallel: true }, { dryRun: true });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("runs parallel rebuild phases, aggregates failures, checks readiness, and records state", async () => {
    vi.mocked(lib.executeParallelPhases)
      .mockResolvedValueOnce({ succeeded: ["plex"], failed: [] } as any)
      .mockResolvedValueOnce({
        succeeded: ["plex"],
        failed: [{ name: "plex", error: "pull failed" }],
      } as any)
      .mockResolvedValueOnce({ succeeded: ["plex"], failed: [] } as any)
      .mockResolvedValueOnce({
        succeeded: ["plex"],
        failed: [{ name: "worker", error: "start failed" }],
      } as any);

    await executeRebuild({ service: "plex", parallel: true }, { yes: true, output: "json" });

    expect(lib.executeParallelPhases).toHaveBeenCalledTimes(4);
    expect(lib.startServices).toHaveBeenCalledWith("compose.yml", undefined, {
      streamOutput: false,
      profiles: ["media"],
      envTool: undefined,
    });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({ service: "plex", action: "rebuild", status: "failed" }),
    ]);
    expect(lib.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        services: ["plex"],
        rebuilt: 1,
        failed: expect.arrayContaining([
          { name: "plex", error: "pull failed" },
          { name: "worker", error: "start failed" },
        ]),
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("records failed state for unexpected parallel errors", async () => {
    vi.mocked(lib.computeExecutionPhases).mockRejectedValue(new Error("graph failed"));

    await executeRebuild({ service: "plex", parallel: true }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({ service: "plex", action: "rebuild", status: "failed" }),
    ]);
    expect(process.exitCode).toBe(1);
  });
});
