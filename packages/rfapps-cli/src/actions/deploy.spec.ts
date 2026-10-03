import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executeDeploy } from "./deploy.js";
import * as deployValidation from "../lib/deploy-validation.js";
import { ExitCode } from "../lib/exit-codes.js";
import * as formatters from "../lib/formatters/index.js";
import * as lib from "../lib/index.js";
import type { FailedOperation, StagedRolloutReport } from "../types/index.js";
import { SCAN_SCHEMA_VERSION } from "../types/security-scan.js";
import type { ResolvedScanSettings, ScanReport } from "../types/security-scan.js";
import type { ConflictValidationResult, ConflictValidationStatus } from "../types/validation.js";
import * as validation from "../lib/validation.js";

vi.mock("../lib/index.js");
vi.mock("../lib/deploy-validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/deploy-validation.js")>();
  return {
    ...actual,
    canonicalizeDeployEnvTool: vi.fn(),
    composeExecutionOptions: vi.fn(),
    revalidateDeployBinding: vi.fn(),
    runDeployValidation: vi.fn(),
    validationDependencyGraph: vi.fn(),
  };
});
vi.mock("../lib/validation.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
  projectConflictValidationTable: vi.fn((result: ConflictValidationResult) => [
    { field: "decision", value: result.status.toUpperCase() },
  ]),
}));
vi.mock("@rfmedia/common");

function validationResult(status: ConflictValidationStatus): ConflictValidationResult {
  const base = {
    schemaVersion: "conflict-validation.v1" as const,
    scope: {
      project: "rfapps",
      services: ["app"],
      profiles: ["core"],
    },
    checks: [
      {
        id: "compose" as const,
        status: "passed" as const,
        required: true,
        resources: 1,
      },
    ],
    summary: {
      total: status === "blocked" ? 1 : 0,
      errors: status === "blocked" ? 1 : 0,
      warnings: 0,
      ports: status === "blocked" ? 1 : 0,
      volumes: 0,
      networks: 0,
    },
    conflicts: [],
    warnings: [],
    limitations: [
      {
        code: "POINT_IN_TIME_SNAPSHOT" as const,
        message: "Docker resources can change after inspection.",
      },
    ],
  };
  if (status === "inconclusive") {
    return {
      ...base,
      status,
      error: {
        code: "CONTAINER_SNAPSHOT_UNAVAILABLE",
        check: "containers",
        message: "Docker container evidence was unavailable.",
      },
    };
  }
  return { ...base, status };
}

function validationOutcome(
  status: ConflictValidationStatus = "passed",
): deployValidation.DeployValidationOutcome {
  return {
    binding: {
      composePath: resolve(import.meta.dirname, "../../../../compose.yml"),
      projectDir: resolve(import.meta.dirname, "../../../.."),
      projectName: "rfapps",
      envFile: "/project/.env.local",
      profiles: ["core"],
      environment: { PATH: "/usr/bin" },
      composeFileFingerprint: "compose-file-fingerprint",
      resolvedComposeFingerprint: "resolved-compose-fingerprint",
      authorityFingerprint: "authority-fingerprint",
    },
    canonicalCompose: {
      name: "rfapps",
      services: {
        app: {
          name: "app",
          depends_on: [],
          ports: [],
          volumes: [],
          networks: [],
        },
      },
      volumes: {},
      networks: {},
    },
    effectiveServices: ["app"],
    result: validationResult(status),
  };
}

/**
 * Single-batch stand-in for the real rollout coordinator.
 *
 * `vi.mock("../lib/index.js")` is a bare automock, so `executeStagedRollout`
 * would otherwise resolve `undefined` and never invoke the injected `runPhase`.
 * A flat `mockResolvedValue` therefore silently breaks every
 * `executeParallelPhases` assertion on the non-staged parallel path. This driver
 * reproduces the non-staged contract instead: one batch, pull then start, and a
 * report projected from whatever the runner returned.
 */
const driveSingleBatchRollout: typeof lib.executeStagedRollout = async (options, deps) => {
  const batch = options.plan.batches[0];
  const failed: FailedOperation[] = [];
  const base = {
    batchSize: options.plan.batchSize,
    onFailure: options.plan.onFailure,
    totalBatches: options.plan.batches.length,
    batches: [],
    unhealthy: [],
  };
  if (batch === undefined) {
    return {
      ...base,
      status: "completed",
      completedBatches: 0,
      attempted: [],
      started: 0,
      healthy: [],
      failed,
    } satisfies StagedRolloutReport;
  }

  if (!options.skipPull) {
    const pull = await deps.runPhase({ operation: "pull", batch, phases: batch.phases });
    failed.push(...pull.failed);
  }
  const start = await deps.runPhase({ operation: "start", batch, phases: batch.phases });
  for (const failure of start.failed) {
    if (!failed.some((entry) => entry.name === failure.name)) {
      failed.push(failure);
    }
  }

  return {
    ...base,
    status: failed.length > 0 ? "degraded" : "completed",
    completedBatches: failed.length > 0 ? 0 : 1,
    attempted: [...start.succeeded, ...start.failed.map((failure) => failure.name)],
    started: start.succeeded.length,
    healthy: [...start.succeeded],
    failed,
  } satisfies StagedRolloutReport;
};

