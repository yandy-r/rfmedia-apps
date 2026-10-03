import { dirname } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackupCoordinatorDependencies, RunBackupInput } from "../lib/backup-coordinator.js";
import type { BackupPlannerInput } from "../lib/backup-planner.js";
import type { RfappsConfig } from "../types/config.js";
import type { BackupPlan, BackupResult } from "../types/backup.js";
import { executeBackup, type BackupActionDependencies, type RawBackupOptions } from "./backup.js";

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
    state: { enabled: true },
    parallel: { enabled: false, workers: 2 },
  };
}

function plannerInput(): BackupPlannerInput {
  return {
    composeEvidence: {
      config: {
        name: "project",
        services: {},
        volumes: {},
        networks: {},
      },
      resolvedConfigFingerprint: "a".repeat(64),
    },
    requestedServices: ["plex"],
    canonicalDestination: "/backups",
    dockerAuthorityFingerprint: "b".repeat(64),
    localDockerAuthority: true,
  };
}

function plan(): BackupPlan {
  return {
    requestedServices: ["plex"],
    resolvedServices: ["plex"],
    quiescedServices: ["plex"],
    recoveryLayers: [["plex"]],
    mounts: [],
    skipped: [],
    warnings: [],
    resolvedConfigSha256: "a".repeat(64),
    dockerAuthorityFingerprint: "b".repeat(64),
    bindTopologyFingerprint: "d".repeat(64),
    canonicalDestination: "/backups",
  };
}

function result(dryRun: boolean, success = true): BackupResult {
  const base = {
    schemaVersion: "rfapps-backup-result.v1" as const,
    operation: "backup" as const,
    backupId: dryRun ? "preview" : "backup",
    startedAt: "2026-07-29T00:00:00.000Z",
    completedAt: "2026-07-29T00:00:01.000Z",
    requestedServices: ["plex"],
    resolvedServices: ["plex"],
    writerServices: ["plex"],
    previouslyRunningContainerIds: [],
    destinationPath: "/backups",
    planned: [],
    skipped: [],
    artifacts: [],
    warnings: [],
    summary: {
      requestedServices: 1,
      resolvedServices: 1,
      writerServices: 1,
      previouslyRunningContainers: 0,
      plannedArtifacts: 0,
      archivedArtifacts: 0,
      skippedSources: 0,
      failedArtifacts: 0,
      recoveryFailures: 0,
    },
  };
  if (dryRun) {
    return {
      ...base,
      status: "planned",
      success: true,
      exitCode: 0,
      dryRun: true,
      errors: [],
      recoveryFailures: [],
      stagingDisposition: "none",
    };
  }
  if (!success) {
    const failure = {
      kind: "operational" as const,
      stage: "archive" as const,
      code: "ARCHIVE_FAILED",
      message: "Backup failed during archive",
    };
    return {
      ...base,
      status: "failed",
      success: false,
      exitCode: 1,
      dryRun: false,
      errors: [failure],
      primaryFailure: failure,
      recoveryFailures: [],
      stagingDisposition: "removed",
    };
  }
  return {
    ...base,
    status: "succeeded",
    success: true,
    exitCode: 0,
    dryRun: false,
    bundlePath: "/backups/bundle",
    manifestPath: "/backups/bundle/manifest.json",
    errors: [],
    recoveryFailures: [],
    stagingDisposition: "published",
  };
}

function dependencies(overrides: Partial<BackupActionDependencies> = {}): BackupActionDependencies {
  const input = plannerInput();
  const planning = plan();
  const coordinatorDependencies = {
    plan: vi.fn(async () => planning),
  } as unknown as BackupCoordinatorDependencies;
  const deps: BackupActionDependencies = {
    loadConfig: vi.fn(async () => config()),
    applyCliOverrides: vi.fn((loaded) => loaded),
    resolveServices: vi.fn(async () => ({ services: ["plex"], profiles: ["media"] })),
    getComposeServices: vi.fn(async () => ["plex", "sonarr"]),
    resolveProjectIdentity: vi.fn(async (composePath) => ({
      composePath,
      projectDir: dirname(composePath),
      projectName: "project",
    })),
    captureEnvironment: vi.fn(async () => ({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    })),
    loadPlannerInput: vi.fn(async (_context, requestedServices, _destination, localAuthority) => ({
      ...input,
      requestedServices,
      localDockerAuthority: localAuthority,
    })),
    classifyDockerAuthority: vi.fn(async () => true),
    preparePlanningHelper: vi.fn(async () => ({
      reference:
        "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1" as const,
      resolvedImageId: `sha256:${"c".repeat(64)}`,
    })),
    createCoordinatorDependencies: vi.fn((_context, getPlanningHelper) => ({
      ...coordinatorDependencies,
      plan: vi.fn(async (planner) => {
        await getPlanningHelper();
        return coordinatorDependencies.plan(planner);
      }),
    })),
    runBackup: vi.fn(async (runInput: RunBackupInput, runDeps) => {
      await runDeps.plan(runInput.plannerInput);
      return result(runInput.dryRun);
    }),
    confirm: vi.fn(async () => true),
    formatOutput: vi.fn(async () => undefined),
    now: vi.fn(() => new Date("2026-07-29T00:00:00.000Z")),
    reraiseSignal: vi.fn(),
  };
  return { ...deps, ...overrides };
}

