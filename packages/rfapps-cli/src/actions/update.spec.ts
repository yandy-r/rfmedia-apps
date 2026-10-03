import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { DbConnection } from "../lib/db.js";
import type { DockerExecOptions } from "../lib/docker.js";
import type { ManagedUpdateDependencies } from "../lib/managed-update.js";
import type { RfappsConfig } from "../types/config.js";
import type { ManagedUpdatePlan, ManagedUpdateResult } from "../types/update.js";
import { InvalidArgumentError } from "../lib/errors.js";
import {
  dockerAuthorityFingerprint,
  executeUpdate,
  resolveComposeProjectIdentity,
  type UpdateActionDependencies,
} from "./update.js";

const db = {} as DbConnection;
const coordinator = {} as ManagedUpdateDependencies;

function config(): RfappsConfig {
  return {
    composePath: "/project/compose.yml",
    envFile: "/project/.env",
    sidecars: { enabled: true, mapping: {} },
    groups: {},
    profiles: { mapping: {}, defaultProfile: "all", validProfiles: ["all", "media"] },
    healthCheck: { timeout: 60, interval: 5, retries: 12, waitForReady: true },
    envTool: { tool: "none" },
    docker: { sshRetry: { maxRetries: 3, delayMs: 100 } },
    interactive: { pageSize: 20 },
    state: { enabled: true, dbPath: "/tmp/rfapps-update-test.db" },
    parallel: { enabled: false, workers: 2 },
  };
}

function managedPlan(
  status: ManagedUpdatePlan["services"][number]["status"] = "update-available",
): ManagedUpdatePlan {
  return {
    schemaVersion: "update-plan.v1",
    intent: "managed-update",
    id: "plan-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    composeHash: "hash",
    composePath: "/project/compose.yml",
    dockerContextFingerprint: "context",
    envSourceFingerprint: "a".repeat(64),
    composeProjectName: "project",
    targetServices: ["plex"],
    profiles: ["media"],
    applyPolicy: "sequential",
    restorePolicy: "restore-on-failure",
    services: [
      {
        service: "plex",
        resolvedConfigFingerprint: "b".repeat(64),
        status,
        configuredImage: "example/plex:latest",
        currentImageId: `sha256:${"1".repeat(64)}`,
        currentDigest: `docker.io/example/plex@sha256:${"2".repeat(64)}`,
        proposedDigest: `docker.io/example/plex@sha256:${"3".repeat(64)}`,
        recoveryEligible: true,
        recoveryGeneration: 3,
        verification: "healthcheck",
      },
    ],
  };
}

function managedResult(success = true): ManagedUpdateResult {
  const plan = managedPlan();
  return {
    schemaVersion: "update.v1",
    runId: "run-1",
    planId: plan.id,
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:01.000Z",
    status: success ? "succeeded" : "recovered_failure",
    success,
    exitCode: success ? 0 : 1,
    applied: true,
    restoreOnFailure: true,
    summary: {
      selected: 1,
      actionable: 1,
      updated: success ? 1 : 0,
      restored: success ? 0 : 1,
      upToDate: 0,
      unsupported: 0,
      unknown: 0,
      blocked: 0,
      failed: 0,
      interrupted: 0,
    },
    services: [
      {
        service: "plex",
        outcome: success ? "updated" : "restored",
        stage: "complete",
        reviewedIdentity: {
          configuredImage: "example/plex:latest",
          currentImageId: plan.services[0]?.currentImageId,
          proposedDigest: plan.services[0]?.proposedDigest,
        },
        verification: { status: "not-run", assurance: "none", reasonCode: "fixture" },
        restore: { status: "not-required" },
        generations: {},
        durationMs: 1_000,
      },
    ],
  };
}

