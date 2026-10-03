import { describe, expect, it, vi } from "vitest";

import type { DockerContainerIdentity, RecreateServiceWithImageResult } from "./docker.js";
import type { ServiceVerificationSummary } from "../types/health.js";
import type { DeploymentPlan, ImageUpdateStatus, ServiceChange } from "../types/plan.js";
import type { GenerationEntry } from "../types/state.js";
import {
  MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
  type ManagedUpdatePlan,
  type ManagedUpdatePlanService,
} from "../types/update.js";
import {
  environmentSourceFingerprint,
  generateManagedUpdatePlan,
  runManagedUpdate,
  type ManagedUpdateDependencies,
} from "./managed-update.js";

const OLD_ID = `sha256:${"1".repeat(64)}`;
const NEW_ID = `sha256:${"2".repeat(64)}`;
const OLD_DIGEST = `docker.io/library/example@sha256:${"3".repeat(64)}`;
const NEW_DIGEST = `docker.io/library/example@sha256:${"4".repeat(64)}`;
const LATER_DIGEST = `docker.io/library/example@sha256:${"5".repeat(64)}`;
const CONFIG_FINGERPRINT = "a".repeat(64);
const ENV_SOURCE_FINGERPRINT = environmentSourceFingerprint();

function change(service: string, status: ImageUpdateStatus = "update-available"): ServiceChange {
  return {
    service,
    resolvedConfigFingerprint: CONFIG_FINGERPRINT,
    changeType: "unchanged",
    image: {
      current: "example:latest",
      desired: "example:latest",
      changed: false,
      updateStatus: status,
      updateAvailable: status === "update-available",
      canonicalImage: "docker.io/library/example:latest",
      platform: "linux/amd64",
      localDigest: OLD_DIGEST,
      remoteDigest:
        status === "update-available" || status === "up-to-date" ? NEW_DIGEST : undefined,
      ...(status === "unknown"
        ? { errorCode: "registry-timeout", updateError: "Registry lookup timed out" }
        : {}),
    },
    environment: [],
    ports: { changed: false },
    volumes: { changed: false },
    networks: { changed: false },
  };
}

function deploymentPlan(changes: ServiceChange[]): DeploymentPlan {
  return {
    id: "plan-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    composeHash: "",
    composePath: "/project/compose.yml",
    targetServices: changes.map((item) => item.service),
    profiles: ["all"],
    services: changes,
    summary: {
      toCreate: 0,
      toUpdate: 0,
      toRecreate: 0,
      toDelete: 0,
      unchanged: changes.length,
      updatesAvailable: changes.filter((item) => item.image.updateStatus === "update-available")
        .length,
      total: changes.length,
    },
  };
}

function planService(
  service: string,
  overrides: Partial<ManagedUpdatePlanService> = {},
): ManagedUpdatePlanService {
  return {
    service,
    resolvedConfigFingerprint: CONFIG_FINGERPRINT,
    status: "update-available",
    configuredImage: "example:latest",
    platform: "linux/amd64",
    currentImageId: OLD_ID,
    currentDigest: OLD_DIGEST,
    proposedDigest: NEW_DIGEST,
    recoveryEligible: true,
    verification: "healthcheck",
    ...overrides,
  };
}

function managedPlan(
  services: ManagedUpdatePlanService[],
  overrides: Partial<ManagedUpdatePlan> = {},
): ManagedUpdatePlan {
  return {
    schemaVersion: MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
    intent: "managed-update",
    id: "plan-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    composeHash: "compose-hash",
    composePath: "/project/compose.yml",
    dockerContextFingerprint: "context-1",
    envSourceFingerprint: ENV_SOURCE_FINGERPRINT,
    composeProjectName: "project",
    targetServices: services.map((service) => service.service),
    profiles: ["all"],
    applyPolicy: "sequential",
    restorePolicy: "restore-on-failure",
    services,
    ...overrides,
  };
}

function identity(localImageId = OLD_ID): DockerContainerIdentity {
  return {
    localImageId,
    configuredImage: "example:latest",
    repositoryDigest: localImageId === OLD_ID ? OLD_DIGEST : NEW_DIGEST,
    platform: "linux/amd64",
    containerId: `container-${localImageId.slice(-4)}`,
    state: "running",
    exitCode: 0,
    health: "healthy",
  };
}

