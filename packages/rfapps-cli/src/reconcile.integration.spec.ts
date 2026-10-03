import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceDrift } from "./types/drift.js";
import type { RfappsConfig } from "./types/config.js";
import type { ReconcileResult } from "./types/reconcile.js";
import type { BuildReconcilePlanInput, ReconcileCoordinatorDependencies } from "./lib/reconcile.js";
import type { ReconcileActionDependencies, ReconcileRuntimeContext } from "./actions/reconcile.js";

const reconcileBridge = vi.hoisted(() => ({
  dependencies: undefined as unknown,
  calls: [] as Array<{ raw: unknown; global: unknown }>,
}));

vi.mock("./actions/reconcile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./actions/reconcile.js")>();
  return {
    ...actual,
    executeReconcile: async (
      raw: Parameters<typeof actual.executeReconcile>[0],
      global: Parameters<typeof actual.executeReconcile>[1],
      dependencies?: Parameters<typeof actual.executeReconcile>[2],
    ) => {
      reconcileBridge.calls.push({ raw, global });
      return actual.executeReconcile(
        raw,
        global,
        dependencies ??
          (reconcileBridge.dependencies as Parameters<typeof actual.executeReconcile>[2]),
      );
    },
  };
});

import { executeDriftReconcile } from "./actions/drift.js";
import { executeReconcile } from "./actions/reconcile.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
import { formatOutput, withFormatOutputCapture } from "./lib/formatters/index.js";
import {
  acquireLifecycleLock,
  LifecycleLockError,
  type LifecycleLock,
} from "./lib/lifecycle-lock.js";
import { buildReconcilePlan, runReconcile } from "./lib/reconcile.js";
import { invokeDriftReconcile } from "./mcp/adapters.js";

const temporaryRoots: string[] = [];

function config(root: string): RfappsConfig {
  return {
    composePath: join(root, "compose.yml"),
    envFile: join(root, ".env"),
    sidecars: { enabled: false, mapping: {} },
    groups: {},
    profiles: {
      mapping: { alpha: "all", beta: "all", gamma: "all" },
      defaultProfile: "all",
      validProfiles: ["all"],
    },
    healthCheck: { timeout: 2, interval: 0, retries: 1, waitForReady: true },
    envTool: { tool: "none" },
    docker: { sshRetry: { maxRetries: 0, delayMs: 0 } },
    interactive: { pageSize: 10 },
    state: { enabled: true, dbPath: join(root, "state.db") },
    parallel: { enabled: false, workers: 1 },
  };
}

function serviceDrift(service: string, changed: boolean): ServiceDrift {
  return {
    service,
    hasDrift: changed,
    direction: "compose_ahead",
    categories: changed ? ["environment"] : [],
    image: { current: "fixture:latest", desired: "fixture:latest", changed: false },
    environment: changed
      ? [
          {
            name: "INTEGRATION_TOKEN",
            current: "private-current-value",
            desired: "private-desired-value",
            changeType: "modified",
            isSecret: true,
          },
        ]
      : [],
    ports: { current: [], desired: [], changed: false },
    volumes: { current: [], desired: [], changed: false },
    networks: { current: [], desired: [], changed: false },
    runtimeStatus: {
      current: { state: "running", health: "healthy" },
      desired: { state: "running", health: "healthy" },
      changed: false,
    },
  };
}

function snapshot(
  context: Pick<ReconcileRuntimeContext, "mode" | "dryRun" | "scope">,
  driftedServices: ReadonlySet<string>,
): BuildReconcilePlanInput {
  return {
    mode: context.mode,
    dryRun: context.dryRun,
    scope: structuredClone(context.scope),
    authority: {
      composeFingerprint: "compose-fingerprint",
      resolvedComposeFingerprint: "resolved-compose-fingerprint",
      dockerAuthorityFingerprint: "docker-fingerprint",
      environmentSourceFingerprint: "environment-fingerprint",
    },
    services: context.scope.services.map((service) => ({
      service,
      resolvedConfigFingerprint: `${service}-config-fingerprint`,
      observation: {
        kind: "present",
        containers: [
          {
            id: `${service}-container-id`,
            name: `${service}-1`,
            state: "running",
            health: "healthy",
          },
        ],
      },
      drift: serviceDrift(service, driftedServices.has(service)),
    })),
  };
}