describe("executeBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("runs a zero-confirmation dry-run and emits one versioned machine document", async () => {
    const deps = dependencies();

    await executeBackup(
      { all: true, destination: "/backups" },
      { dryRun: true, output: "json", yes: true },
      deps,
    );

    expect(deps.preparePlanningHelper).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(deps.runBackup).toHaveBeenCalledOnce();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.formatOutput).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.formatOutput).mock.calls[0]?.[1]).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      dryRun: true,
    });
  });

  it("shows one cached full plan, confirms once, and emits only the real result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies();

    await executeBackup({ service: "plex", destination: "/backups" }, { output: "text" }, deps);

    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.runBackup).toHaveBeenCalledTimes(2);
    const coordinator = vi.mocked(deps.createCoordinatorDependencies).mock.results[0]
      ?.value as BackupCoordinatorDependencies;
    expect(coordinator.plan).toHaveBeenCalledOnce();
    expect(deps.formatOutput).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("runs authorized machine creation without prompting and emits one real terminal document", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies();

    await executeBackup(
      { all: true, destination: "/backups" },
      { output: "json", yes: true },
      deps,
    );

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.runBackup).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.runBackup).mock.calls[0]?.[0].reviewedHelper).toBeUndefined();
    expect(vi.mocked(deps.runBackup).mock.calls[1]?.[0].reviewedHelper).toEqual({
      reference:
        "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
      resolvedImageId: `sha256:${"c".repeat(64)}`,
    });
    expect(deps.formatOutput).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.formatOutput).mock.calls[0]?.[1]).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "succeeded",
      dryRun: false,
    });
    consoleError.mockRestore();
  });

  it("prepares a first-run helper for the full plan, then returns one declined-approval result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({ confirm: vi.fn(async () => false) });

    await executeBackup({ service: "plex", destination: "/backups" }, { output: "table" }, deps);

    expect(deps.runBackup).toHaveBeenCalledOnce();
    expect(deps.preparePlanningHelper).toHaveBeenCalledOnce();
    expect(deps.preparePlanningHelper).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
    expect(deps.formatOutput).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("Native backup: cancelled");
    expect(process.exitCode).toBe(2);
    consoleError.mockRestore();
  });

  it("materializes explicit --all instead of accepting the resolver's implicit-all sentinel", async () => {
    const deps = dependencies({
      resolveServices: vi.fn(async () => ({ services: [], profiles: ["all"] })),
    });

    await executeBackup(
      { all: true, destination: "/backups" },
      { dryRun: true, output: "text", yes: true },
      deps,
    );

    expect(deps.getComposeServices).toHaveBeenCalledOnce();
    expect(deps.loadPlannerInput).toHaveBeenCalledWith(
      expect.anything(),
      ["plex", "sonarr"],
      "/backups",
      true,
    );
  });

  it.each([true, false])(
    "passes localDockerAuthority=%s to planning without exposing endpoint evidence",
    async (localDockerAuthority) => {
      const deps = dependencies({
        classifyDockerAuthority: vi.fn(async () => localDockerAuthority),
      });

      await executeBackup(
        { service: "plex", destination: "/backups" },
        { dryRun: true, output: "json", yes: true },
        deps,
      );

      expect(deps.classifyDockerAuthority).toHaveBeenCalledOnce();
      expect(deps.loadPlannerInput).toHaveBeenCalledWith(
        expect.anything(),
        ["plex"],
        "/backups",
        localDockerAuthority,
      );
      expect(vi.mocked(deps.runBackup).mock.calls[0]?.[0].plannerInput).toMatchObject({
        localDockerAuthority,
      });
    },
  );

  it("emits one secret-free typed result when initial authority evidence cannot be loaded", async () => {
    const deps = dependencies({
      classifyDockerAuthority: vi.fn(async () => {
        throw new Error("authority token=private-backup-secret");
      }),
    });

    await executeBackup(
      { service: "plex", destination: "/backups" },
      { output: "json", yes: true },
      deps,
    );

    expect(deps.runBackup).not.toHaveBeenCalled();
    expect(deps.formatOutput).toHaveBeenCalledOnce();
    const emitted = vi.mocked(deps.formatOutput).mock.calls[0]?.[1];
    expect(emitted).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "failed",
      success: false,
      dryRun: false,
      exitCode: 2,
      primaryFailure: {
        stage: "validate",
        code: "PLANNER_INPUT_UNAVAILABLE",
      },
      stagingDisposition: "none",
    });
    expect(JSON.stringify(emitted)).not.toContain("private-backup-secret");
  });

  it("pins one effective environment across identity, planning, and execution without leaking it", async () => {
    const originalDockerHost = process.env["DOCKER_HOST"];
    const pinnedEnvironment = {
      PATH: "/usr/bin",
      DOCKER_HOST: "ssh://authority-token@example.test",
      API_TOKEN: "private-backup-secret",
    };
    const deps = dependencies({
      captureEnvironment: vi.fn(async () => pinnedEnvironment),
      resolveProjectIdentity: vi.fn(async (composePath, options) => {
        process.env["DOCKER_HOST"] = "tcp://drifted-authority.example.test:2375";
        expect(options).toMatchObject({ env: pinnedEnvironment, replaceEnv: true });
        return {
          composePath,
          projectDir: dirname(composePath),
          projectName: "project",
        };
      }),
    });

    try {
      await executeBackup(
        { all: true, destination: "/backups" },
        { dryRun: true, output: "json", yes: true },
        deps,
      );
    } finally {
      if (originalDockerHost === undefined) delete process.env["DOCKER_HOST"];
      else process.env["DOCKER_HOST"] = originalDockerHost;
    }

    expect(deps.captureEnvironment).toHaveBeenCalledOnce();
    expect(deps.getComposeServices).toHaveBeenCalledWith(
      "/project/compose.yml",
      expect.objectContaining({ env: pinnedEnvironment, replaceEnv: true }),
    );
    expect(deps.createCoordinatorDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ env: pinnedEnvironment, replaceEnv: true }),
      expect.any(Function),
      expect.anything(),
    );
    const emitted = vi.mocked(deps.formatOutput).mock.calls[0]?.[1];
    expect(JSON.stringify(emitted)).not.toContain("private-backup-secret");
    expect(JSON.stringify(emitted)).not.toContain("authority-token");
    expect(JSON.stringify(emitted)).not.toContain("drifted-authority");
  });

  it("emits terminal interruption evidence before removing handlers and re-raising the signal", async () => {
    const events: string[] = [];
    const deps = dependencies({
      runBackup: vi
        .fn()
        .mockImplementationOnce(async () => result(true))
        .mockImplementationOnce(async () => {
          process.emit("SIGTERM", "SIGTERM");
          return result(false);
        }),
      formatOutput: vi.fn(async (_format, terminal) => {
        events.push(`output:${terminal.status}`);
      }),
      reraiseSignal: vi.fn((signal) => {
        events.push(`reraise:${signal}`);
      }),
    });

    await executeBackup(
      { all: true, destination: "/backups" },
      { output: "json", yes: true },
      deps,
    );

    expect(events).toEqual(["output:cancelled", "reraise:SIGTERM"]);
    expect(vi.mocked(deps.formatOutput).mock.calls[0]?.[1]).toMatchObject({
      status: "cancelled",
      success: false,
      stagingDisposition: "published",
      exitCode: 2,
    });
  });

  it("emits a stable zero-mutation dry-run failure when inspect-only helper preparation fails", async () => {
    const failure = {
      kind: "operational" as const,
      stage: "validate" as const,
      code: "SOURCE_PROBE_FAILED",
      message: "Backup failed during validate",
    };
    const preview = result(true);
    if (preview.status !== "planned") throw new Error("Expected a dry-run fixture");
    const failed: BackupResult = {
      ...preview,
      status: "failed" as const,
      success: false as const,
      exitCode: 2 as const,
      errors: [failure] as [typeof failure],
      primaryFailure: failure,
    };
    const deps = dependencies({
      preparePlanningHelper: vi.fn(async () => {
        throw new Error("helper absent");
      }),
      runBackup: vi.fn(async (runInput, runDependencies) => {
        try {
          await runDependencies.plan(runInput.plannerInput);
        } catch {
          return failed;
        }
        throw new Error("Expected planning to fail");
      }),
    });

    await executeBackup(
      { service: "plex", destination: "/backups" },
      { dryRun: true, output: "json", yes: true },
      deps,
    );

    expect(deps.runBackup).toHaveBeenCalledOnce();
    expect(deps.preparePlanningHelper).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.formatOutput).toHaveBeenCalledWith("json", failed);
  });
});