function verification(ready: boolean, expectedImageId: string): ServiceVerificationSummary {
  return {
    service: "service",
    expectedImageId,
    ready,
    timedOut: !ready,
    assurance: "healthcheck",
    target: {
      imageId: expectedImageId,
      state: "running",
      exitCode: 0,
      health: ready ? "healthy" : "unhealthy",
      status: ready ? "ready" : "failed",
      imageMatches: true,
      assurance: "healthcheck",
      stableForMs: 0,
      reason: ready ? "ready" : "health-unhealthy",
    },
    dependencies: {
      ready: true,
      timedOut: false,
      totalDependencies: 0,
      readyDependencies: [],
      pendingDependencies: [],
      failedDependencies: [],
      elapsedMs: 1,
      attempts: 1,
      services: [],
      signalAvailability: { available: true, unavailableSignals: [] },
    },
    elapsedMs: 1,
    attempts: 1,
  };
}

function generation(service: string, generationNumber = 1): GenerationEntry {
  return {
    id: generationNumber,
    service,
    generation: generationNumber,
    timestamp: "2026-07-17T00:00:00.000Z",
    imageTag: "example:latest",
    imageId: OLD_ID,
    imageDigest: OLD_DIGEST,
    createdByAction: "update",
  };
}

function successfulRecreate(imageId = NEW_ID): RecreateServiceWithImageResult {
  return {
    success: true,
    command: { success: true, code: 0, stdout: "", stderr: "" },
    identity: identity(imageId),
  };
}

function createHarness(changes: ServiceChange[] = [change("one")]) {
  let generationCount = 0;
  let currentInterruption: "SIGINT" | "SIGTERM" | undefined;
  const release = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const filesystemCleanup = vi.fn(async () => undefined);
  const dependencies: ManagedUpdateDependencies = {
    plan: {
      resolveComposeProjectName: vi.fn(async () => "project"),
      generatePlan: vi.fn(async () => deploymentPlan(changes)),
    },
    docker: {
      getContextFingerprint: vi.fn(async () => "context-1"),
      inspectServiceIdentity: vi.fn(async () => identity()),
      recreateServiceWithImage: vi.fn(async (input) =>
        successfulRecreate(input.source.kind === "local-image-id" ? OLD_ID : NEW_ID),
      ),
    },
    state: {
      findRecoveryGeneration: vi.fn(async (service) => generation(service)),
      findGeneration: vi.fn(async (service, number) => generation(service, number)),
      createGeneration: vi.fn(async () => {
        generationCount += 1;
        return generationCount;
      }),
      recordDeployment: vi.fn(async (entry) => {
        if (entry.status === "success") generationCount += 1;
        return generationCount;
      }),
      getGenerationCount: vi.fn(async () => generationCount),
      close,
    },
    health: {
      verifyServiceReadiness: vi.fn(async (input) => verification(true, input.expectedImageId)),
    },
    clock: {
      now: vi.fn(() => new Date("2026-07-17T00:00:00.000Z")),
      randomId: vi.fn(() => "run-1"),
    },
    lock: {
      acquire: vi.fn(async (options) => ({
        path: "/state/lock",
        owner: {
          pid: 1,
          startedAt: "2026-07-17T00:00:00.000Z",
          projectPath: options.projectPath,
          dockerContext: options.dockerContext,
        },
        release,
      })),
    },
    signal: {
      getInterruption: vi.fn(() => currentInterruption),
    },
    filesystem: {
      hashFile: vi.fn(async () => "compose-hash"),
      cleanup: filesystemCleanup,
    },
  };
  return {
    dependencies,
    release,
    close,
    filesystemCleanup,
    interrupt(signal: "SIGINT" | "SIGTERM") {
      currentInterruption = signal;
    },
  };
}

const runOptions = {
  healthPoll: { timeoutSeconds: 1, intervalSeconds: 0, retries: 1 },
};

describe("generateManagedUpdatePlan", () => {
  it("keeps preview immutable while returning reviewed recovery evidence", async () => {
    const harness = createHarness();
    const plan = await generateManagedUpdatePlan(
      {
        composePath: "/project/compose.yml",
        targetServices: ["one"],
        profiles: ["all"],
        restorePolicy: "restore-on-failure",
      },
      harness.dependencies,
    );

    expect(plan).toMatchObject({
      schemaVersion: "update-plan.v1",
      composeHash: "compose-hash",
      dockerContextFingerprint: "context-1",
      envSourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      composeProjectName: "project",
      services: [
        {
          service: "one",
          resolvedConfigFingerprint: CONFIG_FINGERPRINT,
          currentImageId: OLD_ID,
          recoveryEligible: true,
        },
      ],
    });
    expect(harness.dependencies.lock.acquire).not.toHaveBeenCalled();
    expect(harness.dependencies.docker.recreateServiceWithImage).not.toHaveBeenCalled();
    expect(harness.dependencies.state.createGeneration).not.toHaveBeenCalled();
    expect(harness.dependencies.state.recordDeployment).not.toHaveBeenCalled();
  });
});

