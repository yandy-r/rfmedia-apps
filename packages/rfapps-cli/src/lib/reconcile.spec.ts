import { describe, expect, it, vi } from "vitest";

import type { ServiceDrift } from "../types/drift.js";
import type {
  ReconcileAutomationDecision,
  ReconcileContainerEvidence,
  ReconcileServiceObservation,
} from "../types/reconcile.js";
import { RECONCILE_MAX_SERVICES, RECONCILE_MAX_SERVICE_NAME_LENGTH } from "../types/reconcile.js";
import {
  allowAllReconcilePolicy,
  aggregateReconcileResult,
  buildReconcilePlan,
  canonicalizeReconcileValue,
  projectReconcileDrift,
  runReconcile,
  type BuildReconcilePlanInput,
  type ReconcileCoordinatorDependencies,
  type ReconcileServicePlanningInput,
} from "./reconcile.js";

const running: ReconcileContainerEvidence = {
  id: "container-a",
  name: "app-1",
  state: "running",
  health: "healthy",
};

function drift(service: string, categories: ServiceDrift["categories"] = []): ServiceDrift {
  const changed = categories.length > 0;
  return {
    service,
    hasDrift: changed,
    direction: "compose_ahead",
    categories,
    image: {
      current: "registry.example/old:secret",
      desired: "registry.example/new:secret",
      changed: categories.includes("image"),
    },
    environment: categories.includes("environment")
      ? [
          {
            name: "API_TOKEN",
            current: "old-secret-value",
            desired: "new-secret-value",
            changeType: "modified",
            isSecret: true,
          },
          {
            name: "MODE",
            current: "development",
            desired: "production",
            changeType: "modified",
            isSecret: false,
          },
        ]
      : [],
    ports: {
      current: [{ host: "1111", container: "80", protocol: "tcp" }],
      desired: [{ host: "2222", container: "80", protocol: "tcp" }],
      changed: categories.includes("ports"),
    },
    volumes: {
      current: [{ source: "/secret/current", target: "/data" }],
      desired: [{ source: "/secret/desired", target: "/data" }],
      changed: categories.includes("volumes"),
    },
    networks: {
      current: ["secret-current-network"],
      desired: ["secret-desired-network"],
      changed: categories.includes("networks"),
    },
    runtimeStatus: {
      current: { state: "running", health: "healthy" },
      desired: { state: "running", health: "healthy" },
      changed: categories.includes("runtime-status"),
    },
  };
}

function evidence(
  service: string,
  serviceDrift = drift(service),
  observation: ReconcileServiceObservation = { kind: "present", containers: [running] },
): ReconcileServicePlanningInput {
  return {
    service,
    resolvedConfigFingerprint: `${service}-config-fingerprint`,
    observation,
    drift: serviceDrift,
  };
}

function input(
  services: readonly ReconcileServicePlanningInput[],
  options: {
    mode?: BuildReconcilePlanInput["mode"];
    dryRun?: boolean;
    scope?: string[];
    profiles?: string[];
    automation?: ReconcileAutomationDecision;
  } = {},
): BuildReconcilePlanInput {
  return {
    mode: options.mode ?? "report",
    dryRun: options.dryRun ?? false,
    scope: {
      composePath: "/project/compose.yml",
      project: "example",
      profiles: options.profiles ?? ["all"],
      services: options.scope ?? services.map(({ service }) => service),
    },
    authority: {
      composeFingerprint: "compose-fingerprint",
      resolvedComposeFingerprint: "resolved-compose-fingerprint",
      dockerAuthorityFingerprint: "docker-fingerprint",
      environmentSourceFingerprint: "environment-fingerprint",
    },
    services,
    ...(options.automation === undefined ? {} : { automation: options.automation }),
  };
}

