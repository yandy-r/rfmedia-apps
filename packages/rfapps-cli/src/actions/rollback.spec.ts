import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeRollback } from "./rollback.js";
import * as lib from "../lib/index.js";
import * as docker from "../lib/docker.js";
import * as common from "@rfmedia/common";
import {
  DeploymentNotFoundError,
  InsufficientHistoryError,
  GenerationNotFoundError,
  InvalidArgumentError,
  ImagePullError,
} from "../lib/errors.js";
import type { GenerationEntry } from "../types/index.js";

// Mock dependencies
vi.mock("../lib/index.js");
vi.mock("../lib/docker.js");
vi.mock("@rfmedia/common");

describe("Rollback Action", () => {
  const LOCAL_IMAGE_ID = `sha256:${"a".repeat(64)}`;
  const OTHER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
  const IMAGE_DIGEST = `docker.io/library/traefik@sha256:${"c".repeat(64)}`;

  const mockConfig = {
    composePath: "compose.yml",
    profiles: { defaultProfile: "core" },
    sidecars: { enabled: true, mapping: {} },
  };

  const mockDb = { close: vi.fn() };

  const mockTarget = {
    id: 42,
    timestamp: "2025-01-15T10:00:00Z",
    service: "traefik",
    action: "deploy" as const,
    imageTag: "traefik:v3.0",
    configSnapshot: JSON.stringify({ image: "traefik:v3.0" }),
    status: "success" as const,
    planId: undefined,
    errorMessage: undefined,
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
    vi.mocked(lib.expandServicesWithSidecars).mockReturnValue(["traefik"]);
    vi.mocked(lib.getRunningServiceContainerMap).mockResolvedValue(
      new Map([["traefik", "rfapps-traefik-1"]]),
    );
    vi.mocked(lib.execDockerCompose).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
    vi.mocked(docker.inspectContainerIdentity).mockResolvedValue({
      containerId: "container-id",
      localImageId: LOCAL_IMAGE_ID,
      configuredImage: "traefik:v3.0",
      repositoryDigest: IMAGE_DIGEST,
      platform: "linux/amd64",
      state: "running",
      exitCode: 0,
      health: "healthy",
    });
    vi.mocked(lib.formatOutput).mockResolvedValue(undefined);
    vi.mocked(common.formatError).mockReturnValue({
      message: "error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
    vi.mocked(common.isMachineFormat).mockReturnValue(false);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  describe("DeploymentNotFoundError", () => {
    it("should throw DeploymentNotFoundError for invalid deployment ID", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(undefined);

      await expect(
        executeRollback({ service: "traefik", toDeployment: "999" }, { yes: true }),
      ).rejects.toThrow(DeploymentNotFoundError);
    });

    it("should include deployment ID and service in thrown error", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(undefined);

      try {
        await executeRollback({ service: "traefik", toDeployment: "999" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(DeploymentNotFoundError);
        const deployError = error as DeploymentNotFoundError;
        expect(deployError.deploymentId).toBe("999");
        expect(deployError.service).toBe("traefik");
        expect(deployError.message).toContain("999");
        expect(deployError.message).toContain("traefik");
      }
    });

    it("should close database in finally block after DeploymentNotFoundError", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(undefined);

      await expect(
        executeRollback({ service: "traefik", toDeployment: "999" }, { yes: true }),
      ).rejects.toThrow(DeploymentNotFoundError);

      expect(lib.closeDatabase).toHaveBeenCalledWith(mockDb);
    });
  });

  describe("InsufficientHistoryError", () => {
    it("should throw InsufficientHistoryError when not enough history for steps", async () => {
      // Request 3 steps back, but only 2 successful deployments exist
      vi.mocked(lib.getSuccessfulDeploymentCount).mockReturnValue(2);

      await expect(
        executeRollback({ service: "traefik", steps: "3" }, { yes: true }),
      ).rejects.toThrow(InsufficientHistoryError);
    });

    it("should include service, requested steps, and available steps in thrown error", async () => {
      vi.mocked(lib.getSuccessfulDeploymentCount).mockReturnValue(1);

      try {
        await executeRollback({ service: "plex", steps: "5" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientHistoryError);
        const histError = error as InsufficientHistoryError;
        expect(histError.service).toBe("plex");
        expect(histError.requestedSteps).toBe(5);
        expect(histError.availableSteps).toBe(1);
      }
    });

    it("should throw when successfulCount equals stepsBack (needs strictly more)", async () => {
      // successfulCount <= stepsBack triggers the error
      vi.mocked(lib.getSuccessfulDeploymentCount).mockReturnValue(3);

      await expect(
        executeRollback({ service: "traefik", steps: "3" }, { yes: true }),
      ).rejects.toThrow(InsufficientHistoryError);
    });

    it("should NOT throw when successfulCount is strictly greater than stepsBack", async () => {
      vi.mocked(lib.getSuccessfulDeploymentCount).mockReturnValue(4);
      vi.mocked(lib.findRollbackTarget).mockReturnValue(mockTarget);
      vi.mocked(lib.imageExists).mockResolvedValue(true);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(100);

      // Should not throw -- 4 > 3
      await executeRollback({ service: "traefik", steps: "3" }, { yes: true });

      expect(lib.findRollbackTarget).toHaveBeenCalledWith(mockDb, "traefik", 3);
    });
  });

  describe("ImagePullError (locally formatted)", () => {
    it("should format ImagePullError locally without throwing on pull failure", async () => {
      // Set up a valid rollback target
      vi.mocked(lib.findDeploymentById).mockReturnValue(mockTarget);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(lib.imageExists).mockResolvedValue(false);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "network timeout pulling traefik:v3.0",
        code: 1,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(101);

      // Should NOT throw -- Docker errors are formatted locally
      await executeRollback({ service: "traefik", toDeployment: "42" }, { yes: true });

      // Verify outputFormattedError was called (local formatting pattern)
      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(common.formatError).toHaveBeenCalledWith(expect.any(ImagePullError));

      // Verify process.exitCode was set
      expect(process.exitCode).toBe(1);
    });

    it("should record failed rollback state after pull failure", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(mockTarget);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(lib.imageExists).mockResolvedValue(false);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "pull failed",
        code: 1,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(101);

      await executeRollback({ service: "traefik", toDeployment: "42" }, { yes: true });

      // Verify deployment was recorded as failed
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          service: "traefik",
          action: "rollback",
          status: "failed",
          imageTag: "traefik:v3.0",
        }),
      );
    });

    it("should output machine format after pull failure when format is set", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(mockTarget);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(lib.imageExists).mockResolvedValue(false);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "pull failed",
        code: 1,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(101);

      await executeRollback(
        { service: "traefik", toDeployment: "42" },
        { yes: true, output: "json" },
      );

      // Verify formatOutput was called for machine output
      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          success: false,
          service: "traefik",
        }),
      );
    });
  });

  describe("DockerCommandError (locally formatted)", () => {
    it("should format DockerCommandError locally on recreate failure", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(mockTarget);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(lib.imageExists).mockResolvedValue(true);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.execDockerCompose).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "container failed to start",
        code: 1,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(102);

      await executeRollback({ service: "traefik", toDeployment: "42" }, { yes: true });

      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("restore by generation and time", () => {
    const mockGeneration: GenerationEntry = {
      id: 7,
      service: "traefik",
      generation: 5,
      deploymentId: 42,
      timestamp: "2025-01-15T10:00:00Z",
      imageTag: "traefik:v3.0",
      configSnapshot: JSON.stringify({ image: "traefik:v3.0" }),
      createdByAction: "deploy",
    };

    function mockSuccessfulDockerOps(): void {
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(lib.imageExists).mockResolvedValue(true);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(100);
    }

    it("recreates an immutable generation by local image ID and verifies the running container", async () => {
      const exactGeneration: GenerationEntry = {
        ...mockGeneration,
        imageId: LOCAL_IMAGE_ID,
        imageDigest: IMAGE_DIGEST,
      };
      vi.mocked(lib.findGenerationByNumber).mockReturnValue(exactGeneration);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(docker.recreateServiceWithImage).mockResolvedValue({
        success: true,
        command: { success: true, stdout: "", stderr: "", code: 0 },
        identity: {
          localImageId: LOCAL_IMAGE_ID,
          configuredImage: "traefik:v3.0",
          repositoryDigest: IMAGE_DIGEST,
        },
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(100);

      await executeRollback({ service: "traefik", toGeneration: "5" }, { yes: true });

      expect(docker.recreateServiceWithImage).toHaveBeenCalledWith(
        {
          composePaths: ["compose.yml"],
          service: "traefik",
          profiles: ["all"],
          source: {
            kind: "local-image-id",
            configuredImage: "traefik:v3.0",
            localImageId: LOCAL_IMAGE_ID,
          },
        },
        { streamOutput: true, envTool: undefined },
      );
      expect(docker.inspectContainerIdentity).toHaveBeenCalledWith("rfapps-traefik-1", {
        envTool: undefined,
      });
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.execDockerCompose).not.toHaveBeenCalled();
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          status: "success",
          imageId: LOCAL_IMAGE_ID,
          imageDigest: IMAGE_DIGEST,
        }),
      );
    });

    it("verifies and records an exact restore when temporary override cleanup fails", async () => {
      const exactGeneration: GenerationEntry = {
        ...mockGeneration,
        imageId: LOCAL_IMAGE_ID,
        imageDigest: IMAGE_DIGEST,
      };
      vi.mocked(lib.findGenerationByNumber).mockReturnValue(exactGeneration);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(docker.recreateServiceWithImage).mockResolvedValue({
        success: true,
        command: { success: true, stdout: "", stderr: "", code: 0 },
        identity: {
          localImageId: LOCAL_IMAGE_ID,
          configuredImage: "traefik:v3.0",
          repositoryDigest: IMAGE_DIGEST,
        },
        cleanup: {
          status: "failed",
          code: "TEMP_OVERRIDE_CLEANUP_FAILED",
          message:
            "Temporary image override cleanup failed; remove the retained directory manually",
          temporaryDirectory: "/tmp/rfapps-update-retained",
        },
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(100);

      await executeRollback(
        { service: "traefik", toGeneration: "5" },
        { yes: true, output: "json" },
      );

      expect(docker.inspectContainerIdentity).toHaveBeenCalled();
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "success", imageId: LOCAL_IMAGE_ID }),
      );
      expect(process.exitCode).toBeUndefined();
      expect(common.logWarn).toHaveBeenCalledWith(
        "Temporary image override cleanup failed; retained directory: /tmp/rfapps-update-retained",
      );
      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          success: true,
          warnings: [
            {
              code: "TEMP_OVERRIDE_CLEANUP_FAILED",
              message:
                "Temporary image override cleanup failed; remove the retained directory manually",
              temporaryDirectory: "/tmp/rfapps-update-retained",
            },
          ],
        }),
      );
    });

    it("records a failed attempt instead of success when immutable identity verification mismatches", async () => {
      vi.mocked(lib.findGenerationByNumber).mockReturnValue({
        ...mockGeneration,
        imageId: LOCAL_IMAGE_ID,
      });
      vi.mocked(lib.getLatestDeployment).mockReturnValue(mockTarget);
      vi.mocked(docker.recreateServiceWithImage).mockResolvedValue({
        success: true,
        command: { success: true, stdout: "", stderr: "", code: 0 },
        identity: { localImageId: LOCAL_IMAGE_ID, configuredImage: "traefik:v3.0" },
      });
      vi.mocked(docker.inspectContainerIdentity).mockResolvedValue({
        containerId: "container-id",
        localImageId: OTHER_IMAGE_ID,
        configuredImage: "traefik:v3.0",
        state: "running",
        exitCode: 0,
        health: "healthy",
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(101);

      await executeRollback({ service: "traefik", toGeneration: "5" }, { yes: true });

      expect(process.exitCode).toBe(1);
      expect(lib.recordDeployment).toHaveBeenCalledTimes(1);
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "failed" }),
      );
      expect(lib.recordDeployment).not.toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "success" }),
      );
    });

    it("keeps legacy generation rollback targeted and labels mutable-tag best effort", async () => {
      vi.mocked(lib.findGenerationByNumber).mockReturnValue(mockGeneration);
      mockSuccessfulDockerOps();

      await executeRollback({ service: "traefik", toGeneration: "5" }, { yes: true });

      expect(docker.recreateServiceWithImage).not.toHaveBeenCalled();
      expect(lib.execDockerCompose).toHaveBeenCalledWith(
        [
          "-f",
          "compose.yml",
          "--profile",
          "all",
          "up",
          "-d",
          "--force-recreate",
          "--pull",
          "never",
          "traefik",
        ],
        { streamOutput: true, envTool: undefined },
      );
      expect(vi.mocked(lib.execDockerCompose).mock.calls.flat()).not.toContain("--remove-orphans");
      expect(common.logWarn).toHaveBeenCalledWith(expect.stringContaining("best effort"));
    });

    it("restores to a specific generation with --to-generation", async () => {
      vi.mocked(lib.findGenerationByNumber).mockReturnValue(mockGeneration);
      mockSuccessfulDockerOps();

      await executeRollback({ service: "traefik", toGeneration: "5" }, { yes: true });

      expect(lib.findGenerationByNumber).toHaveBeenCalledWith(mockDb, "traefik", 5);
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          service: "traefik",
          action: "rollback",
          status: "success",
          imageTag: "traefik:v3.0",
        }),
      );
    });

    it("includes the target generation in machine output", async () => {
      vi.mocked(lib.findGenerationByNumber).mockReturnValue(mockGeneration);
      mockSuccessfulDockerOps();

      await executeRollback(
        { service: "traefik", toGeneration: "5" },
        { yes: true, output: "json" },
      );

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          success: true,
          service: "traefik",
          targetDeploymentId: 42,
          targetGeneration: 5,
        }),
      );
    });

    it("throws GenerationNotFoundError when the generation does not exist", async () => {
      vi.mocked(lib.findGenerationByNumber).mockReturnValue(undefined);

      try {
        await executeRollback({ service: "traefik", toGeneration: "99" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GenerationNotFoundError);
        const genError = error as GenerationNotFoundError;
        expect(genError.service).toBe("traefik");
        expect(genError.criteria).toBe("generation 99");
      }
    });

    it("restores to the generation active at a time with --to-time", async () => {
      vi.mocked(lib.findGenerationAtTime).mockReturnValue(mockGeneration);
      mockSuccessfulDockerOps();

      await executeRollback({ service: "traefik", toTime: "2025-02-01T00:00:00Z" }, { yes: true });

      expect(lib.findGenerationAtTime).toHaveBeenCalledWith(
        mockDb,
        "traefik",
        "2025-02-01T00:00:00.000Z",
      );
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ action: "rollback", status: "success" }),
      );
    });

    it("throws GenerationNotFoundError when no generation existed at the time", async () => {
      vi.mocked(lib.findGenerationAtTime).mockReturnValue(undefined);

      await expect(
        executeRollback({ service: "traefik", toTime: "2020-01-01T00:00:00Z" }, { yes: true }),
      ).rejects.toThrow(GenerationNotFoundError);
    });

    it("throws InvalidArgumentError for an invalid --to-time value", async () => {
      await expect(
        executeRollback({ service: "traefik", toTime: "not-a-date" }, { yes: true }),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it("throws InvalidArgumentError for a non-positive --to-generation value", async () => {
      await expect(
        executeRollback({ service: "traefik", toGeneration: "0" }, { yes: true }),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it("rejects combining --to-deployment with --to-generation", async () => {
      await expect(
        executeRollback(
          { service: "traefik", toDeployment: "42", toGeneration: "5" },
          { yes: true },
        ),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it("rejects combining --to-generation with --to-time", async () => {
      await expect(
        executeRollback(
          {
            service: "traefik",
            toGeneration: "5",
            toTime: "2025-02-01T00:00:00Z",
          },
          { yes: true },
        ),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it("rejects combining --steps with --to-generation", async () => {
      await expect(
        executeRollback({ service: "traefik", steps: "3", toGeneration: "5" }, { yes: true }),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it("falls back to target.imageTag when configSnapshot.image is an ImageDiff object", async () => {
      // Apply records store a ServiceChange whose image field is an object, not a string
      const targetWithObjectImage = {
        ...mockTarget,
        imageTag: "traefik:v2",
        configSnapshot: JSON.stringify({ image: { current: "traefik:v1", desired: "traefik:v2" } }),
      };
      vi.mocked(lib.findDeploymentById).mockReturnValue(targetWithObjectImage);
      vi.mocked(lib.getLatestDeployment).mockReturnValue(targetWithObjectImage);
      vi.mocked(lib.imageExists).mockResolvedValue(true);
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.recordDeployment).mockReturnValue(100);

      await executeRollback({ service: "traefik", toDeployment: "42" }, { yes: true });

      // Should have used target.imageTag ("traefik:v2"), not the ImageDiff object
      expect(lib.recordDeployment).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          imageTag: "traefik:v2",
        }),
      );
    });
  });

  describe("error type verification for handleCliError integration", () => {
    it("should throw errors that extend Error for handleCliError compatibility", async () => {
      vi.mocked(lib.findDeploymentById).mockReturnValue(undefined);

      try {
        await executeRollback({ service: "traefik", toDeployment: "999" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        // Verify the error extends Error so handleCliError can process it
        expect(error).toBeInstanceOf(Error);
        // Verify it has a .name property for extractErrorProperties()
        expect((error as Error).name).toBe("DeploymentNotFoundError");
      }
    });

    it("should throw InsufficientHistoryError that extends Error", async () => {
      vi.mocked(lib.getSuccessfulDeploymentCount).mockReturnValue(0);

      try {
        await executeRollback({ service: "traefik", steps: "1" }, { yes: true });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("InsufficientHistoryError");
      }
    });
  });
});