describe("runManagedUpdate", () => {
  it("returns a clean no-op without acquiring the mutation lock", async () => {
    const service = planService("one", {
      status: "up-to-date",
      proposedDigest: OLD_DIGEST,
    });
    const harness = createHarness([change("one", "up-to-date")]);

    const result = await runManagedUpdate(managedPlan([service]), runOptions, harness.dependencies);

    expect(result).toMatchObject({
      status: "no_updates",
      success: true,
      applied: false,
      exitCode: 0,
    });
    expect(result.services[0]?.outcome).toBe("up_to_date");
    expect(harness.dependencies.lock.acquire).not.toHaveBeenCalled();
  });

  it("keeps mixed unknown detection visible and aggregate-non-successful", async () => {
    const services = [
      planService("one"),
      planService("unknown", {
        status: "unknown",
        recoveryEligible: false,
        errorCode: "registry-timeout",
        message: "Registry lookup timed out",
      }),
    ];
    const harness = createHarness([change("one"), change("unknown", "unknown")]);

    const result = await runManagedUpdate(managedPlan(services), runOptions, harness.dependencies);

    expect(result.status).toBe("partial");
    expect(result.success).toBe(false);
    expect(result.services.map((service) => service.outcome)).toEqual([
      "updated",
      "detection_unknown",
    ]);
  });

  it("blocks all mutation when Compose identity drifts and releases resources", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.filesystem.hashFile).mockResolvedValue("changed-hash");

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({ outcome: "blocked", error: { kind: "drift" } });
    expect(harness.dependencies.docker.recreateServiceWithImage).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.dependencies.state.close).toHaveBeenCalledOnce();
    expect(harness.dependencies.filesystem.cleanup).toHaveBeenCalledOnce();
  });

  it("blocks all mutation when the selected environment source differs from approval", async () => {
    const harness = createHarness();
    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      {
        ...runOptions,
        envTool: { tool: "dotenvx", envFile: "/different/runtime.env" },
      },
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "env-source" } },
    });
    expect(harness.dependencies.docker.recreateServiceWithImage).not.toHaveBeenCalled();
  });

  it("blocks all mutation when the effective Compose project name differs from approval", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.plan.resolveComposeProjectName).mockResolvedValue(
      "other-project",
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "compose-project" } },
    });
    expect(harness.dependencies.lock.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ composeProjectName: "project" }),
    );
    expect(harness.dependencies.docker.recreateServiceWithImage).not.toHaveBeenCalled();
  });

  it("blocks globally when the resolved mutation-relevant service config changes", async () => {
    const harness = createHarness([
      { ...change("one"), resolvedConfigFingerprint: "c".repeat(64) },
    ]);

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "resolved-config" } },
    });
    expect(harness.dependencies.docker.recreateServiceWithImage).not.toHaveBeenCalled();
  });

  it("rechecks resolved config immediately before each service mutation", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.plan.generatePlan)
      .mockResolvedValueOnce(deploymentPlan([change("one"), change("two")]))
      .mockResolvedValueOnce(deploymentPlan([change("one")]))
      .mockResolvedValueOnce(
        deploymentPlan([{ ...change("two"), resolvedConfigFingerprint: "d".repeat(64) }]),
      );

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]?.outcome).toBe("updated");
    expect(result.services[1]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "resolved-config" } },
    });
    expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
  });

  it("rechecks the effective Compose project name immediately before each mutation", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.plan.resolveComposeProjectName)
      .mockResolvedValueOnce("project")
      .mockResolvedValueOnce("project")
      .mockResolvedValueOnce("other-project");

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]?.outcome).toBe("updated");
    expect(result.services[1]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "compose-project" } },
    });
    expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
  });

  it("hard-blocks a missing exact recovery ID under the default policy", async () => {
    const service = planService("one", {
      currentImageId: undefined,
      recoveryEligible: false,
    });
    const harness = createHarness();
    vi.mocked(harness.dependencies.docker.inspectServiceIdentity).mockResolvedValue(undefined);

    const result = await runManagedUpdate(managedPlan([service]), runOptions, harness.dependencies);

    expect(result.services[0]).toMatchObject({
      outcome: "blocked",
      error: { code: "RECOVERY_IMAGE_REQUIRED" },
    });
    expect(harness.dependencies.state.createGeneration).not.toHaveBeenCalled();
  });

  it("allows explicit reduced-safety update without a recovery identity", async () => {
    const service = planService("one", {
      currentImageId: undefined,
      recoveryEligible: false,
    });
    const harness = createHarness();
    vi.mocked(harness.dependencies.docker.inspectServiceIdentity).mockResolvedValue(undefined);

    const result = await runManagedUpdate(
      managedPlan([service], { restorePolicy: "no-restore-on-failure" }),
      runOptions,
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "succeeded", success: true, restoreOnFailure: false });
    expect(result.services[0]?.outcome).toBe("updated");
  });

  it("updates multiple services strictly in plan order", async () => {
    const harness = createHarness([change("one"), change("two")]);
    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      { ...runOptions, projectDir: "/canonical/project" },
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "succeeded", success: true, applied: true });
    expect(result.services.map((service) => service.outcome)).toEqual(["updated", "updated"]);
    expect(
      vi
        .mocked(harness.dependencies.docker.recreateServiceWithImage)
        .mock.calls.map(([input]) => input.service),
    ).toEqual(["one", "two"]);
    expect(
      vi
        .mocked(harness.dependencies.health.verifyServiceReadiness)
        .mock.calls.every(([input]) => input.projectDir === "/canonical/project"),
    ).toBe(true);
    expect(
      vi
        .mocked(harness.dependencies.health.verifyServiceReadiness)
        .mock.calls.every(([input]) => input.projectName === "project"),
    ).toBe(true);
    expect(
      vi
        .mocked(harness.dependencies.docker.recreateServiceWithImage)
        .mock.calls.every(([input]) => input.projectName === "project"),
    ).toBe(true);
    expect(
      vi
        .mocked(harness.dependencies.health.verifyServiceReadiness)
        .mock.calls.every(([input]) => input.tcpProbeMode === "state-and-health-only"),
    ).toBe(true);
  });

  it("restores the exact local ID, continues, and retains aggregate failure", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.health.verifyServiceReadiness)
      .mockResolvedValueOnce(verification(false, NEW_ID))
      .mockResolvedValueOnce(verification(true, OLD_ID))
      .mockResolvedValueOnce(verification(true, NEW_ID));

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      runOptions,
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "recovered_failure", success: false, exitCode: 1 });
    expect(result.services.map((service) => service.outcome)).toEqual(["restored", "updated"]);
    expect(
      vi
        .mocked(harness.dependencies.docker.recreateServiceWithImage)
        .mock.calls.map(([input]) => input.source),
    ).toEqual([
      expect.objectContaining({ kind: "repository-digest", repositoryDigest: NEW_DIGEST }),
      expect.objectContaining({ kind: "local-image-id", localImageId: OLD_ID }),
      expect.objectContaining({ kind: "repository-digest", repositoryDigest: NEW_DIGEST }),
    ]);
  });

  it("stops with the failed updated service when restore is disabled", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.health.verifyServiceReadiness).mockResolvedValueOnce(
      verification(false, NEW_ID),
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")], {
        restorePolicy: "no-restore-on-failure",
      }),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "update_failed",
      restore: { status: "disabled" },
    });
    expect(result.services[1]?.outcome).toBe("blocked");
    expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
  });

  it("stops later services after exact restore recreation fails", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.health.verifyServiceReadiness).mockResolvedValueOnce(
      verification(false, NEW_ID),
    );
    vi.mocked(harness.dependencies.docker.recreateServiceWithImage)
      .mockResolvedValueOnce(successfulRecreate())
      .mockResolvedValueOnce({
        success: false,
        stage: "recreate",
        command: { success: false, code: 1, stdout: "", stderr: "bounded" },
      });

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]?.outcome).toBe("restore_failed");
    expect(result.services[1]?.outcome).toBe("blocked");
  });

  it("restores when recreation rejects with an uncertain post-mutation state", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.docker.recreateServiceWithImage)
      .mockRejectedValueOnce(new Error("temporary override cleanup failed after compose up"))
      .mockResolvedValueOnce(successfulRecreate(OLD_ID));

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result).toMatchObject({ status: "recovered_failure", success: false, applied: true });
    expect(result.services[0]).toMatchObject({
      outcome: "restored",
      verification: { status: "not-run", reasonCode: "UPDATE_RECREATE_EXCEPTION" },
      restore: { status: "succeeded", imageId: OLD_ID },
    });
    expect(
      vi
        .mocked(harness.dependencies.docker.recreateServiceWithImage)
        .mock.calls.map(([input]) => input.source.kind),
    ).toEqual(["repository-digest", "local-image-id"]);
  });

  it("preserves a completed result and exposes redacted cleanup failures", async () => {
    const harness = createHarness();
    harness.release.mockRejectedValueOnce(new Error("Bearer release-canary"));
    harness.close.mockRejectedValueOnce(new Error("password=close-canary"));
    harness.filesystemCleanup.mockRejectedValueOnce(
      new Error("https://user:filesystem-canary@example.test"),
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result).toMatchObject({
      status: "partial",
      success: false,
      exitCode: 1,
      applied: true,
      services: [{ outcome: "updated" }],
      cleanupFailures: [
        { operation: "lock-release", code: "CLEANUP_FAILED" },
        { operation: "state-close", code: "CLEANUP_FAILED" },
        { operation: "filesystem-cleanup", code: "CLEANUP_FAILED" },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/release-canary|close-canary|filesystem-canary/u);
  });

  it("retains recovered failure evidence when cleanup also fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.health.verifyServiceReadiness)
      .mockResolvedValueOnce(verification(false, NEW_ID))
      .mockResolvedValueOnce(verification(true, OLD_ID));
    harness.release.mockRejectedValueOnce(new Error("token=recovery-cleanup-canary"));

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result).toMatchObject({
      status: "recovered_failure",
      success: false,
      services: [{ outcome: "restored" }],
      cleanupFailures: [{ operation: "lock-release", code: "CLEANUP_FAILED" }],
    });
    expect(JSON.stringify(result)).not.toContain("recovery-cleanup-canary");
  });

  it("redacts unexpected errors before machine results and SQLite-bound state entries", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.docker.recreateServiceWithImage).mockRejectedValueOnce(
      new Error(
        "Bearer bearer-canary https://user:url-canary@example.test password=password-canary API key=api-canary DB_PASSWORD=db-canary PLEX_TOKEN=token-canary AWS_SECRET_ACCESS_KEY=aws-canary OPENAI_API_KEY=openai-canary",
      ),
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one")], { restorePolicy: "no-restore-on-failure" }),
      runOptions,
      harness.dependencies,
    );
    const persistedEntries = vi.mocked(harness.dependencies.state.recordDeployment).mock.calls;
    const serialized = JSON.stringify({ result, persistedEntries });

    expect(serialized).not.toMatch(
      /bearer-canary|url-canary|password-canary|api-canary|db-canary|token-canary|aws-canary|openai-canary/u,
    );
    expect(serialized).toContain("[REDACTED]");
    expect(persistedEntries).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ status: "failed", errorMessage: expect.any(String) })],
      ]),
    );
  });

  it("turns update verifier rejection into bounded evidence and exact recovery", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.health.verifyServiceReadiness).mockRejectedValueOnce(
      new Error(`verifier unavailable ${"x".repeat(1_000)}`),
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "restored",
      verification: {
        status: "failed",
        error: { stage: "verify_update", code: "UPDATE_VERIFICATION_ERROR" },
      },
      restore: { status: "succeeded", imageId: OLD_ID },
    });
    const verificationResult = result.services[0]?.verification;
    expect(verificationResult?.status).toBe("failed");
    if (verificationResult?.status === "failed") {
      expect(verificationResult.error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it("classifies ready-target dependency failures without contradictory target evidence", async () => {
    const harness = createHarness();
    const dependencyFailure = verification(true, NEW_ID);
    dependencyFailure.ready = false;
    dependencyFailure.timedOut = true;
    dependencyFailure.dependencies = {
      ...dependencyFailure.dependencies,
      ready: false,
      timedOut: true,
      totalDependencies: 2,
      readyDependencies: [],
      failedDependencies: ["database"],
      pendingDependencies: ["cache"],
    };
    vi.mocked(harness.dependencies.health.verifyServiceReadiness).mockResolvedValueOnce(
      dependencyFailure,
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "restored",
      verification: {
        status: "failed",
        runtimeState: "running",
        dockerHealth: "healthy",
        dependenciesReady: false,
        error: {
          code: "VERIFY_DEPENDENCIES_NOT_READY",
          message: expect.stringContaining("failed=database; pending=cache"),
        },
      },
    });
    const verificationResult = result.services[0]?.verification;
    expect(verificationResult?.status).toBe("failed");
    if (verificationResult?.status === "failed") {
      expect(verificationResult.error.message).not.toContain("failed: ready");
      expect(verificationResult.error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it("returns a terminal restore failure when restore verification rejects", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.health.verifyServiceReadiness)
      .mockResolvedValueOnce(verification(false, NEW_ID))
      .mockRejectedValueOnce(new Error("restore verifier transport closed"));

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "restore_failed",
      stage: "verify_restore",
      error: { code: "RESTORE_VERIFICATION_ERROR" },
      restore: {
        status: "failed",
        verification: {
          status: "failed",
          error: { stage: "verify_restore", code: "RESTORE_VERIFICATION_ERROR" },
        },
      },
    });
  });

  it("revalidates each later service immediately before its mutation", async () => {
    const harness = createHarness([change("one"), change("two")]);
    let planRead = 0;
    vi.mocked(harness.dependencies.plan.generatePlan).mockImplementation(async () => {
      planRead += 1;
      const second = change("two");
      if (planRead === 3) second.image.remoteDigest = LATER_DIGEST;
      return deploymentPlan([change("one"), second]);
    });

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]?.outcome).toBe("updated");
    expect(result.services[1]).toMatchObject({
      outcome: "blocked",
      error: {
        kind: "drift",
        drift: { kind: "proposed-digest", expected: NEW_DIGEST, observed: LATER_DIGEST },
      },
    });
    expect(harness.dependencies.plan.generatePlan).toHaveBeenCalledTimes(3);
    expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
  });

  it("rechecks daemon identity and recovery generation after the prior service mutates", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.docker.inspectServiceIdentity).mockImplementation(
      async (input) => {
        if (input.service === "two") {
          expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
        }
        return identity();
      },
    );
    vi.mocked(harness.dependencies.state.findGeneration).mockImplementation(
      async (service, number) => {
        if (service === "two") {
          expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
          return { ...generation(service, number), imageId: NEW_ID };
        }
        return generation(service, number);
      },
    );

    const result = await runManagedUpdate(
      managedPlan([
        planService("one", { recoveryGeneration: 1 }),
        planService("two", { recoveryGeneration: 1 }),
      ]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]?.outcome).toBe("updated");
    expect(result.services[1]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "recovery-generation", expected: "1" } },
    });
    expect(harness.dependencies.docker.recreateServiceWithImage).toHaveBeenCalledOnce();
  });

  it("fails closed before pull when the durable recovery write fails", async () => {
    const harness = createHarness([change("one"), change("two")]);
    vi.mocked(harness.dependencies.state.createGeneration).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one"), planService("two")]),
      runOptions,
      harness.dependencies,
    );

    expect(result.services[0]).toMatchObject({
      outcome: "update_failed",
      stage: "snapshot",
      error: { code: "RECOVERY_SNAPSHOT_WRITE_FAILED" },
    });
    expect(result.services[1]?.outcome).toBe("blocked");
    expect(harness.dependencies.docker.recreateServiceWithImage).not.toHaveBeenCalled();
  });

  it("stabilizes an interrupted active service by restoring its exact local image", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.docker.recreateServiceWithImage).mockImplementation(
      async (input) => {
        if (input.source.kind === "repository-digest") {
          harness.interrupt("SIGINT");
          return successfulRecreate(NEW_ID);
        }
        return successfulRecreate(OLD_ID);
      },
    );

    const result = await runManagedUpdate(
      managedPlan([planService("one")]),
      runOptions,
      harness.dependencies,
    );

    expect(result).toMatchObject({
      status: "interrupted",
      success: false,
      interruption: { signal: "SIGINT", service: "one", stabilized: true },
    });
    expect(result.services[0]).toMatchObject({
      outcome: "interrupted",
      restore: { status: "succeeded", imageId: OLD_ID },
    });
  });

  it("does not print or change process exit state", async () => {
    const harness = createHarness([change("one", "up-to-date")]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    const service = planService("one", { status: "up-to-date", proposedDigest: OLD_DIGEST });

    await runManagedUpdate(managedPlan([service]), runOptions, harness.dependencies);

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(previousExitCode);
    log.mockRestore();
    error.mockRestore();
  });
});