function dependencies(overrides: Partial<UpdateActionDependencies> = {}): UpdateActionDependencies {
  const baseConfig = config();
  const deps: UpdateActionDependencies = {
    loadConfig: vi.fn().mockResolvedValue(baseConfig),
    applyCliOverrides: vi.fn((loaded, cli) => ({
      ...loaded,
      composePath: cli.composePath ?? loaded.composePath,
      envFile: cli.envFile ?? loaded.envFile,
      sidecars: { ...loaded.sidecars, enabled: cli.noSidecars ? false : loaded.sidecars.enabled },
      profiles: {
        ...loaded.profiles,
        defaultProfile: cli.profile ?? loaded.profiles.defaultProfile,
      },
    })),
    resolveServices: vi.fn().mockResolvedValue({ services: ["plex"], profiles: ["media"] }),
    getComposeServices: vi.fn().mockResolvedValue(["plex", "sonarr"]),
    initializeDatabase: vi.fn().mockResolvedValue(db),
    closeDatabase: vi.fn(),
    createCoordinatorDependencies: vi.fn().mockReturnValue(coordinator),
    generateManagedUpdatePlan: vi.fn().mockResolvedValue(managedPlan()),
    runManagedUpdate: vi.fn().mockResolvedValue(managedResult()),
    loadManagedUpdatePlan: vi.fn().mockResolvedValue(managedPlan()),
    saveManagedUpdatePlan: vi.fn().mockResolvedValue("/private/update-plan.json"),
    saveManagedUpdateResult: vi.fn().mockResolvedValue("/private/update-report.json"),
    reserveManagedUpdateResultPath: vi.fn().mockResolvedValue("/private/update-report.json"),
    confirm: vi.fn().mockResolvedValue(true),
    formatOutput: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => new Date("2026-07-17T00:00:00.000Z")),
    randomId: vi.fn(() => "preview-run"),
    resolveComposeProjectIdentity: vi.fn(async (composePath) => ({
      composePath,
      projectDir: dirname(composePath),
      projectName: basename(dirname(composePath)),
    })),
  };
  return { ...deps, ...overrides };
}