describe("reconcile pure planner", () => {
  it("canonicalizes nested values with deterministic code-point key ordering", () => {
    expect(canonicalizeReconcileValue({ z: 1, a: { y: 2, b: 3 }, omitted: undefined })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
  });

  it("is invariant to service, profile, category, environment, and container input order", () => {
    const firstDrift = drift("alpha", ["runtime-status", "ports", "environment", "image"]);
    const secondDrift: ServiceDrift = {
      ...firstDrift,
      categories: ["image", "environment", "ports", "runtime-status"],
      environment: [...firstDrift.environment].reverse(),
    };
    const extraContainer: ReconcileContainerEvidence = {
      id: "container-b",
      name: "app-2",
      state: "running",
      health: "healthy",
    };
    const first = buildReconcilePlan(
      input(
        [
          evidence("zeta"),
          evidence("alpha", firstDrift, {
            kind: "ambiguous",
            containers: [extraContainer, running],
          }),
        ],
        { scope: ["zeta", "alpha"], profiles: ["media", "core"] },
      ),
    );
    const second = buildReconcilePlan(
      input(
        [
          evidence("alpha", secondDrift, {
            kind: "ambiguous",
            containers: [running, extraContainer],
          }),
          evidence("zeta"),
        ],
        { scope: ["alpha", "zeta"], profiles: ["core", "media"] },
      ),
    );

    expect(second).toEqual(first);
    expect(first.services.map(({ service }) => service)).toEqual(["alpha", "zeta"]);
    expect(first.scope.profiles).toEqual(["core", "media"]);
    expect(first.actionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("selects none, create, start, recreate, and blocked without omitting services", () => {
    const stopped: ReconcileContainerEvidence = {
      ...running,
      id: "stopped-id",
      state: "exited",
      health: "none",
    };
    const result = buildReconcilePlan(
      input(
        [
          evidence("none"),
          evidence("create", undefined, { kind: "missing" }),
          evidence("start", drift("start", ["runtime-status"]), {
            kind: "present",
            containers: [stopped],
          }),
          evidence("recreate", drift("recreate", ["image"])),
          evidence("blocked", drift("blocked", ["image"]), {
            kind: "ambiguous",
            containers: [running, { ...running, id: "other-id", name: "app-2" }],
          }),
        ],
        { scope: ["start", "none", "blocked", "recreate", "create"] },
      ),
    );

    expect(result.services.map(({ service, action }) => [service, action.kind])).toEqual([
      ["blocked", "blocked"],
      ["create", "create"],
      ["none", "none"],
      ["recreate", "recreate"],
      ["start", "start"],
    ]);
    expect(result.summary).toEqual({
      selected: 5,
      inSync: 1,
      drifted: 3,
      actionable: 3,
      blocked: 1,
      converged: 1,
      failed: 1,
    });
  });

  it("blocks ambiguous multiplicity with stable value-free evidence", () => {
    const result = buildReconcilePlan(
      input([
        evidence("scaled", drift("scaled", ["image"]), {
          kind: "present",
          containers: [running, { ...running, id: "container-b", name: "scaled-2" }],
        }),
      ]),
    );

    expect(result.services[0]).toMatchObject({
      service: "scaled",
      comparison: "observation_failed",
      action: {
        kind: "blocked",
        eligibility: "blocked",
        reasons: [{ code: "RECONCILE_AMBIGUOUS_INSTANCES" }],
      },
      outcome: "observation_failed",
    });
  });

  it("orders action categories and reasons by the normative category order", () => {
    const result = buildReconcilePlan(
      input([evidence("app", drift("app", ["networks", "image", "volumes", "ports"]))]),
    );
    expect(result.services[0]?.action.categories).toEqual([
      "image",
      "ports",
      "volumes",
      "networks",
    ]);
    expect(result.services[0]?.action.reasons).toEqual([
      { code: "RECONCILE_IMAGE_DRIFT", category: "image" },
      { code: "RECONCILE_PORTS_DRIFT", category: "ports" },
      { code: "RECONCILE_VOLUMES_DRIFT", category: "volumes" },
      { code: "RECONCILE_NETWORKS_DRIFT", category: "networks" },
    ]);
  });

  it("accounts once for missing and duplicate evidence instead of dropping scope entries", () => {
    const duplicate = evidence("duplicate", drift("duplicate", ["image"]));
    const result = buildReconcilePlan(
      input([duplicate, duplicate], { scope: ["missing", "duplicate"] }),
    );

    expect(result.services).toHaveLength(2);
    expect(result.services.map(({ service }) => service)).toEqual(["duplicate", "missing"]);
    expect(result.services.map(({ action }) => action.reasons[0]?.code)).toEqual([
      "RECONCILE_EVIDENCE_DUPLICATE",
      "RECONCILE_EVIDENCE_MISSING",
    ]);
  });

  it("projects environment names and kinds while omitting every raw desired/current value", () => {
    const raw = drift("app", ["image", "environment", "ports", "volumes", "networks"]);
    const projection = projectReconcileDrift(raw);
    const result = buildReconcilePlan(input([evidence("app", raw)]));
    const serialized = JSON.stringify({ projection, result });

    expect(projection.environment).toEqual([
      { name: "API_TOKEN", changeType: "modified" },
      { name: "MODE", changeType: "modified" },
    ]);
    for (const forbidden of [
      "old-secret-value",
      "new-secret-value",
      "development",
      "production",
      "registry.example/old:secret",
      "registry.example/new:secret",
      "/secret/current",
      "/secret/desired",
      "secret-current-network",
      "secret-desired-network",
      "1111",
      "2222",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("excludes secret values and volatile policy timestamps from the action fingerprint", () => {
    const first = drift("app", ["environment"]);
    const second: ServiceDrift = {
      ...first,
      environment: first.environment.map((change) => ({
        ...change,
        current: `different-current-${change.name}`,
        desired: `different-desired-${change.name}`,
      })),
    };
    const one = buildReconcilePlan(
      input([evidence("app", first)], {
        mode: "auto-apply",
        automation: {
          status: "blocked",
          reasonCode: "WINDOW_CLOSED",
          nextEligibleAt: "2030-01-01T00:00:00Z",
        },
      }),
    );
    const two = buildReconcilePlan(
      input([evidence("app", second)], {
        mode: "auto-apply",
        automation: {
          status: "blocked",
          reasonCode: "WINDOW_CLOSED",
          nextEligibleAt: "2040-01-01T00:00:00Z",
        },
      }),
    );

    expect(two.actionFingerprint).toBe(one.actionFingerprint);
    expect(one.status).toBe("partial");
    expect(one.exitCode).toBe(3);
    expect(one.services[0]?.action).toMatchObject({
      kind: "blocked",
      proposedKind: "recreate",
      eligibility: "blocked",
    });
  });

  it("provides an allow-all v1 policy seam without granting report or dry-run authority", async () => {
    const scope = input([evidence("app")]).scope;
    await expect(
      Promise.resolve(
        allowAllReconcilePolicy.evaluate({
          mode: "report",
          dryRun: false,
          scope,
          actionableServices: ["app"],
        }),
      ),
    ).resolves.toEqual({ status: "not_requested" });
    await expect(
      Promise.resolve(
        allowAllReconcilePolicy.evaluate({
          mode: "auto-apply",
          dryRun: true,
          scope,
          actionableServices: ["app"],
        }),
      ),
    ).resolves.toEqual({ status: "not_requested" });
    await expect(
      Promise.resolve(
        allowAllReconcilePolicy.evaluate({
          mode: "auto-apply",
          dryRun: false,
          scope,
          actionableServices: ["app"],
        }),
      ),
    ).resolves.toEqual({ status: "allowed" });
  });

  it("does not write process exit state or mutate caller-owned inputs", () => {
    const originalExitCode = process.exitCode;
    const source = input([evidence("app", drift("app", ["environment", "image"]))]);
    const snapshot = structuredClone(source);

    buildReconcilePlan(source);

    expect(source).toEqual(snapshot);
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("rejects duplicate selected services before planning", () => {
    expect(() => buildReconcilePlan(input([evidence("app")], { scope: ["app", "app"] }))).toThrow(
      "Reconcile scope services must be unique",
    );
  });

  it("rejects oversized scopes and service names before planning evidence", () => {
    const oversizedScope = Array.from(
      { length: RECONCILE_MAX_SERVICES + 1 },
      (_, index) => `service-${index}`,
    );
    expect(() => buildReconcilePlan(input([], { scope: oversizedScope }))).toThrow(
      `Reconcile scope cannot exceed ${RECONCILE_MAX_SERVICES} services`,
    );

    const oversizedName = "s".repeat(RECONCILE_MAX_SERVICE_NAME_LENGTH + 1);
    expect(() => buildReconcilePlan(input([], { scope: [oversizedName] }))).toThrow(
      `Reconcile service names cannot exceed ${RECONCILE_MAX_SERVICE_NAME_LENGTH} characters`,
    );

    const oversizedEvidence = Array.from({ length: RECONCILE_MAX_SERVICES + 1 }, () =>
      evidence("app"),
    );
    expect(() => buildReconcilePlan(input(oversizedEvidence, { scope: ["app"] }))).toThrow(
      `Reconcile scope cannot exceed ${RECONCILE_MAX_SERVICES} services`,
    );
  });
});

function autoInput(services: string[] = ["app"]): BuildReconcilePlanInput {
  return input(
    services.map((service) => evidence(service, drift(service, ["image"]))),
    { mode: "auto-apply", scope: services },
  );
}

function inSyncInput(services: string[] = ["app"]): BuildReconcilePlanInput {
  return input(
    services.map((service) => evidence(service)),
    {
      mode: "auto-apply",
      scope: services,
    },
  );
}

function fakeDependencies(
  captures: Array<BuildReconcilePlanInput | Error>,
  options: {
    phases?: string[][];
    actionSuccess?: boolean;
    ready?: boolean;
    signals?: Array<string | undefined>;
    policy?: ReconcileAutomationDecision;
    releaseFailure?: boolean;
  } = {},
): ReconcileCoordinatorDependencies & {
  calls: string[];
} {
  const calls: string[] = [];
  const signals = [...(options.signals ?? [])];
  return {
    calls,
    observation: {
      capture: vi.fn(async () => {
        calls.push("capture");
        const next = captures.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error("missing fake observation");
        return structuredClone(next);
      }),
    },
    order: {
      phases: vi.fn(
        async (services: readonly string[]): Promise<readonly (readonly string[])[]> => {
          calls.push("phases");
          return options.phases ?? [Array.from(services)];
        },
      ),
    },
    execution: {
      reconcileService: vi.fn(async ({ service }) => {
        calls.push(`action:${service}`);
        return { success: options.actionSuccess ?? true };
      }),
      verifyReadiness: vi.fn(async (service) => {
        calls.push(`ready:${service}`);
        return options.ready ?? true;
      }),
    },
    lock: {
      acquire: vi.fn(async () => {
        calls.push("lock");
        return {
          path: "/state/reconcile.lock",
          owner: {
            pid: 1,
            startedAt: "2026-07-18T00:00:00.000Z",
            projectPath: "/project",
            dockerContext: "docker-fingerprint",
          },
          release: vi.fn(async () => {
            calls.push("release");
            if (options.releaseFailure === true) throw new Error("release failed");
          }),
        };
      }),
    },
    policy: {
      evaluate: vi.fn(
        async (): Promise<ReconcileAutomationDecision> => options.policy ?? { status: "allowed" },
      ),
    },
    signal: {
      getInterruption: vi.fn(() => signals.shift()),
    },
    clock: {
      now: vi.fn(() => 1_721_264_400_000),
    },
  };
}

describe("reconcile lifecycle coordinator", () => {
  it.each([
    ["reported", "reported", true, 0],
    ["no_action", "converged", true, 0],
    ["became_in_sync", "converged", true, 0],
    ["converged", "converged", true, 0],
    ["blocked_policy", "partial", false, 3],
    ["blocked_stale", "partial", false, 3],
    ["observation_failed", "failed", false, 1],
    ["action_failed", "failed", false, 1],
    ["not_converged", "failed", false, 1],
    ["cancelled_before_action", "cancelled", false, 2],
    ["cancelled_during_action", "cancelled", false, 2],
    ["skipped_after_unsafe_failure", "partial", false, 3],
  ] as const)("aggregates terminal outcome %s as %s", (outcome, status, success, exitCode) => {
    const service = { ...buildReconcilePlan(autoInput()).services[0]!, outcome };
    expect(aggregateReconcileResult([service])).toEqual({ status, success, exitCode });
  });

  it("keeps report and dry-run paths free of every injected side effect", async () => {
    const report = await runReconcile(input([evidence("app", drift("app", ["image"]))]));
    const dryRun = await runReconcile(
      input([evidence("app", drift("app", ["image"]))], {
        mode: "auto-apply",
        dryRun: true,
      }),
    );

    expect(report.services[0]?.outcome).toBe("reported");
    expect(dryRun.services[0]?.outcome).toBe("reported");
  });

  it("does not acquire the lock when auto-apply has no actionable work", async () => {
    const result = await runReconcile(inSyncInput());
    expect(result.status).toBe("converged");
    expect(result.services[0]?.outcome).toBe("no_action");
  });

  it("locks, revalidates, acts sequentially by dependency phase, and proves convergence", async () => {
    const reviewed = autoInput(["api", "db"]);
    const finalDb = input([evidence("api", drift("api", ["image"])), evidence("db")], {
      mode: "auto-apply",
      scope: ["api", "db"],
    });
    const finalAll = inSyncInput(["api", "db"]);
    const deps = fakeDependencies([reviewed, reviewed, finalDb, finalDb, finalAll], {
      phases: [["db"], ["api"]],
    });

    const result = await runReconcile(reviewed, { projectDir: "/project" }, deps);

    expect(result.status).toBe("converged");
    expect(result.services.map(({ service, outcome }) => [service, outcome])).toEqual([
      ["api", "converged"],
      ["db", "converged"],
    ]);
    expect(deps.execution.reconcileService).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedResolvedComposeFingerprint: "resolved-compose-fingerprint",
      }),
    );
    expect(deps.calls).toEqual([
      "lock",
      "capture",
      "phases",
      "capture",
      "action:db",
      "ready:db",
      "capture",
      "capture",
      "action:api",
      "ready:api",
      "capture",
      "release",
    ]);
  });

  it("records became_in_sync when the immediate recheck no longer proposes work", async () => {
    const reviewed = autoInput();
    const deps = fakeDependencies([reviewed, inSyncInput()]);
    const result = await runReconcile(reviewed, {}, deps);

    expect(result.services[0]?.outcome).toBe("became_in_sync");
    expect(deps.calls).not.toContain("action:app");
    expect(deps.calls.at(-1)).toBe("release");
  });

  it("fails closed on locked authority evidence changes", async () => {
    const reviewed = autoInput();
    const stale = structuredClone(reviewed);
    stale.authority.dockerAuthorityFingerprint = "changed-docker-authority";
    const deps = fakeDependencies([stale]);
    const result = await runReconcile(reviewed, {}, deps);

    expect(result.services[0]).toMatchObject({
      outcome: "blocked_stale",
      action: {
        kind: "blocked",
        reasons: expect.arrayContaining([{ code: "RECONCILE_REVIEW_STALE" }]),
      },
    });
    expect(deps.calls).not.toContain("action:app");
  });

  it("blocks policy denial under the lock without treating yes as authority", async () => {
    const reviewed = autoInput();
    const deps = fakeDependencies([reviewed], {
      policy: { status: "blocked", reasonCode: "WINDOW_CLOSED" },
    });
    const result = await runReconcile(reviewed, {}, deps);

    expect(result.services[0]).toMatchObject({ outcome: "blocked_policy" });
    expect(result.services[0]?.action.reasons).toContainEqual({ code: "WINDOW_CLOSED" });
  });

  it("stops later scheduling after an observation failure and accounts for every service", async () => {
    const reviewed = autoInput(["a", "b"]);
    const deps = fakeDependencies([reviewed, new Error("observation unavailable")], {
      phases: [["a", "b"]],
    });
    const result = await runReconcile(reviewed, {}, deps);

    expect(result.services.map(({ service, outcome }) => [service, outcome])).toEqual([
      ["a", "observation_failed"],
      ["b", "skipped_after_unsafe_failure"],
    ]);
  });

  it.each([
    [false, true, "action_failed"],
    [true, false, "not_converged"],
  ] as const)(
    "maps action success=%s readiness=%s to %s",
    async (actionSuccess, ready, outcome) => {
      const reviewed = autoInput();
      const captures = actionSuccess ? [reviewed, reviewed, reviewed] : [reviewed, reviewed];
      const deps = fakeDependencies(captures, { actionSuccess, ready });
      const result = await runReconcile(reviewed, {}, deps);
      expect(result.services[0]?.outcome).toBe(outcome);
      expect(deps.calls.at(-1)).toBe("release");
    },
  );

  it("cancels before lock acquisition and still returns complete terminal data", async () => {
    const reviewed = autoInput(["a", "b"]);
    const deps = fakeDependencies([], { signals: ["SIGINT"] });
    const result = await runReconcile(reviewed, {}, deps);
    expect(result.status).toBe("cancelled");
    expect(result.services.every(({ outcome }) => outcome === "cancelled_before_action")).toBe(
      true,
    );
    expect(deps.calls).toEqual([]);
  });

  it("marks an interruption observed after mutation as cancelled_during_action", async () => {
    const reviewed = autoInput();
    const deps = fakeDependencies([reviewed, reviewed, inSyncInput()], {
      signals: [undefined, undefined, "SIGTERM"],
    });
    const result = await runReconcile(reviewed, {}, deps);

    expect(result.status).toBe("cancelled");
    expect(result.services[0]?.outcome).toBe("cancelled_during_action");
    expect(deps.calls).toContain("ready:app");
    expect(deps.calls.at(-1)).toBe("release");
  });

  it("marks an interruption observed after readiness as cancelled_during_action", async () => {
    const reviewed = autoInput();
    const deps = fakeDependencies([reviewed, reviewed, inSyncInput()], {
      signals: [undefined, undefined, undefined, "SIGINT", undefined],
    });
    const result = await runReconcile(reviewed, {}, deps);

    expect(result).toMatchObject({ status: "cancelled", success: false, exitCode: 2 });
    expect(result.services[0]).toMatchObject({
      outcome: "cancelled_during_action",
      finalDrift: { hasDrift: false },
    });
    expect(deps.calls).toContain("ready:app");
    expect(deps.calls.at(-1)).toBe("release");
  });

  it("marks an interruption observed during final capture as cancelled_during_action", async () => {
    const reviewed = autoInput();
    const deps = fakeDependencies([reviewed, reviewed, inSyncInput()], {
      signals: [undefined, undefined, undefined, undefined, "SIGTERM"],
    });
    const result = await runReconcile(reviewed, {}, deps);

    expect(result).toMatchObject({ status: "cancelled", success: false, exitCode: 2 });
    expect(result.services[0]).toMatchObject({
      outcome: "cancelled_during_action",
      finalDrift: { hasDrift: false },
    });
    expect(deps.calls).toContain("capture");
    expect(deps.calls.at(-1)).toBe("release");
  });

  it("does not let lock cleanup failure replace a completed primary result", async () => {
    const reviewed = autoInput();
    const deps = fakeDependencies([reviewed, reviewed], {
      actionSuccess: false,
      releaseFailure: true,
    });
    const result = await runReconcile(reviewed, {}, deps);
    expect(result.services[0]?.outcome).toBe("action_failed");
  });
});
