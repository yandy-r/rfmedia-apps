import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeApply } from "./apply.js";
import * as lib from "../lib/index.js";
import * as planStorage from "../lib/plan-storage.js";
import * as common from "@rfmedia/common";
import { formatOutput } from "../lib/formatters/index.js";
import { PlanValidationError } from "../lib/errors.js";

// Mock dependencies
vi.mock("../lib/index.js");
vi.mock("../lib/plan-storage.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Apply Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    profiles: { defaultProfile: "core" },
    sidecars: { enabled: true, mapping: {} },
    healthCheck: { timeout: 60, interval: 1, retries: 2, waitForReady: true },
    parallel: { enabled: false, workers: 4 },
  };

  const mockDb = { close: vi.fn() };

  const mockPlan = {
    id: "plan-2025-01-15",
    createdAt: new Date().toISOString(),
    composeHash: "abc123",
    composePath: "compose.yml",
    profiles: ["core"],
    services: [
      {
        service: "traefik",
        changeType: "recreate" as const,
        image: { current: "traefik:v2.0", desired: "traefik:v3.0", changed: true },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      },
    ],
    summary: {
      toCreate: 0,
      toUpdate: 0,
      toRecreate: 1,
      toDelete: 0,
      unchanged: 0,
      updatesAvailable: 0,
      total: 1,
    },
  };

  const readySummary = {
    ready: true,
    timedOut: false,
    totalDependencies: 0,
    readyDependencies: [],
    pendingDependencies: [],
    failedDependencies: [],
    elapsedMs: 0,
    attempts: 1,
    signalAvailability: {
      available: true,
      unavailableSignals: [],
    },
    services: [],
  };

  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.initializeDatabase).mockResolvedValue(mockDb as any);
    vi.mocked(lib.closeDatabase).mockReturnValue(undefined);
    vi.mocked(lib.recordDeployments).mockReturnValue(undefined as any);
    vi.mocked(lib.pullImages).mockResolvedValue({ success: true, stdout: "", stderr: "", code: 0 });
    vi.mocked(lib.startServices).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: true,
      stdout: "rfapps-traefik-1\n",
      stderr: "",
      code: 0,
    });
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue(readySummary as any);
    vi.mocked(common.formatError).mockReturnValue({
      message: "error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
    vi.mocked(common.isMachineFormat).mockReturnValue(false);
    vi.mocked(common.confirm).mockResolvedValue(true);
    vi.mocked(common.colors.bold).mockImplementation((value: string | number | null | undefined) =>
      String(value),
    );
    vi.mocked(common.colors.green).mockImplementation((value: string | number | null | undefined) =>
      String(value),
    );
    vi.mocked(common.colors.cyan).mockImplementation((value: string | number | null | undefined) =>
      String(value),
    );
    vi.mocked(common.colors.yellow).mockImplementation(
      (value: string | number | null | undefined) => String(value),
    );
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  function expectOrdinaryApplyNotStarted(): void {
    expect(planStorage.validatePlan).not.toHaveBeenCalled();
    expect(lib.loadConfig).not.toHaveBeenCalled();
    expect(lib.applyCliOverrides).not.toHaveBeenCalled();
    expect(lib.pullImages).not.toHaveBeenCalled();
    expect(lib.startServices).not.toHaveBeenCalled();
    expect(lib.computeExecutionPhases).not.toHaveBeenCalled();
    expect(lib.executeParallelPhases).not.toHaveBeenCalled();
    expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
    expect(lib.getRunningContainers).not.toHaveBeenCalled();
    expect(lib.initializeDatabase).not.toHaveBeenCalled();
    expect(lib.closeDatabase).not.toHaveBeenCalled();
    expect(lib.recordDeployments).not.toHaveBeenCalled();
    expect(common.confirm).not.toHaveBeenCalled();
  }

  describe("plan intent boundary", () => {
    it("routes managed-update plans to the dedicated update command before mutation", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue({
        ...mockPlan,
        intent: "managed-update",
      });

      await expect(
        executeApply({ planFile: "/tmp/managed-update.json" }, { yes: true }),
      ).rejects.toMatchObject({
        planPath: "/tmp/managed-update.json",
        reason: expect.stringContaining("rfapps update --from-plan <path> --apply"),
      });

      expectOrdinaryApplyNotStarted();
    });

    it("does not allow --force to bypass the managed-update boundary", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue({
        ...mockPlan,
        intent: "managed-update",
      });

      await expect(
        executeApply({ planFile: "/tmp/managed-update.json", force: true }, { yes: true }),
      ).rejects.toThrow(PlanValidationError);

      expectOrdinaryApplyNotStarted();
    });

    it("rejects a malformed plan intent before mutation", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue({
        ...mockPlan,
        intent: "unexpected-intent",
      } as never);

      await expect(
        executeApply({ planFile: "/tmp/malformed-intent.json" }, { yes: true }),
      ).rejects.toMatchObject({
        planPath: "/tmp/malformed-intent.json",
        reason: expect.stringContaining("invalid intent"),
      });

      expectOrdinaryApplyNotStarted();
    });

    it("continues to accept a legacy deployment plan without intent", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });

      await executeApply({ planFile: "/tmp/legacy-plan.json" }, { yes: true, dryRun: true });

      expect(planStorage.validatePlan).toHaveBeenCalledWith(mockPlan, { force: false });
      expect(lib.loadConfig).toHaveBeenCalledOnce();
    });
  });

  describe("PlanValidationError for missing plan file", () => {
    it("should throw PlanValidationError when plan file is not found", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(undefined);

      await expect(
        executeApply({ planFile: "/tmp/nonexistent-plan.json" }, { yes: true }),
      ).rejects.toThrow(PlanValidationError);
    });

    it("should include plan path and reason in thrown error for missing file", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(undefined);

      try {
        await executeApply({ planFile: "/tmp/nonexistent-plan.json" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PlanValidationError);
        const planError = error as PlanValidationError;
        expect(planError.planPath).toBe("/tmp/nonexistent-plan.json");
        expect(planError.reason).toBe("Plan file not found");
        expect(planError.message).toContain("Plan file not found");
      }
    });
  });

  describe("PlanValidationError for validation errors", () => {
    it("should throw PlanValidationError when plan has validation errors", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: false,
        errors: ["Compose file has changed since plan was created"],
        warnings: [],
      });

      await expect(
        executeApply({ planFile: "/tmp/stale-plan.json" }, { yes: true }),
      ).rejects.toThrow(PlanValidationError);
    });

    it("should include validation error details in thrown error", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: false,
        errors: ["Plan ID is missing", "Compose file has changed since plan was created"],
        warnings: [],
      });

      try {
        await executeApply({ planFile: "/tmp/invalid-plan.json" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PlanValidationError);
        const planError = error as PlanValidationError;
        expect(planError.planPath).toBe("/tmp/invalid-plan.json");
        // Errors are joined with "; "
        expect(planError.reason).toContain("Plan ID is missing");
        expect(planError.reason).toContain("Compose file has changed");
      }
    });

    it("should NOT throw when plan has only warnings (no errors)", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: ["Plan is 25.0 hours old"],
      });

      // Use dryRun to short-circuit before Docker operations and sleep()
      // This still exercises the full validation path (loadPlan + validatePlan)
      await executeApply({ planFile: "/tmp/old-plan.json" }, { yes: true, dryRun: true });

      // Warnings should be logged but not cause a throw
      expect(common.logWarn).toHaveBeenCalledWith("Plan is 25.0 hours old");
    });
  });

  describe("Docker errors (locally formatted)", () => {
    it("should format ImagePullError locally without throwing on pull failure", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "network timeout",
        code: 1,
      });

      // Should NOT throw -- Docker errors use local formatting
      await executeApply({ planFile: "/tmp/valid-plan.json" }, { yes: true });

      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("should format ServiceStartError locally without throwing on start failure", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.startServices).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "container exited with code 1",
        code: 1,
      });

      await executeApply({ planFile: "/tmp/valid-plan.json" }, { yes: true });

      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("successful apply", () => {
    it("applies a valid plan sequentially, verifies readiness, and records state", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });

      await executeApply({ planFile: "/tmp/valid-plan.json" }, { yes: true });

      expect(lib.pullImages).toHaveBeenCalledWith("compose.yml", ["traefik"], {
        streamOutput: true,
        profiles: ["core"],
        envTool: undefined,
      });
      expect(lib.startServices).toHaveBeenCalledWith("compose.yml", ["traefik"], {
        streamOutput: true,
        profiles: ["core"],
        forceRecreate: true,
        envTool: undefined,
      });
      expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          composePath: "compose.yml",
          targetServices: ["traefik"],
          waitForReady: true,
        }),
      );
      // Success entries must record image.desired so generation snapshots reflect the post-apply image
      expect(lib.recordDeployments).toHaveBeenCalledWith(mockDb, [
        expect.objectContaining({
          service: "traefik",
          action: "apply",
          status: "success",
          planId: mockPlan.id,
          imageTag: "traefik:v3.0", // desired image, not the pre-apply current image
        }),
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it("returns an empty success result in machine format when a plan has no changes", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue({
        ...mockPlan,
        services: [],
        summary: {
          toCreate: 0,
          toUpdate: 0,
          toRecreate: 0,
          toDelete: 0,
          unchanged: 1,
          updatesAvailable: 0,
          total: 1,
        },
      } as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });

      await executeApply({ planFile: "/tmp/no-change-plan.json" }, { output: "json", yes: true });

      expect(formatOutput).toHaveBeenCalledWith("json", {
        planId: mockPlan.id,
        applied: [],
        failed: [],
        total: 0,
        success: true,
      });
      expect(lib.loadConfig).not.toHaveBeenCalled();
    });

    it("applies a valid plan through the parallel execution path", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });
      vi.mocked(lib.computeExecutionPhases).mockResolvedValue({
        phases: [["traefik"]],
        dependencyMap: new Map([["traefik", []]]),
        hasCycles: false,
      } as any);
      vi.mocked(lib.executeParallelPhases)
        .mockResolvedValueOnce({ succeeded: ["traefik"], failed: [] } as any)
        .mockResolvedValueOnce({ succeeded: ["traefik"], failed: [] } as any);

      await executeApply({ planFile: "/tmp/valid-plan.json", parallel: true }, { yes: true });

      expect(lib.executeParallelPhases).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: "pull",
          phases: [["traefik"]],
          workers: 4,
        }),
      );
      expect(lib.executeParallelPhases).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          operation: "start",
          forceRecreate: true,
          noPull: true,
        }),
      );
      expect(lib.startServices).toHaveBeenCalledWith("compose.yml", undefined, {
        streamOutput: false,
        profiles: ["core"],
        envTool: undefined,
      });
      expect(lib.recordDeployments).toHaveBeenCalledWith(mockDb, [
        expect.objectContaining({
          service: "traefik",
          status: "success",
        }),
      ]);
    });
  });

  describe("dependency readiness verification", () => {
    it("should fail apply when dependency readiness times out", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      });
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.startServices).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
        ready: false,
        timedOut: true,
        totalDependencies: 1,
        readyDependencies: [],
        pendingDependencies: ["authentik-db"],
        failedDependencies: [],
        elapsedMs: 60_000,
        attempts: 2,
        signalAvailability: {
          available: true,
          unavailableSignals: [],
        },
        services: [
          {
            service: "traefik",
            dependencies: [
              {
                dependency: "authentik-db",
                status: "pending",
                probes: [],
              },
            ],
          },
        ],
      });
      vi.mocked(lib.getRunningContainers).mockResolvedValue({
        success: true,
        stdout: "rfapps-traefik-1\n",
        stderr: "",
        code: 0,
      });

      await executeApply({ planFile: "/tmp/valid-plan.json" }, { yes: true });

      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("error type verification for handleCliError integration", () => {
    it("should throw PlanValidationError that extends Error for handleCliError", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(undefined);

      try {
        await executeApply({ planFile: "/tmp/missing.json" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        // Verify the error extends Error so handleCliError can process it
        expect(error).toBeInstanceOf(Error);
        // Verify it has a .name property for extractErrorProperties()
        expect((error as Error).name).toBe("PlanValidationError");
      }
    });

    it("should throw PlanValidationError with correct error properties", async () => {
      vi.mocked(planStorage.loadPlan).mockResolvedValue(mockPlan as any);
      vi.mocked(planStorage.validatePlan).mockResolvedValue({
        valid: false,
        errors: ["Compose file has changed since plan was created. Use --force to apply anyway."],
        warnings: [],
      });

      try {
        await executeApply({ planFile: "/tmp/stale.json" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PlanValidationError);
        const planError = error as PlanValidationError;
        // Verify properties that handleCliError's formatError would use
        expect(planError.name).toBe("PlanValidationError");
        expect(planError.planPath).toBe("/tmp/stale.json");
        expect(planError.reason).toContain("Compose file has changed");
        // Verify the error message follows the standard pattern
        expect(planError.message).toMatch(/^Plan validation failed:/);
      }
    });
  });
});