describe("executeUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("previews without mutation and writes an update-plan.v1 artifact", async () => {
    const deps = dependencies();

    await executeUpdate({ out: "/private/preview.json" }, {}, deps);

    expect(deps.generateManagedUpdatePlan).toHaveBeenCalledOnce();
    expect(deps.runManagedUpdate).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.saveManagedUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: "update-plan.v1" }),
      "/private/preview.json",
    );
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
  });

  it("records a bounded database close failure before preview machine output", async () => {
    const order: string[] = [];
    const deps = dependencies({
      closeDatabase: vi.fn(() => {
        order.push("close");
        throw new Error(`Bearer preview-secret ${"x".repeat(3_000)}`);
      }),
      saveManagedUpdatePlan: vi.fn(async () => {
        order.push("save-plan");
        return "/private/update-plan.json";
      }),
      formatOutput: vi.fn(async () => {
        order.push("output");
      }),
    });

    await executeUpdate({}, { output: "json" }, deps);

    expect(order).toEqual(["close", "save-plan", "output"]);
    const output = vi.mocked(deps.formatOutput).mock.calls[0]?.[1] as ManagedUpdateResult;
    expect(output).toMatchObject({ status: "failed", success: false, exitCode: 1 });
    expect(output.cleanupFailures).toEqual([
      expect.objectContaining({ operation: "state-close", code: "CLEANUP_FAILED" }),
    ]);
    expect(output.cleanupFailures?.[0]?.message).not.toContain("preview-secret");
    expect(output.cleanupFailures?.[0]?.message.length).toBeLessThanOrEqual(512);
  });

  it("keeps generated plan artifacts free of resolved secret values", async () => {
    const deps = dependencies();

    await executeUpdate({}, { useDotenvx: "/private/secrets.env" }, deps);

    const persisted = vi.mocked(deps.saveManagedUpdatePlan).mock.calls[0]?.[0];
    expect(JSON.stringify(persisted)).not.toContain("/private/secrets.env");
    expect(deps.generateManagedUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ envTool: { tool: "dotenvx", envFile: "/private/secrets.env" } }),
      coordinator,
    );
  });

  it("declines exactly one approval without running the coordinator", async () => {
    const deps = dependencies({ confirm: vi.fn().mockResolvedValue(false) });

    await executeUpdate({ apply: true }, {}, deps);

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.runManagedUpdate).not.toHaveBeenCalled();
    expect(deps.saveManagedUpdateResult).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.saveManagedUpdateResult).mock.calls[0]?.[0].services[0]?.outcome).toBe(
      "cancelled",
    );
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
  });

  it("applies with --yes, reserves --out before mutation, and replaces it with the final report", async () => {
    const order: string[] = [];
    const deps = dependencies({
      reserveManagedUpdateResultPath: vi.fn(async () => {
        order.push("reserve");
        return "/private/report.json";
      }),
      saveManagedUpdateResult: vi.fn(async (_result, _path, options) => {
        order.push(options?.overwrite === true ? "final" : "unexpected-write");
        return "/private/report.json";
      }),
      runManagedUpdate: vi.fn(async () => {
        order.push("run");
        return managedResult();
      }),
    });

    await executeUpdate({ apply: true, out: "/private/report.json" }, { yes: true }, deps);

    expect(order).toEqual(["reserve", "run", "final"]);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.runManagedUpdate).toHaveBeenCalledOnce();
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
  });

  it("persists and emits an apply database close failure instead of throwing after success", async () => {
    const order: string[] = [];
    const deps = dependencies({
      runManagedUpdate: vi.fn(async () => {
        order.push("run");
        return managedResult();
      }),
      closeDatabase: vi.fn(() => {
        order.push("close");
        throw new Error("database close failed");
      }),
      saveManagedUpdateResult: vi.fn(async () => {
        order.push("save-report");
        return "/private/update-report.json";
      }),
      formatOutput: vi.fn(async () => {
        order.push("output");
      }),
    });

    await executeUpdate({ apply: true }, { output: "json", yes: true }, deps);

    expect(order).toEqual(["run", "close", "save-report", "output"]);
    const persisted = vi.mocked(deps.saveManagedUpdateResult).mock.calls[0]?.[0];
    if (persisted === undefined) throw new Error("Expected a persisted managed update result");
    expect(persisted).toMatchObject({ status: "partial", success: false, exitCode: 1 });
    expect(persisted.cleanupFailures).toEqual([
      expect.objectContaining({ operation: "state-close", code: "CLEANUP_FAILED" }),
    ]);
    expect(deps.formatOutput).toHaveBeenCalledWith("json", persisted);
  });

  it("emits planned rather than cancelled for machine-format preview", async () => {
    const deps = dependencies();

    await executeUpdate({}, { output: "json" }, deps);

    expect(deps.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        applied: false,
        services: [expect.objectContaining({ outcome: "planned" })],
      }),
    );
    const output = vi.mocked(deps.formatOutput).mock.calls[0]?.[1];
    expect(JSON.stringify(output)).not.toContain('"outcome":"cancelled"');
  });

  it("reserves --out without publishing a terminal report before mutation", async () => {
    const order: string[] = [];
    const mutationError = new Error("coordinator crashed after mutation began");
    const deps = dependencies({
      reserveManagedUpdateResultPath: vi.fn(async () => {
        order.push("reserve-empty");
        return "/private/report.json";
      }),
      saveManagedUpdateResult: vi.fn(async () => {
        order.push("terminal-write");
        return "/private/report.json";
      }),
      runManagedUpdate: vi.fn(async () => {
        order.push("run");
        throw mutationError;
      }),
    });

    await expect(
      executeUpdate({ apply: true, out: "/private/report.json" }, { yes: true }, deps),
    ).rejects.toBe(mutationError);

    expect(order).toEqual(["reserve-empty", "run"]);
    expect(deps.saveManagedUpdateResult).not.toHaveBeenCalled();
  });

  it("rejects saved-plan targeting conflicts before config or lifecycle work", async () => {
    const deps = dependencies();

    await expect(
      executeUpdate({ fromPlan: "plan.json", service: "plex", apply: true }, { yes: true }, deps),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.loadManagedUpdatePlan).not.toHaveBeenCalled();
  });

  it("emits exactly one update.v1 machine document and never prompts", async () => {
    const deps = dependencies();

    await executeUpdate({ apply: true }, { output: "json", yes: true }, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.formatOutput).toHaveBeenCalledOnce();
    expect(deps.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({ schemaVersion: "update.v1" }),
    );
  });

  it("rejects machine mutation without --yes and does not prompt or mutate", async () => {
    const deps = dependencies();

    await expect(executeUpdate({ apply: true }, { output: "yaml" }, deps)).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.runManagedUpdate).not.toHaveBeenCalled();
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
  });

  it("treats --dry-run --apply as a preview plan with no approval or mutation", async () => {
    const deps = dependencies();

    await executeUpdate({ apply: true, out: "/private/dry-run.json" }, { dryRun: true }, deps);

    expect(deps.saveManagedUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: "update-plan.v1" }),
      "/private/dry-run.json",
    );
    expect(deps.saveManagedUpdateResult).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.runManagedUpdate).not.toHaveBeenCalled();
  });

  it("threads compose, env, profile, sidecar, timeout, and env-tool overrides", async () => {
    const deps = dependencies({
      generateManagedUpdatePlan: vi.fn().mockResolvedValue({
        ...managedPlan(),
        composePath: "/override/compose.yml",
        composeProjectName: "override",
      }),
    });

    await executeUpdate(
      {
        apply: true,
        compose: "/override/compose.yml",
        envFile: "/override/.env",
        profile: "media",
        sidecars: false,
        healthTimeout: "90",
      },
      { yes: true, useOp: "/override/op.env" },
      deps,
    );

    expect(deps.applyCliOverrides).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        composePath: "/override/compose.yml",
        envFile: "/override/.env",
        profile: "media",
        noSidecars: true,
      }),
    );
    expect(deps.runManagedUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        healthPoll: expect.objectContaining({ timeoutSeconds: 90 }),
        projectDir: "/override",
        envTool: { tool: "op", envFile: "/override/op.env" },
      }),
      coordinator,
    );
  });

  it("returns lifecycle exit 1 even when recovery was verified", async () => {
    const deps = dependencies({
      runManagedUpdate: vi.fn().mockResolvedValue(managedResult(false)),
    });

    await executeUpdate({ apply: true }, { yes: true }, deps);

    expect(process.exitCode).toBe(1);
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
  });

  it("expands an implicit all-services selection before plan generation", async () => {
    const deps = dependencies({
      resolveServices: vi.fn().mockResolvedValue({ services: [], profiles: ["all"] }),
    });

    await executeUpdate({}, { yes: true }, deps);

    expect(deps.getComposeServices).toHaveBeenCalledOnce();
    expect(deps.generateManagedUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ targetServices: ["plex", "sonarr"] }),
      coordinator,
    );
  });

  it("uses the canonical Compose directory for selection and apply regardless of cwd", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/unrelated/invocation-directory");
    const deps = dependencies();

    try {
      await executeUpdate({ apply: true }, { yes: true }, deps);
    } finally {
      cwd.mockRestore();
    }

    expect(deps.resolveServices).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      "/project/compose.yml",
      "/project",
      expect.any(Object),
    );
    expect(deps.runManagedUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ projectDir: "/project" }),
      coordinator,
    );
  });

  it("rejects a loaded plan whose Compose file is outside the approved project", async () => {
    const outsidePlan = { ...managedPlan(), composePath: "/other/compose.yml" };
    const deps = dependencies({
      loadManagedUpdatePlan: vi.fn().mockResolvedValue(outsidePlan),
    });

    await expect(
      executeUpdate({ fromPlan: "plan.json", apply: true }, { yes: true }, deps),
    ).rejects.toThrow(/does not match the currently approved project/u);

    expect(deps.runManagedUpdate).not.toHaveBeenCalled();
  });

  it("rejects a loaded plan whose approved Compose project name changed", async () => {
    const deps = dependencies({
      loadManagedUpdatePlan: vi.fn().mockResolvedValue({
        ...managedPlan(),
        composeProjectName: "reviewed-project",
      }),
    });

    await expect(
      executeUpdate({ fromPlan: "plan.json", apply: true }, { yes: true }, deps),
    ).rejects.toThrow(/does not match the currently approved project/u);

    expect(deps.runManagedUpdate).not.toHaveBeenCalled();
  });
});

