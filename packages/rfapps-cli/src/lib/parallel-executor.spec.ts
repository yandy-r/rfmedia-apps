import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerExecResult } from "./docker.js";
import type { ExecutionPhase } from "../types/parallel.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@rfmedia/common", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  runTasks: vi.fn(),
}));

vi.mock("./docker.js", () => ({
  pullImages: vi.fn(),
  stopServices: vi.fn(),
  buildImages: vi.fn(),
  execDockerCompose: vi.fn(),
}));

import { runTasks } from "@rfmedia/common";
import { buildImages, execDockerCompose, pullImages, stopServices } from "./docker.js";
import {
  executeParallelPhases,
  formatExecutionPlan,
  mapDockerOperation,
} from "./parallel-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a successful DockerExecResult */
function successResult(stdout = ""): DockerExecResult {
  return { code: 0, stdout, stderr: "", success: true };
}

/** Create a failed DockerExecResult */
function failedResult(stderr = "command failed"): DockerExecResult {
  return { code: 1, stdout: "", stderr, success: false };
}

/**
 * Configure the runTasks mock to simulate listr2 behavior: it invokes each
 * task's `.task()` callback so that the parallel-executor's side-effects
 * (result collection, title mutation) actually fire.
 *
 * The `resultMap` controls per-service success/failure. Services not in the
 * map default to success. An entry mapped to `null` means the underlying
 * Docker operation should succeed; mapped to a string means it fails with
 * that stderr.
 */
function setupRunTasksMock(resultMap: Record<string, string | null> = {}): void {
  vi.mocked(runTasks).mockImplementation(async (tasks) => {
    for (const task of tasks as Array<{
      title: string;
      task: (ctx: unknown, task: { title: string }) => Promise<void>;
    }>) {
      // Extract service name from task title ("operation service")
      const serviceName = task.title.split(" ").slice(1).join(" ");
      const failStderr = resultMap[serviceName];

      // Configure the Docker mock for this iteration based on the operation in the title
      const operation = task.title.split(" ")[0];
      setupDockerMockForOperation(operation ?? "", serviceName, failStderr);

      try {
        await task.task(undefined, { title: task.title });
      } catch {
        // Simulating exitOnError: false -- swallow the error like listr2 would
      }
    }
  });
}

/**
 * Set up the appropriate Docker mock for a single operation+service pair.
 * `failStderr` being undefined/null means success; a string means failure.
 */
