import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeApply } from "./actions/apply.js";
import { executeUpdate, type UpdateActionDependencies } from "./actions/update.js";
import { registerUpdateCommand } from "./commands/update.js";
import { applyCliOverrides } from "./lib/config.js";
import { closeDatabase, initializeDatabase, type DbConnection } from "./lib/db.js";
import type {
  DockerContainerIdentity,
  ImmutableImageSource,
  RecreateServiceWithImageInput,
  RecreateServiceWithImageResult,
} from "./lib/docker.js";
import {
  createGeneration,
  findGenerationByNumber,
  getGenerationCount,
  getGenerations,
} from "./lib/generations.js";
import {
  generateManagedUpdatePlan,
  runManagedUpdate,
  type ManagedUpdateDependencies,
} from "./lib/managed-update.js";
import {
  hashFile,
  loadManagedUpdatePlan,
  loadManagedUpdateResult,
  saveManagedUpdatePlan,
  saveManagedUpdateResult,
} from "./lib/plan-storage.js";
import { recordDeployment } from "./lib/state-storage.js";
import { PlanValidationError } from "./lib/errors.js";
import type { RfappsConfig } from "./types/config.js";
import type { ServiceVerificationSummary } from "./types/health.js";
import type { DeploymentPlan, ImageUpdateStatus, ServiceChange } from "./types/plan.js";
import type { ManagedUpdateResult } from "./types/update.js";

const OLD_ID = `sha256:${"1".repeat(64)}`;
const NEW_ID = `sha256:${"2".repeat(64)}`;
const OLD_DIGEST_SUFFIX = `sha256:${"3".repeat(64)}`;
const NEW_DIGEST_SUFFIX = `sha256:${"4".repeat(64)}`;
const CANARY_SECRET = "CANARY_MANAGED_UPDATE_SECRET";

const temporaryRoots: string[] = [];

function oldDigest(service: string): string {
  return `docker.io/library/${service}@${OLD_DIGEST_SUFFIX}`;
}

function newDigest(service: string): string {
  return `docker.io/library/${service}@${NEW_DIGEST_SUFFIX}`;
}