describe("Docker authority fingerprint", () => {
  const success = (stdout: string) => ({
    code: 0,
    stdout,
    stderr: "",
    success: true,
  });

  function runner(endpoint: string, daemonId: string) {
    return vi.fn(async (args: string[], _options?: DockerExecOptions) => {
      if (args[0] === "context" && args[1] === "show") return success("production\n");
      if (args[0] === "context" && args[1] === "inspect") return success(`${endpoint}\n`);
      return success(`${daemonId}\n`);
    });
  }

  it("uses the selected secrets environment and changes with endpoint or daemon identity", async () => {
    const envTool = { tool: "op" as const, envFile: "/private/runtime.env" };
    const firstRunner = runner('"unix:///var/run/docker.sock"', '"daemon-a"');
    const endpointRunner = runner('"tcp://docker.example:2376"', '"daemon-a"');
    const daemonRunner = runner('"unix:///var/run/docker.sock"', '"daemon-b"');
    const noHostOverride = vi.fn().mockResolvedValue("");

    const first = await dockerAuthorityFingerprint(envTool, firstRunner, noHostOverride);
    const changedEndpoint = await dockerAuthorityFingerprint(
      envTool,
      endpointRunner,
      noHostOverride,
    );
    const changedDaemon = await dockerAuthorityFingerprint(envTool, daemonRunner, noHostOverride);

    expect(first).not.toBe(changedEndpoint);
    expect(first).not.toBe(changedDaemon);
    expect(firstRunner).toHaveBeenCalledTimes(3);
    for (const [, options] of firstRunner.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ envTool }));
    }
  });

  it("changes when an environment-injected DOCKER_HOST overrides the selected context", async () => {
    const envTool = { tool: "dotenvx" as const, envFile: "/private/runtime.env" };
    const dockerRunner = runner('"unix:///var/run/docker.sock"', '"daemon-a"');
    const local = await dockerAuthorityFingerprint(
      envTool,
      dockerRunner,
      vi.fn().mockResolvedValue("unix:///var/run/docker.sock"),
    );
    const remote = await dockerAuthorityFingerprint(
      envTool,
      dockerRunner,
      vi.fn().mockResolvedValue("ssh://docker.example"),
    );

    expect(local).not.toBe(remote);
  });
});

describe("Compose project identity", () => {
  it("canonicalizes a regular Compose file and derives one stable project directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-compose-project-"));
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n", "utf8");
    try {
      await expect(resolveComposeProjectIdentity(composePath)).resolves.toEqual({
        composePath,
        projectDir: directory,
        projectName: basename(directory)
          .toLowerCase()
          .replace(/[^a-z0-9-]/gu, ""),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects saved paths containing traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-compose-traversal-"));
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n", "utf8");
    try {
      await expect(
        resolveComposeProjectIdentity(`${directory}/nested/../compose.yml`, {
          requireCanonicalInput: true,
        }),
      ).rejects.toThrow(/absolute and normalized/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links in the reviewed Compose path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-compose-symlink-"));
    const composePath = join(directory, "compose.yml");
    const linkedPath = join(directory, "linked.yml");
    await writeFile(composePath, "services: {}\n", "utf8");
    await symlink(composePath, linkedPath);
    try {
      await expect(
        resolveComposeProjectIdentity(linkedPath, { requireCanonicalInput: true }),
      ).rejects.toThrow(/symbolic link/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