function setupDockerMockForOperation(
  operation: string,
  _service: string,
  failStderr: string | null | undefined,
): void {
  const result =
    failStderr !== undefined && failStderr !== null ? failedResult(failStderr) : successResult();

  switch (operation) {
    case "pull":
      vi.mocked(pullImages).mockResolvedValueOnce(result);
      break;
    case "stop":
      vi.mocked(stopServices).mockResolvedValueOnce(result);
      break;
    case "build":
      vi.mocked(buildImages).mockResolvedValueOnce(result);
      break;
    case "start":
      vi.mocked(execDockerCompose).mockResolvedValueOnce(result);
      break;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeParallelPhases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes all services in a single phase and reports all succeeded", async () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["svc-a", "svc-b", "svc-c", "svc-d", "svc-e"], dependsOn: [] },
    ];

    setupRunTasksMock();

    const result = await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    expect(result.totalServices).toBe(5);
    expect(result.succeeded).toHaveLength(5);
    expect(result.failed).toHaveLength(0);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.succeeded).toEqual(
      expect.arrayContaining(["svc-a", "svc-b", "svc-c", "svc-d", "svc-e"]),
    );
  });

  it("executes phases sequentially (Phase 1 after Phase 0 completes)", async () => {
    const executionOrder: string[] = [];

    vi.mocked(runTasks).mockImplementation(async (tasks) => {
      for (const task of tasks as Array<{
        title: string;
        task: (ctx: unknown, task: { title: string }) => Promise<void>;
      }>) {
        const serviceName = task.title.split(" ").slice(1).join(" ");
        const operation = task.title.split(" ")[0];

        setupDockerMockForOperation(operation ?? "", serviceName, null);

        try {
          await task.task(undefined, { title: task.title });
        } catch {
          // exitOnError: false
        }
        executionOrder.push(serviceName);
      }
    });

    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["db", "cache", "redis"], dependsOn: [] },
      { phase: 1, services: ["app", "worker"], dependsOn: ["db", "cache", "redis"] },
    ];

    await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    // Phase 0 services must all appear before Phase 1 services
    const dbIdx = executionOrder.indexOf("db");
    const cacheIdx = executionOrder.indexOf("cache");
    const redisIdx = executionOrder.indexOf("redis");
    const appIdx = executionOrder.indexOf("app");
    const workerIdx = executionOrder.indexOf("worker");

    expect(dbIdx).toBeLessThan(appIdx);
    expect(cacheIdx).toBeLessThan(appIdx);
    expect(redisIdx).toBeLessThan(appIdx);
    expect(dbIdx).toBeLessThan(workerIdx);
    expect(cacheIdx).toBeLessThan(workerIdx);
    expect(redisIdx).toBeLessThan(workerIdx);
  });

  it("passes workers count as concurrent option to runTasks", async () => {
    const services = Array.from({ length: 10 }, (_, i) => `svc-${i}`);
    const phases: ExecutionPhase[] = [{ phase: 0, services, dependsOn: [] }];

    setupRunTasksMock();

    await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 2,
    });

    expect(runTasks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ concurrent: 2 }),
    );
  });

  it("handles partial failure: 2 succeeded, 1 failed, subsequent phases still execute", async () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["ok-a", "fail-b", "ok-c"], dependsOn: [] },
      { phase: 1, services: ["after-svc"], dependsOn: [] },
    ];

    setupRunTasksMock({ "fail-b": "pull error for fail-b" });

    const result = await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    // Phase 0: 2 succeeded, 1 failed
    expect(result.phases[0]?.succeeded).toEqual(expect.arrayContaining(["ok-a", "ok-c"]));
    expect(result.phases[0]?.failed).toHaveLength(1);
    expect(result.phases[0]?.failed[0]?.name).toBe("fail-b");

    // Phase 1 still executed
    expect(result.phases).toHaveLength(2);
    expect(result.phases[1]?.succeeded).toContain("after-svc");

    // Aggregated
    expect(result.succeeded).toHaveLength(3);
    expect(result.failed).toHaveLength(1);
  });

  it("handles all failures in a phase and still attempts the next phase", async () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["fail-1", "fail-2", "fail-3"], dependsOn: [] },
      { phase: 1, services: ["next-svc"], dependsOn: [] },
    ];

    setupRunTasksMock({
      "fail-1": "error-1",
      "fail-2": "error-2",
      "fail-3": "error-3",
    });

    const result = await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    expect(result.phases[0]?.succeeded).toHaveLength(0);
    expect(result.phases[0]?.failed).toHaveLength(3);

    // Phase 1 still attempted (next-svc has no dependsOn pointing to failed services)
    expect(result.phases).toHaveLength(2);
    expect(result.phases[1]?.succeeded).toContain("next-svc");
  });

  it("skips empty phases", async () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: [], dependsOn: [] },
      { phase: 1, services: ["real-svc"], dependsOn: [] },
    ];

    setupRunTasksMock();

    const result = await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    // The empty Phase 0 should be skipped entirely
    // runTasks should only have been called once (for Phase 1)
    expect(runTasks).toHaveBeenCalledTimes(1);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.succeeded).toContain("real-svc");
  });

  it("propagates forceRecreate to start operations", async () => {
    const phases: ExecutionPhase[] = [{ phase: 0, services: ["plex"], dependsOn: [] }];

    setupRunTasksMock();

    await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "start",
      workers: 4,
      forceRecreate: true,
    });

    // The start operation uses execDockerCompose directly
    expect(execDockerCompose).toHaveBeenCalledWith(
      expect.arrayContaining(["--force-recreate"]),
      expect.objectContaining({ streamOutput: false }),
    );
  });

  it("threads one pinned Compose execution binding through phase services", async () => {
    const phases: ExecutionPhase[] = [{ phase: 0, services: ["app"], dependsOn: [] }];
    const pinnedEnvironment = { PATH: "/usr/bin", DOCKER_CONTEXT: "reviewed" };
    setupRunTasksMock();

    await executeParallelPhases({
      phases,
      composePath: "/project/compose.yml",
      operation: "pull",
      workers: 1,
      cwd: "/project",
      env: pinnedEnvironment,
      replaceEnv: true,
      envFile: "/project/reviewed.env",
      projectName: "reviewed-project",
      profiles: ["core"],
    });

    expect(pullImages).toHaveBeenCalledWith("/project/compose.yml", ["app"], {
      streamOutput: false,
      profiles: ["core"],
      envTool: undefined,
      cwd: "/project",
      env: pinnedEnvironment,
      replaceEnv: true,
      envFile: "/project/reviewed.env",
      projectName: "reviewed-project",
    });
  });

  it("skips dependent services when a dependency failed in a prior phase", async () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["db", "cache"], dependsOn: [] },
      { phase: 1, services: ["app", "worker"], dependsOn: ["db", "cache"] },
    ];

    // db fails in Phase 0
    setupRunTasksMock({ db: "db connection timeout" });

    const result = await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    // Phase 0: db failed, cache succeeded
    expect(result.phases[0]?.succeeded).toEqual(["cache"]);
    expect(result.phases[0]?.failed).toHaveLength(1);

    // Phase 1: both app and worker depend on Phase 0 (which includes db), so
    // both should be skipped because the dependsOn list for Phase 1 includes "db"
    // and db is in the failed set
    expect(result.phases[1]?.failed).toHaveLength(2);
    expect(result.phases[1]?.failed.map((f) => f.name)).toEqual(
      expect.arrayContaining(["app", "worker"]),
    );
    expect(result.phases[1]?.failed[0]?.error).toContain("dependency failed");
    expect(result.phases[1]?.succeeded).toHaveLength(0);
  });

  it("with dependencyMap skips only services whose own dependencies failed (per-service)", async () => {
    // Phase 0: db, cache. Phase 1: app (depends on db), worker (depends on cache).
    // db fails, cache succeeds. With per-service deps only app should be skipped.
    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["db", "cache"], dependsOn: [] },
      { phase: 1, services: ["app", "worker"], dependsOn: ["db", "cache"] },
    ];
    const dependencyMap = new Map<string, string[]>([
      ["db", []],
      ["cache", []],
      ["app", ["db"]],
      ["worker", ["cache"]],
    ]);

    setupRunTasksMock({ db: "db connection timeout" });

    const result = await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
      dependencyMap,
    });

    // Phase 0: db failed, cache succeeded
    expect(result.phases[0]?.succeeded).toEqual(["cache"]);
    expect(result.phases[0]?.failed).toHaveLength(1);

    // Phase 1: app depends on db (failed) -> skipped; worker depends on cache (succeeded) -> runs
    expect(result.phases[1]?.failed).toHaveLength(1);
    expect(result.phases[1]?.failed[0]?.name).toBe("app");
    expect(result.phases[1]?.failed[0]?.error).toContain("dependency failed");
    expect(result.phases[1]?.succeeded).toHaveLength(1);
    expect(result.phases[1]?.succeeded[0]).toBe("worker");
  });

  it("passes exitOnError: false to runTasks for allSettled semantics", async () => {
    const phases: ExecutionPhase[] = [{ phase: 0, services: ["svc-a"], dependsOn: [] }];

    setupRunTasksMock();

    await executeParallelPhases({
      phases,
      composePath: "compose.yml",
      operation: "pull",
      workers: 4,
    });

    expect(runTasks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ exitOnError: false }),
    );
  });
});

