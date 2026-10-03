import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceDrift } from "../types/drift.js";
import type { RfappsConfig } from "../types/config.js";
import type { ReconcileResult } from "../types/reconcile.js";
import { RECONCILE_MAX_SERVICES, RECONCILE_MAX_SERVICE_NAME_LENGTH } from "../types/reconcile.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { resolvedServiceConfigFingerprint } from "../lib/plan-generator.js";
import {
  buildReconcilePlan,
  type BuildReconcilePlanInput,
  type ReconcileCoordinatorDependencies,
} from "../lib/reconcile.js";
import {
  createProductionCoordinatorDependencies,
  executeReconcile,
  resolvedComposeAuthorityBlockReason,
  type ReconcileActionDependencies,
  type ReconcileRuntimeContext,
} from "./reconcile.js";

function config(): RfappsConfig {
  return {
    composePath: "/project/compose.yml",
    envFile: "/project/.env",
    sidecars: { enabled: true, mapping: { plex: "plex-ts" } },
    groups: { media: ["sonarr", "plex"] },
    profiles: {
      mapping: { plex: "media", "plex-ts": "media", sonarr: "media", traefik: "core" },
      defaultProfile: "all",
      validProfiles: ["all", "media", "core"],
    },
    healthCheck: { timeout: 60, interval: 5, retries: 12, waitForReady: true },
    envTool: { tool: "none" },
    docker: { sshRetry: { maxRetries: 3, delayMs: 100 } },
    interactive: { pageSize: 20 },
    state: { enabled: true },
    parallel: { enabled: false, workers: 2 },
  };
}