describe("Deploy Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env.local",
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

  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["app"],
      profiles: ["core"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.formatConflictValidationText).mockImplementation((result) => [
      `Conflict validation: ${result.status.toUpperCase()}`,
    ]);
    vi.mocked(validation.validateConfigAgainstCompose).mockResolvedValue([]);
    vi.mocked(validation.formatValidationWarnings).mockReturnValue([]);
    vi.mocked(validation.hasErrors).mockReturnValue(false);
    vi.mocked(deployValidation.canonicalizeDeployEnvTool).mockImplementation(
      async (envTool) => envTool,
    );
    vi.mocked(deployValidation.runDeployValidation).mockResolvedValue(validationOutcome());
    vi.mocked(deployValidation.revalidateDeployBinding).mockResolvedValue(undefined);
    vi.mocked(deployValidation.composeExecutionOptions).mockImplementation((binding) => ({
      cwd: binding.projectDir,
      env: binding.environment,
      replaceEnv: true,
      envFile: binding.envFile,
      projectName: binding.projectName,
    }));
    vi.mocked(deployValidation.validationDependencyGraph).mockReturnValue({
      phases: [{ phase: 0, services: ["app"], dependsOn: [] }],
      dependencyMap: new Map([["app", []]]),
      hasCycles: false,
    });
    vi.mocked(lib.startServices).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: true,
      stdout: "rfapps-app-1\n",
      stderr: "",
      code: 0,
    });
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ready: true,
      timedOut: false,
      totalDependencies: 1,
      readyDependencies: ["db"],
      pendingDependencies: [],
      failedDependencies: [],
      elapsedMs: 1000,
      attempts: 1,
      signalAvailability: {
        available: true,
        unavailableSignals: [],
      },
      services: [
        {
          service: "app",
          dependencies: [
            {
              dependency: "db",
              status: "ready",
              probes: [],
            },
          ],
        },
      ],
    });
    vi.mocked(lib.inspectContainers).mockResolvedValue([
      {
        Id: "id-app",
        Name: "/app",
        Image: "sha256:app",
        Config: {
          Image: "app:latest",
          Env: [],
          ExposedPorts: undefined,
          Volumes: undefined,
        },
        HostConfig: {},
        NetworkSettings: {},
        State: {
          Running: true,
          ExitCode: 0,
        },
      },
    ] as any);
    vi.mocked(lib.initializeDatabase).mockResolvedValue({} as any);
    vi.mocked(lib.recordDeployments).mockReturnValue(undefined as any);
    vi.mocked(lib.closeDatabase).mockReturnValue(undefined);
    // Both parallel paths (staged and non-staged) route through the coordinator,
    // so every parallel test needs a plan and a DRIVING rollout implementation.
    vi.mocked(lib.planStagedBatches).mockImplementation((input) => {
      const batchServices = input.graph.phases.flatMap((phase) => phase.services);
      return {
        batches: [{ index: 1, services: batchServices, phases: input.graph.phases }],
        batchSize: input.batchSize,
        onFailure: input.onFailure,
        totalServices: batchServices.length,
      };
    });
    vi.mocked(lib.executeStagedRollout).mockImplementation(driveSingleBatchRollout);
    vi.mocked(common.formatError).mockReturnValue({
      message: "error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
    vi.mocked(common.isMachineFormat).mockImplementation((format) =>
      ["json", "yaml", "csv"].includes(format ?? ""),
    );
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("passes when readiness checks are ready", async () => {
    await executeDeploy({ service: "app", skipPull: true }, { yes: true, output: "json" });

    expect(lib.waitForDependencyReadiness).toHaveBeenCalled();
    expect(common.outputFormattedError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when readiness check times out with unresolved dependencies", async () => {
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ready: false,
      timedOut: true,
      totalDependencies: 1,
      readyDependencies: [],
      pendingDependencies: ["db"],
      failedDependencies: [],
      elapsedMs: 60_000,
      attempts: 2,
      signalAvailability: {
        available: true,
        unavailableSignals: [],
      },
      services: [
        {
          service: "app",
          dependencies: [
            {
              dependency: "db",
              status: "pending",
              probes: [],
            },
          ],
        },
      ],
    });

    await executeDeploy({ service: "app", skipPull: true }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("returns partial readiness snapshot without failing when waitForReady is disabled", async () => {
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ready: false,
      timedOut: false,
      totalDependencies: 2,
      readyDependencies: ["db"],
      pendingDependencies: ["cache"],
      failedDependencies: [],
      elapsedMs: 500,
      attempts: 1,
      signalAvailability: {
        available: true,
        unavailableSignals: [],
      },
      services: [
        {
          service: "app",
          dependencies: [
            {
              dependency: "db",
              status: "ready",
              probes: [],
            },
            {
              dependency: "cache",
              status: "pending",
              probes: [],
            },
          ],
        },
      ],
    });

    await executeDeploy(
      { service: "app", skipPull: true, waitForReady: false },
      { yes: true, output: "json" },
    );

    expect(common.outputFormattedError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps operational error exit code for mixed sequential start failures by default", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["svc-a", "svc-b"],
      profiles: ["core"],
      preSidecarCount: 2,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.startServices).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "svc-b failed",
      code: 1,
    });
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: true,
      stdout: "rfapps-svc-a-1\n",
      stderr: "",
      code: 0,
    });

    await executeDeploy({ services: "svc-a,svc-b", skipPull: true }, { yes: true, output: "json" });

    expect(process.exitCode).toBe(ExitCode.OperationalError);
  });

  it("sets partial success exit code for mixed sequential start failures with allowPartial", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["svc-a", "svc-b"],
      profiles: ["core"],
      preSidecarCount: 2,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.startServices).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "svc-b failed",
      code: 1,
    });
    vi.mocked(lib.getRunningContainers).mockResolvedValue({
      success: true,
      stdout: "rfapps-svc-a-1\n",
      stderr: "",
      code: 0,
    });

    await executeDeploy(
      { services: "svc-a,svc-b", skipPull: true, allowPartial: true },
      { yes: true, output: "json" },
    );

    expect(process.exitCode).toBe(ExitCode.PartialSuccess);
  });

  it("falls back to config waitForReady when CLI option is unset", async () => {
    vi.mocked(lib.loadConfig).mockResolvedValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);

    await executeDeploy({ service: "app", skipPull: true }, { yes: true, output: "json" });

    expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ waitForReady: false }),
    );
  });

  it("respects explicit --wait-for-ready override when config disables waiting", async () => {
    vi.mocked(lib.loadConfig).mockResolvedValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);

    await executeDeploy(
      { service: "app", skipPull: true, waitForReady: true },
      { yes: true, output: "json" },
    );

    expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ waitForReady: true }),
    );
  });

  describe("--validate-first", () => {
    beforeEach(() => {
      vi.mocked(lib.applyCliOverrides).mockReturnValue({
        ...mockConfig,
        composePath: resolve(import.meta.dirname, "../../../../compose.yml"),
      } as any);
    });

    it("keeps the legacy path free of preflight reads when the flag is absent", async () => {
      await executeDeploy({ service: "app", skipPull: true }, { yes: true, output: "json" });

      expect(deployValidation.canonicalizeDeployEnvTool).not.toHaveBeenCalled();
      expect(deployValidation.runDeployValidation).not.toHaveBeenCalled();
    });

    it("rejects CSV before loading configuration or collecting evidence", async () => {
      await expect(
        executeDeploy({ service: "app", validateFirst: true }, { yes: true, output: "csv" }),
      ).rejects.toMatchObject({
        name: "InvalidArgumentError",
        argument: "--output",
        value: "csv",
      });

      expect(lib.loadConfig).not.toHaveBeenCalled();
      expect(deployValidation.runDeployValidation).not.toHaveBeenCalled();
    });

    it("rejects an invalid explicit profile through the usage-error type", async () => {
      vi.mocked(lib.isValidProfile).mockReturnValue(false);

      await expect(
        executeDeploy({ service: "app", profile: "missing", validateFirst: true }, { yes: true }),
      ).rejects.toMatchObject({
        name: "ProfileNotFoundError",
        profileName: "missing",
      });

      expect(lib.applyCliOverrides).not.toHaveBeenCalled();
      expect(deployValidation.runDeployValidation).not.toHaveBeenCalled();
    });

    it.each(["blocked", "inconclusive"] as const)(
      "emits one %s result and performs no mutation, readiness, prompt, or state work",
      async (status) => {
        vi.mocked(deployValidation.runDeployValidation).mockResolvedValue(
          validationOutcome(status),
        );

        await executeDeploy(
          {
            service: "app",
            validateFirst: true,
            allowPartial: true,
          },
          {
            yes: status === "inconclusive",
            dryRun: status === "blocked",
            output: "json",
          },
        );

        expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
        expect(formatters.formatOutput).toHaveBeenCalledWith(
          "json",
          expect.objectContaining({
            started: 0,
            validation: expect.objectContaining({ status }),
            failed: [
              expect.objectContaining({
                name: "validation",
                code: status === "blocked" ? "SERVICE_CONFLICT" : "VALIDATION_INCONCLUSIVE",
              }),
            ],
          }),
        );
        expect(process.exitCode).toBe(ExitCode.OperationalError);
        expect(common.confirm).not.toHaveBeenCalled();
        expect(lib.pullImages).not.toHaveBeenCalled();
        expect(lib.startServices).not.toHaveBeenCalled();
        expect(lib.executeParallelPhases).not.toHaveBeenCalled();
        expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
        expect(lib.initializeDatabase).not.toHaveBeenCalled();
        expect(lib.recordDeployments).not.toHaveBeenCalled();
      },
    );

    it.each(["passed", "blocked", "inconclusive"] as const)(
      "renders one %s text projection without structured serialization",
      async (status) => {
        vi.mocked(deployValidation.runDeployValidation).mockResolvedValue(
          validationOutcome(status),
        );

        await executeDeploy(
          { service: "app", validateFirst: true, skipPull: true },
          { dryRun: true, output: "text" },
        );

        expect(lib.formatConflictValidationText).toHaveBeenCalledTimes(1);
        expect(lib.formatConflictValidationText).toHaveBeenCalledWith(
          expect.objectContaining({ status }),
        );
        expect(
          vi
            .mocked(common.logInfo)
            .mock.calls.filter(
              ([message]) => message === `Conflict validation: ${status.toUpperCase()}`,
            ),
        ).toHaveLength(1);
        expect(formatters.formatOutput).not.toHaveBeenCalled();

        if (status !== "passed") {
          expect(common.confirm).not.toHaveBeenCalled();
          expect(lib.pullImages).not.toHaveBeenCalled();
          expect(lib.startServices).not.toHaveBeenCalled();
          expect(lib.executeParallelPhases).not.toHaveBeenCalled();
          expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
          expect(lib.initializeDatabase).not.toHaveBeenCalled();
          expect(lib.recordDeployments).not.toHaveBeenCalled();
        }
      },
    );

    it.each(["passed", "blocked", "inconclusive"] as const)(
      "renders one %s table projection without a duplicate text projection",
      async (status) => {
        vi.mocked(deployValidation.runDeployValidation).mockResolvedValue(
          validationOutcome(status),
        );

        await executeDeploy(
          { service: "app", validateFirst: true, skipPull: true },
          { dryRun: true, output: "table" },
        );

        expect(formatters.projectConflictValidationTable).toHaveBeenCalledTimes(1);
        expect(formatters.projectConflictValidationTable).toHaveBeenCalledWith(
          expect.objectContaining({ status }),
        );
        expect(formatters.formatOutput).toHaveBeenCalledWith(
          "table",
          [{ field: "decision", value: status.toUpperCase() }],
          { columns: ["field", "value"] },
        );
        expect(lib.formatConflictValidationText).not.toHaveBeenCalled();

        if (status === "passed") {
          expect(formatters.formatOutput).toHaveBeenCalledTimes(2);
          expect(formatters.formatOutput).toHaveBeenLastCalledWith(
            "table",
            expect.not.objectContaining({ validation: expect.anything() }),
          );
        } else {
          expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
          expect(common.confirm).not.toHaveBeenCalled();
          expect(lib.pullImages).not.toHaveBeenCalled();
          expect(lib.startServices).not.toHaveBeenCalled();
          expect(lib.executeParallelPhases).not.toHaveBeenCalled();
          expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
          expect(lib.initializeDatabase).not.toHaveBeenCalled();
          expect(lib.recordDeployments).not.toHaveBeenCalled();
        }
      },
    );

    it("runs the same fresh preflight during dry-run and attaches the passing evidence", async () => {
      await executeDeploy(
        { service: "app", validateFirst: true, parallel: false },
        { yes: true, dryRun: true, output: "yaml" },
      );

      expect(deployValidation.runDeployValidation).toHaveBeenCalledTimes(1);
      expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
      expect(formatters.formatOutput).toHaveBeenCalledWith(
        "yaml",
        expect.objectContaining({
          dryRun: true,
          services: ["app"],
          validation: expect.objectContaining({ status: "passed" }),
        }),
      );
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
      expect(lib.initializeDatabase).not.toHaveBeenCalled();
      expect(deployValidation.revalidateDeployBinding).not.toHaveBeenCalled();
    });

    it("rechecks the bound Compose inputs and authority before the sequential mutation", async () => {
      const outcome = validationOutcome();
      vi.mocked(deployValidation.runDeployValidation).mockResolvedValue(outcome);

      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { yes: true, output: "json" },
      );

      expect(deployValidation.runDeployValidation).toHaveBeenCalledTimes(1);
      expect(deployValidation.revalidateDeployBinding).toHaveBeenCalledWith(outcome.binding);
      const recheckOrder = vi.mocked(deployValidation.revalidateDeployBinding).mock
        .invocationCallOrder[0];
      const mutationOrder = vi.mocked(lib.startServices).mock.invocationCallOrder[0];
      expect(recheckOrder).toBeDefined();
      expect(mutationOrder).toBeDefined();
      expect(recheckOrder).toBeLessThan(mutationOrder as number);
      expect(lib.startServices).toHaveBeenCalledWith(outcome.binding.composePath, ["app"], {
        streamOutput: true,
        profiles: ["core"],
        forceRecreate: false,
        noPull: false,
        cwd: outcome.binding.projectDir,
        env: { PATH: "/usr/bin" },
        replaceEnv: true,
        envFile: "/project/.env.local",
        projectName: "rfapps",
      });
      expect(lib.inspectContainersWithRetry).toHaveBeenCalledWith(["app"], 3, 1000, {
        cwd: outcome.binding.projectDir,
        env: { PATH: "/usr/bin" },
        replaceEnv: true,
        envFile: "/project/.env.local",
        projectName: "rfapps",
      });
    });

    it("shows a passing human preflight before confirmation and preserves it on cancellation", async () => {
      vi.mocked(common.confirm).mockResolvedValue(false);

      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { output: "text" },
      );

      const projectionOrder = vi.mocked(common.logInfo).mock.invocationCallOrder[0];
      const confirmationOrder = vi.mocked(common.confirm).mock.invocationCallOrder[0];
      expect(projectionOrder).toBeDefined();
      expect(confirmationOrder).toBeDefined();
      expect(projectionOrder).toBeLessThan(confirmationOrder as number);
      expect(common.logInfo).toHaveBeenCalledWith("Conflict validation: PASSED");
      expect(common.logInfo).toHaveBeenCalledWith("Cancelled");
      expect(deployValidation.revalidateDeployBinding).not.toHaveBeenCalled();
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it("preserves one passing validation table on cancellation", async () => {
      vi.mocked(common.confirm).mockResolvedValue(false);

      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { output: "table" },
      );

      const projectionOrder = vi.mocked(formatters.formatOutput).mock.invocationCallOrder[0];
      const confirmationOrder = vi.mocked(common.confirm).mock.invocationCallOrder[0];
      expect(projectionOrder).toBeDefined();
      expect(confirmationOrder).toBeDefined();
      expect(projectionOrder).toBeLessThan(confirmationOrder as number);
      expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
      expect(formatters.formatOutput).toHaveBeenCalledWith(
        "table",
        [{ field: "decision", value: "PASSED" }],
        { columns: ["field", "value"] },
      );
      expect(lib.formatConflictValidationText).not.toHaveBeenCalled();
      expect(deployValidation.revalidateDeployBinding).not.toHaveBeenCalled();
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it("does not duplicate the passing validation table after confirmation", async () => {
      vi.mocked(common.confirm).mockResolvedValue(true);

      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { output: "table" },
      );

      const evidenceOrder = vi.mocked(formatters.formatOutput).mock.invocationCallOrder[0];
      const confirmationOrder = vi.mocked(common.confirm).mock.invocationCallOrder[0];
      const recheckOrder = vi.mocked(deployValidation.revalidateDeployBinding).mock
        .invocationCallOrder[0];
      const mutationOrder = vi.mocked(lib.startServices).mock.invocationCallOrder[0];
      expect(evidenceOrder).toBeDefined();
      expect(confirmationOrder).toBeDefined();
      expect(recheckOrder).toBeDefined();
      expect(mutationOrder).toBeDefined();
      expect(evidenceOrder).toBeLessThan(confirmationOrder as number);
      expect(confirmationOrder).toBeLessThan(recheckOrder as number);
      expect(recheckOrder).toBeLessThan(mutationOrder as number);
      expect(formatters.projectConflictValidationTable).toHaveBeenCalledTimes(1);
      expect(formatters.formatOutput).toHaveBeenCalledTimes(2);
      expect(formatters.formatOutput).toHaveBeenNthCalledWith(
        1,
        "table",
        [{ field: "decision", value: "PASSED" }],
        { columns: ["field", "value"] },
      );
      expect(formatters.formatOutput).toHaveBeenNthCalledWith(
        2,
        "table",
        expect.objectContaining({
          services: ["app"],
          started: 1,
        }),
      );
      expect(vi.mocked(formatters.formatOutput).mock.calls[1]?.[1]).not.toHaveProperty(
        "validation",
      );
      expect(deployValidation.revalidateDeployBinding).toHaveBeenCalledTimes(1);
      expect(lib.startServices).toHaveBeenCalledTimes(1);
    });

    it("keeps a successful binding recheck silent after the human preflight", async () => {
      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { yes: true, output: "text" },
      );

      expect(deployValidation.revalidateDeployBinding).toHaveBeenCalledTimes(1);
      expect(lib.formatConflictValidationText).toHaveBeenCalledTimes(1);
      expect(common.logInfo).toHaveBeenCalledWith("Conflict validation: PASSED");
    });

    it("fails closed on malformed canonical Compose output without logging resolved secrets", async () => {
      const secret = "MUST_NOT_ESCAPE_DEPLOY_PREFLIGHT";
      vi.mocked(deployValidation.runDeployValidation).mockRejectedValue(
        new Error(`Malformed Compose output: ${secret}`),
      );

      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { yes: true, output: "json" },
      );

      expect(lib.resolveComposeProjectIdentity).not.toHaveBeenCalled();
      expect(formatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          validation: expect.objectContaining({
            status: "inconclusive",
            error: expect.objectContaining({
              code: "COMPOSE_CONFIG_UNAVAILABLE",
              message: "Pre-deploy validation inputs could not be resolved safely.",
            }),
          }),
        }),
      );
      expect(JSON.stringify(vi.mocked(formatters.formatOutput).mock.calls)).not.toContain(secret);
      for (const logger of [common.logInfo, common.logWarn, common.logDebug]) {
        expect(JSON.stringify(vi.mocked(logger).mock.calls)).not.toContain(secret);
      }
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it("fails closed on input drift before either deploy branch can mutate", async () => {
      vi.mocked(deployValidation.revalidateDeployBinding).mockResolvedValue({
        code: "VALIDATION_INPUT_CHANGED",
        check: "revalidation",
        message: "The effective Compose inputs changed after pre-deploy validation.",
      });

      await executeDeploy(
        {
          service: "app",
          validateFirst: true,
          skipPull: true,
          parallel: true,
          allowPartial: true,
        },
        { yes: true, output: "json" },
      );

      expect(process.exitCode).toBe(ExitCode.OperationalError);
      expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
      expect(formatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          validation: expect.objectContaining({
            status: "inconclusive",
            error: expect.objectContaining({ code: "VALIDATION_INPUT_CHANGED" }),
          }),
        }),
      );
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
      expect(lib.executeParallelPhases).not.toHaveBeenCalled();
      expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
      expect(lib.initializeDatabase).not.toHaveBeenCalled();
    });

    it("renders changed inconclusive evidence at the no-mutation boundary", async () => {
      vi.mocked(common.confirm).mockResolvedValue(true);
      vi.mocked(deployValidation.revalidateDeployBinding).mockResolvedValue({
        code: "VALIDATION_INPUT_CHANGED",
        check: "revalidation",
        message: "The effective Compose inputs changed after pre-deploy validation.",
      });

      await executeDeploy(
        { service: "app", validateFirst: true, skipPull: true },
        { output: "table" },
      );

      expect(formatters.projectConflictValidationTable).toHaveBeenCalledTimes(2);
      expect(formatters.projectConflictValidationTable).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ status: "passed" }),
      );
      expect(formatters.projectConflictValidationTable).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          status: "inconclusive",
          error: expect.objectContaining({ code: "VALIDATION_INPUT_CHANGED" }),
        }),
      );
      expect(formatters.formatOutput).toHaveBeenCalledTimes(2);
      expect(formatters.formatOutput).toHaveBeenNthCalledWith(
        1,
        "table",
        [{ field: "decision", value: "PASSED" }],
        { columns: ["field", "value"] },
      );
      expect(formatters.formatOutput).toHaveBeenNthCalledWith(
        2,
        "table",
        [{ field: "decision", value: "INCONCLUSIVE" }],
        { columns: ["field", "value"] },
      );
      expect(lib.formatConflictValidationText).not.toHaveBeenCalled();
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
      expect(lib.initializeDatabase).not.toHaveBeenCalled();
    });

    it("uses the common passing gate before the parallel execution path", async () => {
      vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
        services: ["app", "db"],
        profiles: ["core"],
        preSidecarCount: 2,
        sidecarsExpanded: false,
      });
      const outcome = validationOutcome();
      vi.mocked(deployValidation.runDeployValidation).mockResolvedValue({
        ...outcome,
        canonicalCompose: {
          ...outcome.canonicalCompose,
          services: {
            app: {
              name: "app",
              depends_on: ["db"],
              ports: [],
              volumes: [],
              networks: [],
            },
            db: {
              name: "db",
              depends_on: [],
              ports: [],
              volumes: [],
              networks: [],
            },
          },
        },
        effectiveServices: ["app", "db"],
        result: {
          ...outcome.result,
          scope: { ...outcome.result.scope, services: ["app", "db"] },
        },
      });
      vi.mocked(lib.executeParallelPhases).mockResolvedValue({
        phases: [],
        totalServices: 2,
        succeeded: ["app", "db"],
        failed: [],
      });
      vi.mocked(lib.inspectContainersWithRetry).mockResolvedValue(new Map());

      await executeDeploy(
        { services: "app,db", validateFirst: true, parallel: true, skipPull: true },
        { yes: true, output: "json" },
      );

      const evidenceOrder = vi.mocked(deployValidation.runDeployValidation).mock
        .invocationCallOrder[0];
      const mutationOrder = vi.mocked(lib.executeParallelPhases).mock.invocationCallOrder[0];
      expect(evidenceOrder).toBeDefined();
      expect(mutationOrder).toBeDefined();
      expect(evidenceOrder).toBeLessThan(mutationOrder as number);
      expect(lib.executeParallelPhases).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "start",
          composePath: expect.stringMatching(/compose\.yml$/u),
          phases: expect.any(Array),
          cwd: expect.any(String),
          env: { PATH: "/usr/bin" },
          replaceEnv: true,
          envFile: "/project/.env.local",
          projectName: "rfapps",
        }),
      );
      const startCall = vi
        .mocked(lib.executeParallelPhases)
        .mock.calls.find(([options]) => options.operation === "start");
      expect(startCall?.[0]).not.toHaveProperty("envTool");
      expect(lib.startServices).toHaveBeenCalledWith(
        expect.stringMatching(/compose\.yml$/u),
        ["app", "db"],
        expect.objectContaining({
          cwd: startCall?.[0].cwd,
          env: { PATH: "/usr/bin" },
          replaceEnv: true,
          envFile: "/project/.env.local",
          projectName: "rfapps",
        }),
      );
      expect(lib.inspectContainersWithRetry).toHaveBeenCalledWith(["app", "db"], 3, 1000, {
        cwd: startCall?.[0].cwd,
        env: { PATH: "/usr/bin" },
        replaceEnv: true,
        envFile: "/project/.env.local",
        projectName: "rfapps",
      });
    });
  });

  describe("parallel mode", () => {
    const mockPhases = [
      { phase: 0, services: ["svc-a", "svc-b"], dependsOn: [] },
      { phase: 1, services: ["svc-c"], dependsOn: ["svc-a"] },
    ];

    const mockGraph = {
      phases: mockPhases,
      hasCycles: false,
    };

    const mockParallelResult = {
      phases: [
        { phase: 0, services: ["svc-a", "svc-b"], succeeded: ["svc-a", "svc-b"], failed: [] },
      ],
      totalServices: 2,
      succeeded: ["svc-a", "svc-b"],
      failed: [],
    };

    beforeEach(() => {
      // Resolve to multiple services so parallel path has something to work with
      vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
        services: ["svc-a", "svc-b", "svc-c"],
        profiles: ["core"],
        preSidecarCount: 3,
        sidecarsExpanded: false,
      });

      // Default parallel mocks
      vi.mocked(lib.computeExecutionPhases).mockResolvedValue(mockGraph);
      vi.mocked(lib.executeParallelPhases).mockResolvedValue(mockParallelResult);
      vi.mocked(lib.formatExecutionPlan).mockReturnValue(
        "Parallel Execution Plan (workers: 4)\n  Phase 0: 2 services",
      );
      vi.mocked(lib.inspectContainersWithRetry).mockResolvedValue(
        new Map([
          ["svc-a", "svc-a:latest"],
          ["svc-b", "svc-b:latest"],
          ["svc-c", "svc-c:latest"],
        ]),
      );
    });

    it("enables parallel mode when --parallel flag is passed", async () => {
      await executeDeploy({ service: "svc-a", parallel: true }, { yes: true, output: "json" });

      expect(lib.computeExecutionPhases).toHaveBeenCalled();
      expect(lib.executeParallelPhases).toHaveBeenCalled();
    });

    it("uses --workers override when provided", async () => {
      await executeDeploy(
        { service: "svc-a", parallel: true, workers: 8 },
        { yes: true, output: "json" },
      );

      expect(lib.executeParallelPhases).toHaveBeenCalledWith(
        expect.objectContaining({ workers: 8 }),
      );
    });

    it("uses config defaults when CLI flags are not provided", async () => {
      const parallelConfig = {
        ...mockConfig,
        parallel: { enabled: true, workers: 6 },
      };
      vi.mocked(lib.loadConfig).mockResolvedValue(parallelConfig as any);
      vi.mocked(lib.applyCliOverrides).mockReturnValue(parallelConfig as any);

      await executeDeploy({ service: "svc-a" }, { yes: true, output: "json" });

      expect(lib.computeExecutionPhases).toHaveBeenCalled();
      expect(lib.executeParallelPhases).toHaveBeenCalledWith(
        expect.objectContaining({ workers: 6 }),
      );
    });

    it("calls executeParallelPhases with pull then start operations in order", async () => {
      const callOrder: string[] = [];
      vi.mocked(lib.executeParallelPhases).mockImplementation(async (opts) => {
        callOrder.push(opts.operation);
        return mockParallelResult;
      });

      await executeDeploy({ service: "svc-a", parallel: true }, { yes: true, output: "json" });

      expect(callOrder).toEqual(["pull", "start"]);
      expect(lib.executeParallelPhases).toHaveBeenCalledWith(
        expect.objectContaining({
          phases: mockGraph.phases,
          operation: "pull",
        }),
      );
      expect(lib.executeParallelPhases).toHaveBeenCalledWith(
        expect.objectContaining({
          phases: mockGraph.phases,
          operation: "start",
        }),
      );
    });

    it("sets operational error exit code for mixed parallel failures by default", async () => {
      const failedResult = {
        phases: [
          {
            phase: 0,
            services: ["svc-a", "svc-b"],
            succeeded: ["svc-a"],
            failed: [{ name: "svc-b", error: "start failed" }],
          },
        ],
        totalServices: 2,
        succeeded: ["svc-a"],
        failed: [{ name: "svc-b", error: "start failed" }],
      };

      // Pull succeeds, start has partial failure
      vi.mocked(lib.executeParallelPhases)
        .mockResolvedValueOnce(mockParallelResult) // pull succeeds
        .mockResolvedValueOnce(failedResult); // start has failure

      await executeDeploy({ service: "svc-a", parallel: true }, { yes: true, output: "json" });

      expect(process.exitCode).toBe(ExitCode.OperationalError);
      expect(common.outputFormattedError).toHaveBeenCalled();
    });

    it("sets partial success exit code for mixed parallel failures when allowPartial is true", async () => {
      const failedResult = {
        phases: [
          {
            phase: 0,
            services: ["svc-a", "svc-b"],
            succeeded: ["svc-a"],
            failed: [{ name: "svc-b", error: "start failed" }],
          },
        ],
        totalServices: 2,
        succeeded: ["svc-a"],
        failed: [{ name: "svc-b", error: "start failed" }],
      };

      vi.mocked(lib.executeParallelPhases)
        .mockResolvedValueOnce(mockParallelResult)
        .mockResolvedValueOnce(failedResult);

      await executeDeploy(
        { service: "svc-a", parallel: true, allowPartial: true },
        { yes: true, output: "json" },
      );

      expect(process.exitCode).toBe(ExitCode.PartialSuccess);
      expect(common.outputFormattedError).toHaveBeenCalled();
    });

    it("keeps operational error exit code when all parallel services fail with allowPartial", async () => {
      const failedResult = {
        phases: [
          {
            phase: 0,
            services: ["svc-a", "svc-b"],
            succeeded: [],
            failed: [
              { name: "svc-a", error: "start failed" },
              { name: "svc-b", error: "start failed" },
            ],
          },
        ],
        totalServices: 2,
        succeeded: [],
        failed: [
          { name: "svc-a", error: "start failed" },
          { name: "svc-b", error: "start failed" },
        ],
      };

      vi.mocked(lib.executeParallelPhases)
        .mockResolvedValueOnce(mockParallelResult)
        .mockResolvedValueOnce(failedResult);

      await executeDeploy(
        { service: "svc-a", parallel: true, allowPartial: true },
        { yes: true, output: "json" },
      );

      expect(process.exitCode).toBe(ExitCode.OperationalError);
      expect(common.outputFormattedError).toHaveBeenCalledTimes(2);
      expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
    });

    it("displays execution plan in dry-run mode", async () => {
      await executeDeploy({ service: "svc-a", parallel: true }, { yes: true, dryRun: true });

      expect(lib.computeExecutionPhases).toHaveBeenCalled();
      expect(lib.formatExecutionPlan).toHaveBeenCalledWith(mockGraph.phases, 4);
      expect(common.logInfo).toHaveBeenCalled();
      // Should NOT call executeParallelPhases in dry-run
      expect(lib.executeParallelPhases).not.toHaveBeenCalled();
    });

    it("formats error and returns early when cycle is detected", async () => {
      vi.mocked(lib.computeExecutionPhases).mockResolvedValue({
        phases: [],
        hasCycles: true,
        cycleServices: ["svc-x", "svc-y"],
      });

      await executeDeploy({ service: "svc-a", parallel: true }, { yes: true, output: "json" });

      expect(common.formatError).toHaveBeenCalled();
      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      // Should NOT proceed to execute phases
      expect(lib.executeParallelPhases).not.toHaveBeenCalled();
    });

    it("uses sequential path when --parallel is not set", async () => {
      vi.mocked(lib.pullImages).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });

      await executeDeploy({ service: "svc-a" }, { yes: true, output: "json" });

      // Sequential path uses pullImages and startServices directly
      expect(lib.pullImages).toHaveBeenCalled();
      expect(lib.startServices).toHaveBeenCalled();
      // Parallel functions should NOT be called
      expect(lib.computeExecutionPhases).not.toHaveBeenCalled();
      expect(lib.executeParallelPhases).not.toHaveBeenCalled();
    });

    it("propagates forceRecreate to parallel executor when sidecars are expanded", async () => {
      vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
        services: ["plex", "plex-ts"],
        profiles: ["core"],
        preSidecarCount: 1,
        sidecarsExpanded: true,
      });

      await executeDeploy({ service: "plex", parallel: true }, { yes: true, output: "json" });

      // The start operation should have forceRecreate: true
      const startCall = vi
        .mocked(lib.executeParallelPhases)
        .mock.calls.find((call) => call[0].operation === "start");
      expect(startCall).toBeDefined();
      expect(startCall![0].forceRecreate).toBe(true);
    });
  });

  describe("staged mode", () => {
    const stagedServices = ["svc-a", "svc-b", "svc-c", "svc-d"];

    const stagedPhases = [
      { phase: 0, services: ["svc-a", "svc-b"], dependsOn: [] },
      { phase: 1, services: ["svc-c", "svc-d"], dependsOn: ["svc-a"] },
    ];

    const stagedGraph = {
      phases: stagedPhases,
      hasCycles: false,
    };

    function stagedReport(overrides: Partial<StagedRolloutReport>): StagedRolloutReport {
      return {
        status: "completed",
        batchSize: 1,
        onFailure: "halt",
        totalBatches: 4,
        completedBatches: 4,
        batches: [],
        attempted: [...stagedServices],
        started: 4,
        healthy: [...stagedServices],
        unhealthy: [],
        failed: [],
        ...overrides,
      };
    }

    function notAttempted(name: string, haltedAtBatch: number): FailedOperation {
      return {
        name,
        code: "STAGE_NOT_ATTEMPTED",
        error: `Not attempted: staged rollout halted after batch ${haltedAtBatch} of 4`,
      };
    }

    beforeEach(() => {
      vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
        services: [...stagedServices],
        profiles: ["core"],
        preSidecarCount: 4,
        sidecarsExpanded: false,
      });
      vi.mocked(lib.computeExecutionPhases).mockResolvedValue(stagedGraph);
      vi.mocked(lib.executeParallelPhases).mockResolvedValue({
        phases: [],
        totalServices: 4,
        succeeded: [...stagedServices],
        failed: [],
      });
      vi.mocked(lib.formatExecutionPlan).mockReturnValue("Parallel Execution Plan (workers: 4)");
      vi.mocked(lib.inspectContainersWithRetry).mockResolvedValue(
        new Map(stagedServices.map((service) => [service, `${service}:latest`])),
      );
      vi.mocked(lib.formatStagedPlan).mockReturnValue("Staged rollout: 4 batches");
      vi.mocked(lib.formatStagedEvent).mockReturnValue({ level: "info", message: "" });
      vi.mocked(lib.formatStagedSummary).mockReturnValue([]);
      vi.mocked(lib.stagedExceedsLockStaleness).mockReturnValue(false);
      vi.mocked(lib.summarizeStagedRollout).mockReturnValue({
        status: "halted",
        batchSize: 1,
        onFailure: "halt",
        totalBatches: 4,
        completedBatches: 1,
        haltedAtBatch: 2,
      });
    });

    // Regression: the staged branch is guarded by `services.length > 0`, and an
    // unresolved target resolves to the EMPTY "all services" sentinel. Without
    // this gate `rfapps deploy --staged --yes` silently performed an ordinary
    // unstaged fleet deploy and exited 0 -- a safety flag that did nothing.
    it("rejects --staged as a usage error when no explicit service target resolves", async () => {
      vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
        services: [],
        profiles: ["core"],
        preSidecarCount: 0,
        sidecarsExpanded: false,
      });

      await expect(executeDeploy({ staged: true }, { yes: true })).rejects.toMatchObject({
        name: "InvalidArgumentError",
        argument: "--staged",
      });

      expect(lib.executeStagedRollout).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
    });

    it.each([
      [false, ExitCode.OperationalError],
      [true, ExitCode.PartialSuccess],
    ] as const)(
      "a halted rollout records never-attempted services and maps to the right exit code (allowPartial: %s)",
      async (allowPartial, expectedExitCode) => {
        vi.mocked(lib.executeStagedRollout).mockResolvedValue(
          stagedReport({
            status: "halted",
            completedBatches: 1,
            haltedAtBatch: 2,
            attempted: ["svc-a", "svc-b"],
            started: 2,
            healthy: ["svc-a"],
            unhealthy: ["svc-b"],
            failed: [
              {
                name: "svc-b",
                code: "STAGE_GATE_FAILED",
                error: "Batch 2 failed (gate-timeout): not-running",
              },
              notAttempted("svc-c", 2),
              notAttempted("svc-d", 2),
            ],
          }),
        );

        await executeDeploy(
          { service: "svc-a", staged: true, allowPartial },
          { yes: true, output: "json" },
        );

        const payload = vi.mocked(formatters.formatOutput).mock.calls.at(-1)?.[1] as {
          failed: FailedOperation[];
          healthy: string[];
          unhealthy: string[];
        };
        expect(payload.failed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "svc-c", code: "STAGE_NOT_ATTEMPTED" }),
            expect.objectContaining({ name: "svc-d", code: "STAGE_NOT_ATTEMPTED" }),
          ]),
        );
        expect(payload.unhealthy).toEqual(["svc-b"]);
        expect(process.exitCode).toBe(expectedExitCode);
        // Never-attempted services are recorded but never rendered as Docker failures.
        expect(common.outputFormattedError).toHaveBeenCalledTimes(1);
        // A halt must not pay a second full health timeout on the tail gate.
        expect(lib.waitForDependencyReadiness).not.toHaveBeenCalled();
      },
    );

    it("keeps the operational error exit code when the canary halts with no healthy service", async () => {
      vi.mocked(lib.executeStagedRollout).mockResolvedValue(
        stagedReport({
          status: "halted",
          completedBatches: 0,
          haltedAtBatch: 1,
          attempted: ["svc-a"],
          started: 1,
          healthy: [],
          unhealthy: ["svc-a"],
          failed: [
            {
              name: "svc-a",
              code: "STAGE_GATE_FAILED",
              error: "Batch 1 failed (gate-unready): exited",
            },
            notAttempted("svc-b", 1),
            notAttempted("svc-c", 1),
            notAttempted("svc-d", 1),
          ],
        }),
      );

      await executeDeploy(
        { service: "svc-a", staged: true, allowPartial: true },
        { yes: true, output: "json" },
      );

      const payload = vi.mocked(formatters.formatOutput).mock.calls.at(-1)?.[1] as {
        failed: FailedOperation[];
      };
      expect(payload.failed.filter((entry) => entry.code === "STAGE_NOT_ATTEMPTED")).toHaveLength(
        3,
      );
      expect(process.exitCode).toBe(ExitCode.OperationalError);
    });

    it("scopes orphan cleanup to attempted services and skips it entirely on halt", async () => {
      vi.mocked(lib.executeStagedRollout).mockResolvedValue(
        stagedReport({
          status: "halted",
          completedBatches: 0,
          haltedAtBatch: 1,
          attempted: ["svc-a"],
          started: 1,
          healthy: [],
          unhealthy: ["svc-a"],
          failed: [
            {
              name: "svc-a",
              code: "STAGE_GATE_FAILED",
              error: "Batch 1 failed (gate-unready): exited",
            },
            notAttempted("svc-b", 1),
            notAttempted("svc-c", 1),
            notAttempted("svc-d", 1),
          ],
        }),
      );

      await executeDeploy({ service: "svc-a", staged: true }, { yes: true, output: "json" });

      // `up -d --remove-orphans` here would start exactly the services the halt protected.
      expect(lib.startServices).not.toHaveBeenCalled();

      vi.clearAllMocks();
      vi.mocked(lib.executeStagedRollout).mockResolvedValue(
        stagedReport({
          status: "completed",
          completedBatches: 2,
          totalBatches: 2,
          attempted: ["svc-a", "svc-b"],
          started: 2,
          healthy: ["svc-a", "svc-b"],
        }),
      );

      await executeDeploy({ service: "svc-a", staged: true }, { yes: true, output: "json" });

      expect(lib.startServices).toHaveBeenCalledTimes(1);
      expect(lib.startServices).toHaveBeenCalledWith(
        expect.any(String),
        ["svc-a", "svc-b"],
        expect.objectContaining({ streamOutput: false }),
      );
    });
  });

  describe("--scan", () => {
    const scanSettings: ResolvedScanSettings = {
      scanner: "trivy",
      failOn: "high",
      ignore: [],
      timeoutMs: 180_000,
      maxTargets: 64,
      concurrency: 2,
      cwd: "/project",
    };

    function blockingScanReport(): ScanReport {
      return {
        schemaVersion: SCAN_SCHEMA_VERSION,
        timestamp: "2026-07-30T18:00:00.000Z",
        scanner: { id: "trivy", binary: "trivy", version: "0.58.1", available: true },
        scope: { services: ["app"], profiles: ["core"], composePath: "compose.yml" },
        gate: {
          failOn: "high",
          status: "blocked",
          blocking: true,
          blockedBy: ["app: CVE-2024-45490 (critical) in expat@2.5.0"],
        },
        summary: {
          critical: 1,
          high: 0,
          medium: 0,
          low: 0,
          negligible: 0,
          unknown: 0,
          total: 1,
          suppressed: 0,
          targetsScanned: 1,
          targetsSkipped: 0,
          targetsFailed: 0,
        },
        images: [
          {
            status: "scanned",
            service: "app",
            image: "app:latest",
            counts: { critical: 1, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 },
            vulnerabilities: [
              {
                id: "CVE-2024-45490",
                severity: "critical",
                rawSeverity: "CRITICAL",
                packageName: "expat",
                installedVersion: "2.5.0",
                fixedVersion: "2.6.3",
              },
            ],
            suppressed: 0,
            truncated: false,
            durationMs: 10,
          },
        ],
        notes: [],
      };
    }

    beforeEach(() => {
      // `vi.mock("../lib/index.js")` is a bare automock, so every scan helper
      // resolves `undefined` unless it is driven here.
      vi.mocked(lib.getComposeConfig).mockResolvedValue({
        services: { app: { name: "app", image: "app:latest" } },
      });
      vi.mocked(lib.resolveScanSettings).mockReturnValue(scanSettings);
      vi.mocked(lib.resolveScanTargets).mockReturnValue({
        targets: [{ service: "app", image: "app:latest" }],
        skipped: [],
      });
      vi.mocked(lib.runSecurityScan).mockResolvedValue(blockingScanReport());
      vi.mocked(lib.formatScanText).mockReturnValue(["Image Vulnerability Scan"]);
    });

    it("refuses the deploy before any mutation when the gate blocks", async () => {
      await executeDeploy({ service: "app", scan: true }, { yes: true, output: "json" });

      expect(lib.runSecurityScan).toHaveBeenCalledTimes(1);
      expect(formatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          failed: [expect.objectContaining({ name: "scan", code: "VULNERABILITY_THRESHOLD" })],
          scan: expect.objectContaining({ gate: expect.objectContaining({ blocking: true }) }),
        }),
      );
      expect(process.exitCode).toBe(ExitCode.OperationalError);
      expect(common.confirm).not.toHaveBeenCalled();
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
      expect(lib.executeStagedRollout).not.toHaveBeenCalled();
      expect(lib.initializeDatabase).not.toHaveBeenCalled();
    });

    it("reports a would-block gate under --dry-run and still exits zero", async () => {
      await executeDeploy(
        { service: "app", scan: true },
        { yes: true, dryRun: true, output: "json" },
      );

      expect(lib.runSecurityScan).toHaveBeenCalledTimes(1);
      expect(common.logInfo).toHaveBeenCalledWith("would block deploy (--scan-fail-on high)");
      expect(formatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          dryRun: true,
          scan: expect.objectContaining({ gate: expect.objectContaining({ blocking: true }) }),
        }),
      );
      expect(process.exitCode).toBeUndefined();
      expect(lib.pullImages).not.toHaveBeenCalled();
      expect(lib.startServices).not.toHaveBeenCalled();
    });
  });
});