describe("formatExecutionPlan", () => {
  it("returns formatted string showing phases, services, and worker count", () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: ["plex-ts", "sonarr", "radarr"], dependsOn: [] },
      { phase: 1, services: ["plex", "authentik-server"], dependsOn: ["plex-ts"] },
    ];

    const output = formatExecutionPlan(phases, 4);

    expect(output).toContain("Parallel Execution Plan (workers: 4)");
    expect(output).toContain("Phase 0: 3 services");
    expect(output).toContain("no dependencies");
    expect(output).toContain("plex-ts");
    expect(output).toContain("sonarr");
    expect(output).toContain("radarr");
    expect(output).toContain("Phase 1: 2 services");
    expect(output).toContain("depends on Phase 0");
    expect(output).toContain("plex");
    expect(output).toContain("authentik-server");
    expect(output).toContain("Total: 5 services across 2 phases");
  });

  it("truncates long service lists with ellipsis", () => {
    const manyServices = Array.from({ length: 12 }, (_, i) => `svc-${String(i).padStart(2, "0")}`);
    const phases: ExecutionPhase[] = [{ phase: 0, services: manyServices, dependsOn: [] }];

    const output = formatExecutionPlan(phases, 4);

    // Should show first 8 and a "+N more" suffix
    expect(output).toContain("svc-00");
    expect(output).toContain("svc-07");
    expect(output).toContain("(+4 more)");
  });

  it("shows effective concurrency per phase", () => {
    const phases: ExecutionPhase[] = [{ phase: 0, services: ["a", "b"], dependsOn: [] }];

    // Workers = 8 but only 2 services, so effective concurrency is 2
    const output = formatExecutionPlan(phases, 8);

    expect(output).toContain("[concurrency: 2]");
  });

  it("skips empty phases in the output", () => {
    const phases: ExecutionPhase[] = [
      { phase: 0, services: [], dependsOn: [] },
      { phase: 1, services: ["app"], dependsOn: [] },
    ];

    const output = formatExecutionPlan(phases, 4);

    // Phase 0 has no services, so it should not have its own "Phase 0:" line
    expect(output).not.toMatch(/^\s+Phase 0:/m);
    expect(output).toContain("Phase 1: 1 service");
    expect(output).toContain("Total: 1 services across 2 phases");
  });
});