function drift(service: string, categories: ServiceDrift["categories"] = []): ServiceDrift {
  const changed = categories.length > 0;
  return {
    service,
    hasDrift: changed,
    direction: "compose_ahead",
    categories,
    image: {
      current: "registry.example/old:private",
      desired: "registry.example/new:private",
      changed: categories.includes("image"),
    },
    environment: categories.includes("environment")
      ? [
          {
            name: "API_TOKEN",
            current: "old-super-secret",
            desired: "new-super-secret",
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
      changed: categories.includes("runtime-status"),
    },
  };
}

function snapshot(
  context: ReconcileRuntimeContext,
  categories: ServiceDrift["categories"] = ["environment"],
): BuildReconcilePlanInput {
  return {
    mode: context.mode,
    dryRun: context.dryRun,
    scope: context.scope,
    authority: {
      composeFingerprint: "compose-fingerprint",
      resolvedComposeFingerprint: "resolved-compose-fingerprint",
      dockerAuthorityFingerprint: "docker-fingerprint",
      environmentSourceFingerprint: "environment-fingerprint",
    },
    services: context.scope.services.map((service) => ({
      service,
      resolvedConfigFingerprint: `${service}-config`,
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
      drift: drift(service, categories),
    })),
  };
}

function withAggregate(
  result: ReconcileResult,
  aggregate: Pick<ReconcileResult, "status" | "success" | "exitCode">,
): ReconcileResult {
  return { ...result, ...aggregate };
}

function coordinator(input: BuildReconcilePlanInput): ReconcileCoordinatorDependencies {
  return {
    observation: { capture: vi.fn().mockResolvedValue(input) },
    order: { phases: vi.fn(async (services) => [services]) },
    execution: {
      reconcileService: vi.fn().mockResolvedValue({ success: true }),
      verifyReadiness: vi.fn().mockResolvedValue(true),
    },
    lock: {
      acquire: vi.fn().mockResolvedValue({
        path: "/tmp/reconcile.lock",
        owner: {
          pid: 1,
          hostname: "test",
          startedAt: "2026-07-18T00:00:00.000Z",
          token: "token",
        },
        release: vi.fn().mockResolvedValue(undefined),
      }),
    },
    policy: { evaluate: vi.fn().mockReturnValue({ status: "allowed" }) },
    signal: { getInterruption: vi.fn().mockReturnValue(undefined) },
    clock: { now: vi.fn().mockReturnValue(0) },
  };
}

function dependencies(
  overrides: Partial<ReconcileActionDependencies> = {},
  categories: ServiceDrift["categories"] = ["environment"],
): ReconcileActionDependencies {
  const baseConfig = config();
  const deps: ReconcileActionDependencies = {
    loadConfig: vi.fn().mockResolvedValue(baseConfig),
    applyCliOverrides: vi.fn((loaded, options) => ({
      ...loaded,
      composePath: options.composePath ?? loaded.composePath,
      envFile: options.envFile ?? loaded.envFile,
      sidecars: {
        ...loaded.sidecars,
        enabled: options.noSidecars ? false : loaded.sidecars.enabled,
      },
      profiles: {
        ...loaded.profiles,
        defaultProfile: options.profile ?? loaded.profiles.defaultProfile,
      },
    })),
    resolveServices: vi.fn().mockResolvedValue({ services: ["plex"], profiles: ["media"] }),
    getComposeServices: vi.fn().mockResolvedValue(["sonarr", "plex", "plex"]),
    resolveComposeEnvironmentFilePath: vi.fn(async (envFile) => envFile),
    resolveComposeProjectIdentity: vi.fn().mockResolvedValue({
      composePath: "/project/compose.yml",
      projectDir: "/project",
      projectName: "project",
    }),
    captureSnapshot: vi.fn(async (context) => snapshot(context, categories)),
    createCoordinatorDependencies: vi.fn((context) => coordinator(snapshot(context, categories))),
    buildReconcilePlan,
    runReconcile: vi.fn(async (input) => buildReconcilePlan(input)),
    confirm: vi.fn().mockResolvedValue(true),
    formatOutput: vi.fn().mockResolvedValue(undefined),
  };
  return { ...deps, ...overrides };
}

describe("executeReconcile", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    process.exitCode = undefined;
  });

  it("reports by default with a non-interactive frozen scope and no mutation approval", async () => {
    const deps = dependencies();

    await executeReconcile({}, {}, deps);

    expect(deps.resolveServices).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, noSidecars: false }),
      expect.any(Object),
      "/project/compose.yml",
      "/project",
      expect.any(Object),
    );
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
    expect(deps.runReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "report", dryRun: false }),
    );
    expect(process.exitCode).toBe(0);
  });

  it("carries --tag through normalization into the frozen resolver selection", async () => {
    const deps = dependencies();

    await executeReconcile({ tag: ["media/**", "!media/streaming"] }, {}, deps);

    // NormalizedReconcileOptions is declared locally, so ServiceTargetOptions' `tag`
    // fan-out does not reach it. If normalizeOptions drops the axis, `options.tag` is
    // permanently undefined and `reconcile --tag` declares the flag then silently
    // reconciles a wider scope than asked for - on a mutating, lock-taking command.
    expect(deps.resolveServices).toHaveBeenCalledWith(
      expect.objectContaining({ tag: ["media/**", "!media/streaming"] }),
      expect.any(Object),
      "/project/compose.yml",
      "/project",
      expect.any(Object),
    );
  });

  it("omits the tag key entirely when --tag is absent", async () => {
    const deps = dependencies();

    await executeReconcile({}, {}, deps);

    expect(vi.mocked(deps.resolveServices).mock.calls[0]?.[0]).not.toHaveProperty("tag");
  });

  it("lets dry-run veto auto-apply without approval, signals, or coordinator dependencies", async () => {
    const deps = dependencies();
    const sigintBefore = process.listenerCount("SIGINT");

    await executeReconcile({ autoApply: true }, { dryRun: true, yes: true }, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(deps.runReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "auto-apply", dryRun: true }),
    );
  });

  it("does not prompt or assemble mutation dependencies for an in-sync auto-apply no-op", async () => {
    const deps = dependencies({}, []);

    await executeReconcile({ autoApply: true }, {}, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it.each([false, true])(
    "reports unsnapshotable Compose resources before confirmation (autoApply=%s)",
    async (autoApply) => {
      const blockedCapture = vi.fn(async (context: ReconcileRuntimeContext) => ({
        ...snapshot(context),
        services: context.scope.services.map((service) => ({
          service,
          resolvedConfigFingerprint: `${service}-config`,
          observation: {
            kind: "failed" as const,
            reasonCode: "RECONCILE_AUTHORITY_UNSNAPSHOTABLE",
          },
        })),
      }));
      const deps = dependencies({ captureSnapshot: blockedCapture });

      await executeReconcile({ autoApply }, { yes: true }, deps);

      expect(deps.confirm).not.toHaveBeenCalled();
      expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
      expect(deps.runReconcile).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    },
  );

  it("detects file- and environment-backed resources in resolved planning authority", () => {
    expect(
      resolvedComposeAuthorityBlockReason(
        {
          services: { app: { configs: [{ source: "settings" }] } },
          configs: { settings: { file: "/private/settings.conf" } },
        },
        "app",
      ),
    ).toBe("RECONCILE_AUTHORITY_UNSNAPSHOTABLE");
    expect(
      resolvedComposeAuthorityBlockReason(
        {
          services: { app: { secrets: [{ source: "token" }] } },
          secrets: { token: { environment: "PRIVATE_TOKEN" } },
        },
        "app",
      ),
    ).toBe("RECONCILE_AUTHORITY_UNSNAPSHOTABLE");
  });

  it("declines the exact sorted target list without invoking the coordinator", async () => {
    const deps = dependencies({
      resolveServices: vi
        .fn()
        .mockResolvedValue({ services: ["sonarr", "plex"], profiles: ["media"] }),
      confirm: vi.fn().mockResolvedValue(false),
    });

    await executeReconcile({ autoApply: true }, {}, deps);

    expect(deps.confirm).toHaveBeenCalledWith(
      "Apply 2 reconciliation action(s) to plex, sonarr? " +
        "Compose state is authoritative and containers may restart.",
    );
    expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
    expect(deps.runReconcile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("rejects machine auto-apply without --yes after review and before prompt or mutation", async () => {
    const deps = dependencies();

    await expect(
      executeReconcile({ autoApply: true }, { output: "json" }, deps),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(deps.captureSnapshot).toHaveBeenCalledOnce();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
    expect(deps.runReconcile).not.toHaveBeenCalled();
    expect(deps.formatOutput).not.toHaveBeenCalled();
  });

  it("expands implicit all selection and sorts and deduplicates its complete scope", async () => {
    const deps = dependencies({
      resolveServices: vi.fn().mockResolvedValue({ services: [], profiles: ["all"] }),
    });

    await executeReconcile({}, {}, deps);

    expect(deps.getComposeServices).toHaveBeenCalledWith("/project/compose.yml", {
      profiles: ["all"],
      projectName: "project",
      envFile: "/project/.env",
      envTool: undefined,
    });
    expect(deps.captureSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ services: ["plex", "sonarr"] }),
      }),
    );
  });

  it.each([
    {
      name: "service count",
      raw: {
        services: Array.from(
          { length: RECONCILE_MAX_SERVICES + 1 },
          (_, index) => `service-${index}`,
        ).join(","),
      },
      resolved: Array.from(
        { length: RECONCILE_MAX_SERVICES + 1 },
        (_, index) => `service-${index}`,
      ),
    },
    {
      name: "service name length",
      raw: { service: "s".repeat(RECONCILE_MAX_SERVICE_NAME_LENGTH + 1) },
      resolved: ["s".repeat(RECONCILE_MAX_SERVICE_NAME_LENGTH + 1)],
    },
  ])(
    "rejects oversized resolved $name before snapshot, lock, or mutation",
    async ({ raw, resolved }) => {
      const deps = dependencies({
        resolveServices: vi.fn().mockResolvedValue({ services: resolved, profiles: ["all"] }),
      });

      await expect(executeReconcile(raw, { yes: true }, deps)).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );

      expect(deps.captureSnapshot).not.toHaveBeenCalled();
      expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
      expect(deps.runReconcile).not.toHaveBeenCalled();
    },
  );

  it("passes group selection, sidecar veto, and an explicit profile without interaction", async () => {
    const deps = dependencies({
      resolveServices: vi
        .fn()
        .mockResolvedValue({ services: ["plex-ts", "plex"], profiles: ["all"] }),
    });

    await executeReconcile(
      { group: "media", sidecars: false, profile: "media" },
      { yes: false },
      deps,
    );

    expect(deps.resolveServices).toHaveBeenCalledWith(
      expect.objectContaining({ group: "media", noSidecars: true, sidecars: false, yes: true }),
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
    expect(deps.captureSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ profiles: ["media"], services: ["plex", "plex-ts"] }),
      }),
    );
  });

  it.each([false, true])(
    "rejects an explicit empty group before observation or mutation (autoApply=%s)",
    async (autoApply) => {
      const deps = dependencies({
        loadConfig: vi.fn().mockResolvedValue({
          ...config(),
          groups: { ...config().groups, empty: [] },
        }),
        resolveServices: vi.fn().mockResolvedValue({ services: [], profiles: ["all"] }),
      });

      await expect(
        executeReconcile({ group: "empty", autoApply }, { yes: true }, deps),
      ).rejects.toMatchObject({ argument: "--group", value: "empty" });

      expect(deps.getComposeServices).not.toHaveBeenCalled();
      expect(deps.resolveComposeEnvironmentFilePath).not.toHaveBeenCalled();
      expect(deps.resolveComposeProjectIdentity).not.toHaveBeenCalled();
      expect(deps.resolveServices).not.toHaveBeenCalled();
      expect(deps.captureSnapshot).not.toHaveBeenCalled();
      expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
      expect(deps.runReconcile).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes the plain env file before resolving any Compose authority", async () => {
    const deps = dependencies({
      resolveComposeEnvironmentFilePath: vi
        .fn()
        .mockResolvedValue("/canonical/project/reviewed.env"),
    });

    await executeReconcile({ envFile: "/project/./reviewed.env" }, {}, deps);

    expect(deps.resolveComposeEnvironmentFilePath).toHaveBeenCalledWith("/project/./reviewed.env");
    expect(deps.resolveComposeProjectIdentity).toHaveBeenCalledWith("/project/compose.yml", {
      envFile: "/canonical/project/reviewed.env",
      envTool: undefined,
    });
    expect(deps.captureSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ envFile: "/canonical/project/reviewed.env" }),
    );
  });

  it("normalizes comma-list selection and threads the health timeout and env wrapper", async () => {
    const deps = dependencies({
      resolveServices: vi
        .fn()
        .mockResolvedValue({ services: ["sonarr", "plex"], profiles: ["media"] }),
    });

    await executeReconcile(
      { services: " sonarr,plex ", autoApply: true, healthTimeout: "90" },
      { yes: true, useOp: "/private/runtime.env" },
      deps,
    );

    expect(deps.resolveServices).toHaveBeenCalledWith(
      expect.objectContaining({ services: ["sonarr", "plex"] }),
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
    expect(deps.createCoordinatorDependencies).toHaveBeenCalledWith(
      expect.objectContaining({
        envTool: { tool: "op", envFile: "/private/runtime.env" },
        healthPoll: { timeoutSeconds: 90, intervalSeconds: 5, retries: 12 },
      }),
      expect.any(Object),
    );
  });

  it("pins the wrapper environment and never reopens its source after capture", async () => {
    const context: ReconcileRuntimeContext = {
      mode: "auto-apply",
      dryRun: false,
      scope: {
        composePath: "/project/compose.yml",
        project: "project",
        profiles: ["media"],
        services: ["plex"],
      },
      projectDir: "/project",
      envFile: "/project/reviewed.env",
      config: config(),
      healthPoll: { timeoutSeconds: 60, intervalSeconds: 5, retries: 12 },
    };
    const executeTarget = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      success: true,
    });
    const resolvedCompose = {
      name: "project",
      services: { plex: { image: "example/plex:reviewed" } },
    };
    const captureEnvironment = vi
      .fn()
      .mockResolvedValueOnce({ PATH: "/usr/bin", DOCKER_HOST: "tcp://reviewed" })
      .mockResolvedValueOnce({ PATH: "/attacker", DOCKER_HOST: "tcp://attacker" });
    const captureResolvedCompose = vi.fn().mockResolvedValue(resolvedCompose);
    const production = createProductionCoordinatorDependencies(
      context,
      { getInterruption: () => undefined },
      executeTarget,
      captureResolvedCompose,
      captureEnvironment,
    );

    await production.execution.reconcileService({
      composePath: "/project/compose.yml",
      projectName: "project",
      profiles: ["media"],
      service: "plex",
      action: "recreate",
      expectedResolvedComposeFingerprint: resolvedServiceConfigFingerprint(resolvedCompose),
    });

    expect(executeTarget).toHaveBeenCalledWith(
      {
        composePath: "/project/compose.yml",
        projectName: "project",
        profiles: ["media"],
        service: "plex",
        action: "recreate",
        expectedResolvedComposeFingerprint: resolvedServiceConfigFingerprint(resolvedCompose),
        projectDirectory: "/project",
        resolvedComposeJson: JSON.stringify(resolvedCompose),
      },
      {
        cwd: "/project",
        env: { PATH: "/usr/bin", DOCKER_HOST: "tcp://reviewed" },
        replaceEnv: true,
      },
    );
    expect(captureEnvironment).toHaveBeenCalledOnce();
    expect(captureResolvedCompose).toHaveBeenCalledWith(
      "/project/compose.yml",
      expect.objectContaining({ replaceEnv: true }),
    );
    expect(captureResolvedCompose.mock.calls[0]?.[1].envTool).toBeUndefined();

    await production.execution.reconcileService({
      composePath: "/project/compose.yml",
      projectName: "project",
      profiles: ["media"],
      service: "plex",
      action: "recreate",
      expectedResolvedComposeFingerprint: resolvedServiceConfigFingerprint(resolvedCompose),
    });
    expect(captureEnvironment).toHaveBeenCalledOnce();
  });

  it("fails closed when the resolved Compose model changes at the mutation boundary", async () => {
    const context: ReconcileRuntimeContext = {
      mode: "auto-apply",
      dryRun: false,
      scope: {
        composePath: "/project/compose.yml",
        project: "project",
        profiles: ["media"],
        services: ["plex"],
      },
      projectDir: "/project",
      envFile: "/project/reviewed.env",
      config: config(),
      healthPoll: { timeoutSeconds: 60, intervalSeconds: 5, retries: 12 },
    };
    const changed = { name: "project", services: { plex: { image: "attacker/replaced" } } };
    const executeTarget = vi.fn();
    const production = createProductionCoordinatorDependencies(
      context,
      { getInterruption: () => undefined },
      executeTarget,
      vi.fn().mockResolvedValue(changed),
      vi.fn().mockResolvedValue({ PATH: "/usr/bin" }),
    );

    await expect(
      production.execution.reconcileService({
        composePath: "/project/compose.yml",
        projectName: "project",
        service: "plex",
        action: "recreate",
        expectedResolvedComposeFingerprint: "reviewed-resolved-compose-fingerprint",
      }),
    ).rejects.toThrow("Resolved Compose authority changed before reconciliation");
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("fails closed when a selected service still references mutable config files", async () => {
    const context: ReconcileRuntimeContext = {
      mode: "auto-apply",
      dryRun: false,
      scope: {
        composePath: "/project/compose.yml",
        project: "project",
        profiles: ["media"],
        services: ["plex"],
      },
      projectDir: "/project",
      envFile: "/project/reviewed.env",
      config: config(),
      healthPoll: { timeoutSeconds: 60, intervalSeconds: 5, retries: 12 },
    };
    const unresolved = {
      name: "project",
      services: { plex: { image: "example/plex", configs: [{ source: "settings" }] } },
      configs: { settings: { file: "/project/settings.conf" } },
    };
    const executeTarget = vi.fn();
    const production = createProductionCoordinatorDependencies(
      context,
      { getInterruption: () => undefined },
      executeTarget,
      vi.fn().mockResolvedValue(unresolved),
      vi.fn().mockResolvedValue({ PATH: "/usr/bin" }),
    );

    await expect(
      production.execution.reconcileService({
        composePath: "/project/compose.yml",
        projectName: "project",
        service: "plex",
        action: "recreate",
        expectedResolvedComposeFingerprint: resolvedServiceConfigFingerprint(unresolved),
      }),
    ).rejects.toThrow("Resolved Compose authority contains unpinned external resources");
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("hides unchanged text rows unless --show-unchanged is set", async () => {
    const hidden = dependencies({}, []);
    await executeReconcile({}, {}, hidden);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain("plex: in_sync");

    consoleError.mockClear();
    const shown = dependencies({}, []);
    await executeReconcile({ showUnchanged: true }, {}, shown);
    expect(consoleError.mock.calls.flat().join("\n")).toContain("plex: in_sync");
  });

  it.each(["json", "yaml"] as const)(
    "emits exactly one complete reconcile.v1 %s result",
    async (format) => {
      const deps = dependencies();

      await executeReconcile({}, { output: format }, deps);

      expect(deps.formatOutput).toHaveBeenCalledOnce();
      expect(deps.formatOutput).toHaveBeenCalledWith(
        format,
        expect.objectContaining({
          schemaVersion: "reconcile.v1",
          operation: "reconcile",
          services: [expect.objectContaining({ service: "plex", drift: expect.any(Object) })],
        }),
      );
    },
  );

  it.each(["table", "csv"] as const)("uses a value-free flat %s projection", async (format) => {
    const deps = dependencies();

    await executeReconcile({}, { output: format }, deps);

    expect(deps.formatOutput).toHaveBeenCalledWith(format, [
      {
        service: "plex",
        comparison: "drifted",
        action: "recreate",
        categories: "environment",
        eligibility: "not_requested",
        outcome: "reported",
        drift: true,
      },
    ]);
  });

  it("never publishes raw environment, image, or env-source secret values", async () => {
    const deps = dependencies();

    await executeReconcile({}, { output: "json", useDotenvx: "/private/secret.env" }, deps);

    const emitted = vi.mocked(deps.formatOutput).mock.calls[0]?.[1];
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("old-super-secret");
    expect(serialized).not.toContain("new-super-secret");
    expect(serialized).not.toContain("registry.example");
    expect(serialized).not.toContain("/private/secret.env");
    expect(serialized).toContain("API_TOKEN");
  });

  it("keeps signal tracking scoped to auto-apply and propagates cancellation exit 2", async () => {
    let interruption: string | undefined;
    const deps = dependencies({
      createCoordinatorDependencies: vi.fn((context, signal) => {
        const value = snapshot(context);
        const result = coordinator(value);
        result.signal = signal;
        return result;
      }),
      runReconcile: vi.fn(async (input, _options, injected) => {
        process.emit("SIGINT");
        interruption = injected?.signal.getInterruption();
        return withAggregate(buildReconcilePlan(input), {
          status: "cancelled",
          success: false,
          exitCode: 2,
        });
      }),
    });
    const sigintBefore = process.listenerCount("SIGINT");

    await executeReconcile({ autoApply: true }, { yes: true }, deps);

    expect(interruption).toBe("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["reported", true, 0],
    ["failed", false, 1],
    ["cancelled", false, 2],
    ["partial", false, 3],
  ] as const)("sets %s exit %s only after output", async (status, success, exitCode) => {
    let exitDuringOutput: number | string | null | undefined;
    const deps = dependencies({
      runReconcile: vi.fn(async (input) =>
        withAggregate(buildReconcilePlan(input), { status, success, exitCode }),
      ),
      formatOutput: vi.fn(async () => {
        exitDuringOutput = process.exitCode;
      }),
    });

    await executeReconcile({}, { output: "json" }, deps);

    expect(exitDuringOutput).toBeUndefined();
    expect(process.exitCode).toBe(exitCode);
  });

  it.each([
    [{ healthTimeout: "0" }, {}],
    [{ healthTimeout: "NaN" }, {}],
    [{ services: ",," }, {}],
    [{ profile: "unknown" }, {}],
  ] as const)("rejects invalid input before observation", async (raw, global) => {
    const deps = dependencies();

    await expect(executeReconcile(raw, global, deps)).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(deps.captureSnapshot).not.toHaveBeenCalled();
    expect(deps.createCoordinatorDependencies).not.toHaveBeenCalled();
  });
});