function change(service: string, status: ImageUpdateStatus): ServiceChange {
  return {
    service,
    resolvedConfigFingerprint: "a".repeat(64),
    changeType: "unchanged",
    image: {
      current: `${service}:latest`,
      desired: `${service}:latest`,
      changed: false,
      updateStatus: status,
      updateAvailable: status === "update-available",
      canonicalImage: `docker.io/library/${service}:latest`,
      platform: "linux/amd64",
      localDigest: oldDigest(service),
      ...(status === "update-available" || status === "up-to-date"
        ? { remoteDigest: status === "up-to-date" ? oldDigest(service) : newDigest(service) }
        : {}),
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

function deploymentPlan(statuses: ReadonlyMap<string, ImageUpdateStatus>): DeploymentPlan {
  const changes = [...statuses].map(([service, status]) => change(service, status));
  return {
    id: "integration-plan",
    createdAt: "2026-07-17T00:00:00.000Z",
    composeHash: "",
    composePath: "unused-by-fake-plan",
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

function identity(service: string, imageId = OLD_ID): DockerContainerIdentity {
  return {
    localImageId: imageId,
    configuredImage: `${service}:latest`,
    repositoryDigest: imageId === OLD_ID ? oldDigest(service) : newDigest(service),
    platform: "linux/amd64",
    containerId: `${service}-container`,
    state: "running",
    exitCode: 0,
    health: "healthy",
  };
}

function verification(
  service: string,
  expectedImageId: string,
  ready: boolean,
): ServiceVerificationSummary {
  return {
    service,
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

interface RecordedRecreate {
  service: string;
  projectName?: string;
  source: ImmutableImageSource;
}

interface IntegrationHarness {
  root: string;
  composePath: string;
  databasePath: string;
  config: RfappsConfig;
  statuses: Map<string, ImageUpdateStatus>;
  verificationQueues: Map<string, boolean[]>;
  restoreFailures: Set<string>;
  recreateCalls: RecordedRecreate[];
  dockerArgv: string[][];
  machineDocuments: ManagedUpdateResult[];
  lockCount: number;
  releaseCount: number;
  interruptAfterUpdate?: string;
  actionDependencies: UpdateActionDependencies;
  path(name: string): string;
  generationCount(service?: string): Promise<number>;
}

async function createHarness(
  serviceStatuses: Record<string, ImageUpdateStatus>,
): Promise<IntegrationHarness> {
  const root = await mkdtemp(join(tmpdir(), "rfapps-managed-update-integration-"));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  const composePath = join(root, "compose.yml");
  const databasePath = join(root, "state.db");
  await writeFile(composePath, "services:\n  fixture:\n    image: fixture:latest\n", "utf8");

  const statuses = new Map(Object.entries(serviceStatuses));
  const services = [...statuses.keys()];
  const currentImages = new Map(services.map((service) => [service, OLD_ID]));
  const verificationQueues = new Map<string, boolean[]>();
  const restoreFailures = new Set<string>();
  const recreateCalls: RecordedRecreate[] = [];
  const dockerArgv: string[][] = [];
  const machineDocuments: ManagedUpdateResult[] = [];
  let lockCount = 0;
  let releaseCount = 0;
  let interruption: "SIGINT" | "SIGTERM" | undefined;
  let runSequence = 0;

  const config: RfappsConfig = {
    composePath,
    envFile: join(root, ".env"),
    sidecars: { enabled: false, mapping: {} },
    groups: {},
    profiles: { mapping: {}, defaultProfile: "all", validProfiles: ["all"] },
    healthCheck: { timeout: 1, interval: 0, retries: 1, waitForReady: true },
    envTool: { tool: "none" },
    docker: { sshRetry: { maxRetries: 0, delayMs: 0 } },
    interactive: { pageSize: 10 },
    state: { enabled: true, dbPath: databasePath },
    parallel: { enabled: false, workers: 1 },
  };
  const composeProjectName = basename(root).toLowerCase();

  let harness: IntegrationHarness;

  function coordinatorDependencies(
    db: DbConnection,
    signal: { getInterruption(): "SIGINT" | "SIGTERM" | undefined },
  ): ManagedUpdateDependencies {
    return {
      plan: {
        resolveComposeProjectName: vi.fn(async () => composeProjectName),
        generatePlan: vi.fn(async () => deploymentPlan(statuses)),
      },
      docker: {
        getContextFingerprint: vi.fn(async () => "integration-context"),
        inspectServiceIdentity: vi.fn(async (input) =>
          identity(input.service, currentImages.get(input.service) ?? OLD_ID),
        ),
        recreateServiceWithImage: vi.fn(
          async (input: RecreateServiceWithImageInput): Promise<RecreateServiceWithImageResult> => {
            recreateCalls.push({
              service: input.service,
              projectName: input.projectName,
              source: input.source,
            });
            if (input.source.kind === "repository-digest") {
              dockerArgv.push(["docker", "compose", "pull", input.service]);
            }
            dockerArgv.push([
              "docker",
              "compose",
              "up",
              "-d",
              "--force-recreate",
              "--pull",
              "never",
              input.service,
            ]);
            if (input.source.kind === "local-image-id" && restoreFailures.has(input.service)) {
              return {
                success: false,
                stage: "recreate",
                command: { success: false, code: 1, stdout: "", stderr: "restore failed" },
              };
            }
            const imageId = input.source.kind === "local-image-id" ? OLD_ID : NEW_ID;
            currentImages.set(input.service, imageId);
            if (
              input.source.kind === "repository-digest" &&
              harness.interruptAfterUpdate === input.service
            ) {
              interruption = "SIGINT";
            }
            return {
              success: true,
              command: { success: true, code: 0, stdout: "", stderr: "" },
              identity: identity(input.service, imageId),
            };
          },
        ),
      },
      state: {
        findRecoveryGeneration(service, imageId) {
          return getGenerations(db, { service, limit: 100 }).find(
            (entry) => entry.imageId === imageId,
          );
        },
        findGeneration(service, generation) {
          return findGenerationByNumber(db, service, generation);
        },
        createGeneration(input) {
          return createGeneration(db, input);
        },
        recordDeployment(input) {
          return recordDeployment(db, input);
        },
        getGenerationCount(service) {
          return getGenerationCount(db, { service });
        },
      },
      health: {
        verifyServiceReadiness: vi.fn(async (input) => {
          const queue = verificationQueues.get(input.targetService);
          const ready = queue?.shift() ?? true;
          return verification(input.targetService, input.expectedImageId, ready);
        }),
      },
      clock: {
        now: vi.fn(() => new Date("2026-07-17T00:00:00.000Z")),
        randomId: vi.fn(() => `integration-run-${++runSequence}`),
      },
      lock: {
        acquire: vi.fn(async (options) => {
          lockCount += 1;
          harness.lockCount = lockCount;
          return {
            path: join(root, "integration.lock"),
            owner: {
              pid: process.pid,
              startedAt: "2026-07-17T00:00:00.000Z",
              projectPath: options.projectPath,
              dockerContext: options.dockerContext,
            },
            async release() {
              releaseCount += 1;
              harness.releaseCount = releaseCount;
            },
          };
        }),
      },
      signal: {
        getInterruption: () => signal.getInterruption() ?? interruption,
      },
      filesystem: { hashFile },
    };
  }

  const actionDependencies: UpdateActionDependencies = {
    loadConfig: vi.fn(async () => config),
    applyCliOverrides,
    resolveServices: vi.fn(async () => ({ services, profiles: ["all"] })),
    getComposeServices: vi.fn(async () => services),
    initializeDatabase,
    closeDatabase,
    createCoordinatorDependencies: coordinatorDependencies,
    generateManagedUpdatePlan,
    runManagedUpdate,
    loadManagedUpdatePlan,
    saveManagedUpdatePlan,
    saveManagedUpdateResult,
    confirm: vi.fn(async () => true),
    formatOutput: vi.fn(async (_format, data) => {
      machineDocuments.push(data as ManagedUpdateResult);
    }),
    now: vi.fn(() => new Date("2026-07-17T00:00:00.000Z")),
    randomId: vi.fn(() => `preview-${++runSequence}`),
    resolveComposeProjectIdentity: vi.fn(async (selectedComposePath) => ({
      composePath: selectedComposePath,
      projectDir: dirname(selectedComposePath),
      projectName: composeProjectName,
    })),
  };

  harness = {
    root,
    composePath,
    databasePath,
    config,
    statuses,
    verificationQueues,
    restoreFailures,
    recreateCalls,
    dockerArgv,
    machineDocuments,
    lockCount,
    releaseCount,
    actionDependencies,
    path(name) {
      return join(root, "artifacts", name);
    },
    async generationCount(service) {
      const connection = await initializeDatabase(databasePath);
      try {
        return getGenerationCount(connection, service === undefined ? {} : { service });
      } finally {
        closeDatabase(connection);
      }
    },
  };

  return harness;
}

function assertTargetedImmutableDockerCalls(harness: IntegrationHarness): void {
  expect(harness.dockerArgv.flat()).not.toContain("--remove-orphans");
  for (const call of harness.recreateCalls) {
    expect(call.projectName).toBe(basename(harness.root).toLowerCase());
    if (call.source.kind === "local-image-id") {
      expect(call.source.localImageId).toBe(OLD_ID);
    }
  }
  expect(
    harness.recreateCalls.some(
      (call) =>
        call.source.kind === "local-image-id" && Object.hasOwn(call.source, "repositoryDigest"),
    ),
  ).toBe(false);
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed update command/action/coordinator integration", () => {
  it("registers the preview/apply command surface", () => {
    const program = new Command();
    registerUpdateCommand(program);
    const update = program.commands.find((command) => command.name() === "update");

    expect(update).toBeDefined();
    expect(update?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--service",
        "--services",
        "--group",
        "--no-sidecars",
        "--apply",
        "--from-plan",
        "--out",
        "--no-restore-on-failure",
        "--health-timeout",
        "--compose",
        "--env-file",
        "--profile",
      ]),
    );
  });

  it("keeps preview immutable and persists a private secret-free managed plan", async () => {
    const harness = await createHarness({ alpha: "update-available" });
    const planPath = harness.path("preview.json");

    await executeUpdate(
      { out: planPath },
      { output: "json", useDotenvx: `/private/${CANARY_SECRET}.env` },
      harness.actionDependencies,
    );

    const persisted = await readFile(planPath, "utf8");
    expect((await loadManagedUpdatePlan(planPath)).schemaVersion).toBe("update-plan.v1");
    expect(persisted).not.toContain(CANARY_SECRET);
    expect(harness.recreateCalls).toEqual([]);
    expect(harness.lockCount).toBe(0);
    expect(await harness.generationCount()).toBe(0);
    expect(harness.machineDocuments).toHaveLength(1);
    expect(harness.machineDocuments[0]?.schemaVersion).toBe("update.v1");
  });

  it("returns a successful no-op without mutation or generation writes", async () => {
    const harness = await createHarness({ alpha: "up-to-date" });

    await executeUpdate(
      { apply: true, out: harness.path("no-op.json") },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    expect(harness.machineDocuments).toHaveLength(1);
    expect(harness.machineDocuments[0]).toMatchObject({
      status: "no_updates",
      success: true,
      exitCode: 0,
      applied: false,
    });
    expect(process.exitCode).toBeUndefined();
    expect(harness.recreateCalls).toEqual([]);
    expect(await harness.generationCount()).toBe(0);
  });

  it("accounts for mixed known and unknown detection and exits 1", async () => {
    const harness = await createHarness({
      alpha: "update-available",
      beta: "unknown",
    });

    await executeUpdate(
      { apply: true, out: harness.path("mixed.json") },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    expect(harness.machineDocuments).toHaveLength(1);
    expect(harness.machineDocuments[0]).toMatchObject({ status: "partial", exitCode: 1 });
    expect(harness.machineDocuments[0]?.services.map((service) => service.outcome)).toEqual([
      "updated",
      "detection_unknown",
    ]);
    expect(process.exitCode).toBe(1);
    assertTargetedImmutableDockerCalls(harness);
  });

  it("rejects a stale saved plan before Docker mutation", async () => {
    const harness = await createHarness({ alpha: "update-available" });
    const planPath = harness.path("stale-plan.json");

    await executeUpdate({ out: planPath }, {}, harness.actionDependencies);
    await writeFile(
      harness.composePath,
      "services:\n  changed:\n    image: changed:latest\n",
      "utf8",
    );
    await executeUpdate(
      { fromPlan: planPath, apply: true, out: harness.path("stale-report.json") },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    expect(harness.machineDocuments.at(-1)).toMatchObject({ status: "failed", exitCode: 1 });
    expect(harness.machineDocuments.at(-1)?.services[0]).toMatchObject({
      outcome: "blocked",
      error: { kind: "drift", drift: { kind: "compose" } },
    });
    expect(harness.recreateCalls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("applies multiple services sequentially and persists secret-free result state", async () => {
    const harness = await createHarness({
      alpha: "update-available",
      beta: "update-available",
    });
    const reportPath = harness.path("success.json");

    await executeUpdate(
      { apply: true, out: reportPath },
      { output: "json", yes: true, useOp: `/private/${CANARY_SECRET}.env` },
      harness.actionDependencies,
    );

    const report = await loadManagedUpdateResult(reportPath);
    expect(report).toMatchObject({ status: "succeeded", success: true, exitCode: 0 });
    expect(report.services.map((service) => service.outcome)).toEqual(["updated", "updated"]);
    expect(harness.recreateCalls.map((call) => call.service)).toEqual(["alpha", "beta"]);
    expect(await harness.generationCount("alpha")).toBe(2);
    expect(await harness.generationCount("beta")).toBe(2);
    expect(await readFile(reportPath, "utf8")).not.toContain(CANARY_SECRET);
    expect(harness.lockCount).toBe(1);
    expect(harness.releaseCount).toBe(1);
    assertTargetedImmutableDockerCalls(harness);
  });

  it("restores the exact local image, verifies it, continues, and exits 1", async () => {
    const harness = await createHarness({
      alpha: "update-available",
      beta: "update-available",
    });
    harness.verificationQueues.set("alpha", [false, true]);

    await executeUpdate(
      { apply: true, out: harness.path("restored.json") },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    const result = harness.machineDocuments[0];
    expect(result).toMatchObject({ status: "recovered_failure", success: false, exitCode: 1 });
    expect(result?.services.map((service) => service.outcome)).toEqual(["restored", "updated"]);
    expect(
      harness.recreateCalls.map((call) => ({ service: call.service, kind: call.source.kind })),
    ).toEqual([
      { service: "alpha", kind: "repository-digest" },
      { service: "alpha", kind: "local-image-id" },
      { service: "beta", kind: "repository-digest" },
    ]);
    expect(process.exitCode).toBe(1);
    assertTargetedImmutableDockerCalls(harness);
  });

  it("reports restore-disabled verification failure and stops later services", async () => {
    const harness = await createHarness({
      alpha: "update-available",
      beta: "update-available",
    });
    harness.verificationQueues.set("alpha", [false]);

    await executeUpdate(
      {
        apply: true,
        restoreOnFailure: false,
        out: harness.path("restore-disabled.json"),
      },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    const result = harness.machineDocuments[0];
    expect(result?.services[0]).toMatchObject({
      outcome: "update_failed",
      restore: { status: "disabled" },
    });
    expect(result?.services[1]?.outcome).toBe("blocked");
    expect(harness.recreateCalls).toHaveLength(1);
    assertTargetedImmutableDockerCalls(harness);
  });

  it("stops after exact restore failure and does not update later services", async () => {
    const harness = await createHarness({
      alpha: "update-available",
      beta: "update-available",
    });
    harness.verificationQueues.set("alpha", [false]);
    harness.restoreFailures.add("alpha");

    await executeUpdate(
      { apply: true, out: harness.path("restore-failed.json") },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    const result = harness.machineDocuments[0];
    expect(result?.services[0]?.outcome).toBe("restore_failed");
    expect(result?.services[1]?.outcome).toBe("blocked");
    expect(harness.recreateCalls.map((call) => call.service)).toEqual(["alpha", "alpha"]);
    expect(await harness.generationCount("alpha")).toBe(1);
    assertTargetedImmutableDockerCalls(harness);
  });

  it("stabilizes interruption by exact-image restore and marks later scope interrupted", async () => {
    const harness = await createHarness({
      alpha: "update-available",
      beta: "update-available",
    });
    harness.interruptAfterUpdate = "alpha";

    await executeUpdate(
      { apply: true, out: harness.path("interrupted.json") },
      { output: "json", yes: true },
      harness.actionDependencies,
    );

    const result = harness.machineDocuments[0];
    expect(result).toMatchObject({
      status: "interrupted",
      exitCode: 1,
      interruption: { signal: "SIGINT", service: "alpha", stabilized: true },
    });
    expect(result?.services[0]).toMatchObject({
      outcome: "interrupted",
      restore: { status: "succeeded", imageId: OLD_ID },
    });
    expect(result?.services[1]?.outcome).toBe("interrupted");
    assertTargetedImmutableDockerCalls(harness);
  });

  it("routes managed plans away from ordinary apply before mutation", async () => {
    const harness = await createHarness({ alpha: "update-available" });
    const planPath = harness.path("ordinary-apply-rejected.json");
    await executeUpdate({ out: planPath }, {}, harness.actionDependencies);

    await expect(executeApply({ planFile: planPath, force: true }, { yes: true })).rejects.toThrow(
      PlanValidationError,
    );

    expect(harness.recreateCalls).toEqual([]);
    expect(await harness.generationCount()).toBe(0);
  });
});