describe("mapDockerOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps 'pull' to pullImages with streamOutput: false", async () => {
    vi.mocked(pullImages).mockResolvedValue(successResult());

    await mapDockerOperation("pull", "compose.yml", ["svc-a"]);

    expect(pullImages).toHaveBeenCalledWith(
      "compose.yml",
      ["svc-a"],
      expect.objectContaining({ streamOutput: false }),
    );
  });

  it("maps 'stop' to stopServices with streamOutput: false", async () => {
    vi.mocked(stopServices).mockResolvedValue(successResult());

    await mapDockerOperation("stop", "compose.yml", ["svc-a"]);

    expect(stopServices).toHaveBeenCalledWith(
      "compose.yml",
      ["svc-a"],
      expect.objectContaining({ streamOutput: false }),
    );
  });

  it("maps 'build' to buildImages with streamOutput: false", async () => {
    vi.mocked(buildImages).mockResolvedValue(successResult());

    await mapDockerOperation("build", "compose.yml", ["svc-a"]);

    expect(buildImages).toHaveBeenCalledWith(
      "compose.yml",
      ["svc-a"],
      expect.objectContaining({ streamOutput: false }),
    );
  });

  it("maps 'start' to execDockerCompose with 'up -d' args and streamOutput: false", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"]);

    expect(execDockerCompose).toHaveBeenCalledWith(
      expect.arrayContaining(["-f", "compose.yml", "up", "-d", "svc-a"]),
      expect.objectContaining({ streamOutput: false }),
    );
  });

  it("does NOT include --remove-orphans for 'start' operations", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"]);

    const callArgs = vi.mocked(execDockerCompose).mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--remove-orphans");
  });

  it("includes --force-recreate for 'start' when forceRecreate is true", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"], {
      forceRecreate: true,
    });

    const callArgs = vi.mocked(execDockerCompose).mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain("--force-recreate");
  });

  it("does not include --force-recreate when forceRecreate is undefined", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"]);

    const callArgs = vi.mocked(execDockerCompose).mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--force-recreate");
  });

  it("includes --pull never for 'start' when noPull is true (pull phase was run)", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"], { noPull: true });

    const callArgs = vi.mocked(execDockerCompose).mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain("--pull");
    expect(callArgs).toContain("never");
  });

  it("does NOT include --pull never for 'start' when noPull is false or undefined (allow pull during up)", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"], { noPull: false });

    const callArgs = vi.mocked(execDockerCompose).mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--pull");
    expect(callArgs).not.toContain("never");
  });

  it("passes profiles through to Docker operations", async () => {
    vi.mocked(pullImages).mockResolvedValue(successResult());

    await mapDockerOperation("pull", "compose.yml", ["svc-a"], {
      profiles: ["core", "media"],
    });

    expect(pullImages).toHaveBeenCalledWith(
      "compose.yml",
      ["svc-a"],
      expect.objectContaining({ profiles: ["core", "media"] }),
    );
  });

  it("passes profiles through for 'start' operations via execDockerCompose args", async () => {
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("start", "compose.yml", ["svc-a"], {
      profiles: ["core"],
    });

    const callArgs = vi.mocked(execDockerCompose).mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain("--profile");
    expect(callArgs).toContain("core");
  });

  it("passes envTool through to Docker operations when provided", async () => {
    vi.mocked(pullImages).mockResolvedValue(successResult());
    const envTool = { tool: "op" as const, envFile: ".env" };

    await mapDockerOperation("pull", "compose.yml", ["svc-a"], { envTool });

    expect(pullImages).toHaveBeenCalledWith(
      "compose.yml",
      ["svc-a"],
      expect.objectContaining({ envTool }),
    );
  });

  it("passes exact pinned identity options and argv through pull and start operations", async () => {
    const pinnedEnvironment = { PATH: "/usr/bin", DOCKER_CONTEXT: "reviewed" };
    const options = {
      cwd: "/project",
      env: pinnedEnvironment,
      replaceEnv: true,
      envFile: "/project/reviewed.env",
      projectName: "reviewed-project",
      profiles: ["core"],
    };
    vi.mocked(pullImages).mockResolvedValue(successResult());
    vi.mocked(execDockerCompose).mockResolvedValue(successResult());

    await mapDockerOperation("pull", "/project/compose.yml", ["app"], options);
    await mapDockerOperation("start", "/project/compose.yml", ["app"], {
      ...options,
      noPull: true,
    });

    expect(pullImages).toHaveBeenCalledWith("/project/compose.yml", ["app"], {
      streamOutput: false,
      profiles: ["core"],
      envTool: undefined,
      cwd: "/project",
      env: pinnedEnvironment,
      replaceEnv: true,
      envFile: "/project/reviewed.env",
      projectName: "reviewed-project",
    });
    expect(execDockerCompose).toHaveBeenCalledWith(
      [
        "-f",
        "/project/compose.yml",
        "--project-name",
        "reviewed-project",
        "--env-file",
        "/project/reviewed.env",
        "--profile",
        "core",
        "up",
        "-d",
        "--pull",
        "never",
        "app",
      ],
      {
        streamOutput: false,
        envTool: undefined,
        cwd: "/project",
        env: pinnedEnvironment,
        replaceEnv: true,
      },
    );
  });
});