interface ReconcileHarness {
  root: string;
  dependencies: ReconcileActionDependencies;
  actionCalls: string[];
  lockCount: number;
  releaseCount: number;
  maxConcurrentActions: number;
  failAction: Set<string>;
  preserveDrift: Set<string>;
  mutateBeforeLockedCapture?: (snapshot: BuildReconcilePlanInput) => void;
}

async function createHarness(
  selectedServices: readonly string[] = ["alpha"],
  initiallyDrifted: readonly string[] = selectedServices,
): Promise<ReconcileHarness> {
  const root = await mkdtemp(join(tmpdir(), "rfapps-reconcile-integration-"));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  const composePath = join(root, "compose.yml");
  await writeFile(
    composePath,
    `services:\n${selectedServices.map((service) => `  ${service}:\n    image: fixture:latest`).join("\n")}\n`,
    "utf8",
  );

  const baseConfig = config(root);
  const drifted = new Set(initiallyDrifted);
  let current: BuildReconcilePlanInput | undefined;
  let activeActions = 0;

  const harness: ReconcileHarness = {
    root,
    dependencies: undefined as unknown as ReconcileActionDependencies,
    actionCalls: [],
    lockCount: 0,
    releaseCount: 0,
    maxConcurrentActions: 0,
    failAction: new Set(),
    preserveDrift: new Set(),
  };

  function coordinator(): ReconcileCoordinatorDependencies {
    let firstCapture = true;
    return {
      observation: {
        async capture() {
          if (current === undefined) throw new Error("Initial snapshot was not captured");
          const captured = structuredClone(current);
          if (firstCapture) {
            firstCapture = false;
            harness.mutateBeforeLockedCapture?.(captured);
          }
          return captured;
        },
      },
      order: {
        async phases(services) {
          return services.map((service) => [service]);
        },
      },
      execution: {
        async reconcileService(input) {
          activeActions += 1;
          harness.maxConcurrentActions = Math.max(harness.maxConcurrentActions, activeActions);
          harness.actionCalls.push(input.service);
          await Promise.resolve();
          activeActions -= 1;
          if (harness.failAction.has(input.service)) return { success: false };
          if (!harness.preserveDrift.has(input.service) && current !== undefined) {
            const evidence = current.services.find((entry) => entry.service === input.service);
            if (evidence !== undefined) evidence.drift = serviceDrift(input.service, false);
          }
          return { success: true };
        },
        async verifyReadiness(service) {
          return !harness.preserveDrift.has(service);
        },
      },
      lock: {
        async acquire(options) {
          harness.lockCount += 1;
          const lock: LifecycleLock = {
            path: join(root, "reconcile.lock"),
            owner: {
              pid: process.pid,
              startedAt: "2026-07-18T00:00:00.000Z",
              projectPath: options.projectPath,
              dockerContext: options.dockerContext,
            },
            async release() {
              harness.releaseCount += 1;
            },
          };
          return lock;
        },
      },
      policy: { evaluate: () => ({ status: "allowed" }) },
      signal: { getInterruption: () => undefined },
      clock: { now: () => 0 },
    };
  }

  harness.dependencies = {
    loadConfig: vi.fn(async () => baseConfig),
    applyCliOverrides: vi.fn((loaded, options) => ({
      ...loaded,
      composePath: options.composePath ?? loaded.composePath,
      envFile: options.envFile ?? loaded.envFile,
    })),
    resolveServices: vi.fn(async () => ({ services: [...selectedServices], profiles: ["all"] })),
    getComposeServices: vi.fn(async () => [...selectedServices]),
    resolveComposeEnvironmentFilePath: vi.fn(async (envFile) => envFile),
    resolveComposeProjectIdentity: vi.fn(async () => ({
      composePath,
      projectDir: dirname(composePath),
      projectName: "integration",
    })),
    captureSnapshot: vi.fn(async (context) => {
      current = snapshot(context, drifted);
      return structuredClone(current);
    }),
    createCoordinatorDependencies: vi.fn(() => coordinator()),
    buildReconcilePlan,
    runReconcile,
    confirm: vi.fn(async () => true),
    formatOutput,
  };

  return harness;
}

async function captureDocuments(operation: () => Promise<unknown>): Promise<unknown[]> {
  const documents: unknown[] = [];
  await withFormatOutputCapture((_format, payload) => documents.push(payload), operation);
  return documents;
}

beforeEach(() => {
  process.exitCode = undefined;
  reconcileBridge.calls.length = 0;
  reconcileBridge.dependencies = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  reconcileBridge.dependencies = undefined;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("assembled reconciliation surfaces", () => {
  it("routes the root command through the action and emits one complete deterministic result", async () => {
    const harness = await createHarness(["beta", "alpha"]);
    const program = new Command().name("rfapps").exitOverride();
    program.option("--output <format>", "output format", "text");
    registerReconcileCommand(program, {
      loadAction: async () => ({
        executeReconcile: (raw, global) => executeReconcile(raw, global, harness.dependencies),
      }),
    });

    const documents = await captureDocuments(() =>
      program.parseAsync(
        ["node", "rfapps", "--output", "json", "reconcile", "--services", "beta,alpha"],
        { from: "node" },
      ),
    );

    expect(documents).toHaveLength(1);
    const result = documents[0] as ReconcileResult;
    expect(result).toMatchObject({ schemaVersion: "reconcile.v1", status: "reported" });
    expect(result.services.map(({ service }) => service)).toEqual(["alpha", "beta"]);
    expect(result.summary.selected).toBe(2);
    expect(result.actionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("private-current-value");
  });

  it("keeps report, dry-run, and in-sync auto-apply free of locks, actions, and persistence", async () => {
    const report = await createHarness(["alpha"]);
    await captureDocuments(() => executeReconcile({}, { output: "json" }, report.dependencies));
    const dryRun = await createHarness(["alpha"]);
    await captureDocuments(() =>
      executeReconcile(
        { autoApply: true },
        { output: "json", dryRun: true, yes: true },
        dryRun.dependencies,
      ),
    );
    const noOp = await createHarness(["alpha"], []);
    await captureDocuments(() =>
      executeReconcile({ autoApply: true }, { output: "json", yes: true }, noOp.dependencies),
    );

    for (const harness of [report, dryRun, noOp]) {
      expect(harness.actionCalls).toEqual([]);
      expect(harness.lockCount).toBe(0);
      expect(await readdir(harness.root)).toEqual(["compose.yml"]);
    }
  });

  it("auto-applies dependency phases sequentially and proves fresh convergence", async () => {
    const harness = await createHarness(["beta", "alpha"]);
    const documents = await captureDocuments(() =>
      executeReconcile({ autoApply: true }, { output: "json", yes: true }, harness.dependencies),
    );

    const result = documents[0] as ReconcileResult;
    expect(harness.actionCalls).toEqual(["alpha", "beta"]);
    expect(harness.maxConcurrentActions).toBe(1);
    expect(harness.lockCount).toBe(1);
    expect(harness.releaseCount).toBe(1);
    expect(result).toMatchObject({ status: "converged", success: true, exitCode: 0 });
    expect(result.services.map(({ outcome }) => outcome)).toEqual(["converged", "converged"]);
  });

  it("fails closed on stale reviewed authority without applying any action", async () => {
    const harness = await createHarness(["alpha"]);
    harness.mutateBeforeLockedCapture = (captured) => {
      captured.authority.composeFingerprint = "changed-compose-fingerprint";
    };
    const documents = await captureDocuments(() =>
      executeReconcile({ autoApply: true }, { output: "json", yes: true }, harness.dependencies),
    );

    const result = documents[0] as ReconcileResult;
    expect(harness.actionCalls).toEqual([]);
    expect(harness.releaseCount).toBe(1);
    expect(result.services[0]).toMatchObject({ outcome: "blocked_stale" });
    expect(result.services[0]?.action.reasons).toContainEqual({ code: "RECONCILE_REVIEW_STALE" });
  });

  it("preserves complete ordered results after action failure and residual drift", async () => {
    const failed = await createHarness(["gamma", "beta", "alpha"], ["alpha", "beta"]);
    failed.failAction.add("alpha");
    const failedDocuments = await captureDocuments(() =>
      executeReconcile({ autoApply: true }, { output: "json", yes: true }, failed.dependencies),
    );
    const failureResult = failedDocuments[0] as ReconcileResult;
    expect(failureResult.services.map(({ service, outcome }) => [service, outcome])).toEqual([
      ["alpha", "action_failed"],
      ["beta", "skipped_after_unsafe_failure"],
      ["gamma", "no_action"],
    ]);
    expect(failureResult).toMatchObject({ status: "partial", exitCode: 3 });

    const residual = await createHarness(["alpha"]);
    residual.preserveDrift.add("alpha");
    const residualDocuments = await captureDocuments(() =>
      executeReconcile({ autoApply: true }, { output: "json", yes: true }, residual.dependencies),
    );
    expect(residualDocuments[0]).toMatchObject({
      status: "failed",
      exitCode: 1,
      services: [{ service: "alpha", outcome: "not_converged" }],
    });
  });

  it("makes the legacy command and MCP adapter delegate to the same action and result", async () => {
    const legacy = await createHarness(["alpha"]);
    reconcileBridge.dependencies = legacy.dependencies;
    await captureDocuments(() =>
      executeDriftReconcile({ service: "alpha" }, { output: "json", yes: true }),
    );
    expect(reconcileBridge.calls.at(-1)?.raw).toMatchObject({
      service: "alpha",
      autoApply: true,
    });
    expect(legacy.actionCalls).toEqual(["alpha"]);

    const mcp = await createHarness(["alpha"]);
    reconcileBridge.dependencies = mcp.dependencies;
    process.exitCode = 77;
    const result = await invokeDriftReconcile({ autoApply: false, service: "alpha" });
    expect(result).toMatchObject({ schemaVersion: "reconcile.v1", status: "reported" });
    expect(result.services).toHaveLength(1);
    expect(process.exitCode).toBe(77);
    expect(reconcileBridge.calls.at(-1)?.raw).toMatchObject({
      service: "alpha",
      autoApply: false,
    });
  });

  it("shares the lifecycle lock namespace with other project lifecycle operations", async () => {
    const harness = await createHarness(["alpha"]);
    const context: Pick<ReconcileRuntimeContext, "mode" | "dryRun" | "scope"> = {
      mode: "auto-apply",
      dryRun: false,
      scope: {
        composePath: join(harness.root, "compose.yml"),
        project: "integration",
        profiles: ["all"],
        services: ["alpha"],
      },
    };
    const reviewed = snapshot(context, new Set(["alpha"]));
    const stateDir = join(harness.root, "state");
    const held = await acquireLifecycleLock({
      projectPath: harness.root,
      dockerContext: reviewed.authority.dockerAuthorityFingerprint,
      composeProjectName: reviewed.scope.project,
      stateDir,
    });
    const productionLockDependencies = harness.dependencies.createCoordinatorDependencies(
      {
        ...context,
        projectDir: harness.root,
        envFile: join(harness.root, ".env"),
        config: config(harness.root),
        healthPoll: { timeoutSeconds: 1, intervalSeconds: 0, retries: 1 },
      },
      { getInterruption: () => undefined },
    );
    productionLockDependencies.lock.acquire = acquireLifecycleLock;

    try {
      await expect(
        runReconcile(reviewed, { projectDir: harness.root, stateDir }, productionLockDependencies),
      ).rejects.toMatchObject({ code: "LOCK_HELD" } satisfies Partial<LifecycleLockError>);
      expect(harness.actionCalls).toEqual([]);
    } finally {
      await held.release();
    }
  });
});
