import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

const commonMocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMocks);
vi.mock("@rfmedia/common", () => commonMocks);

import {
  buildImages,
  checkImageUpdate,
  clearComposeCapabilityCache,
  DockerEvidenceError,
  DockerIdentityError,
  downServices,
  execDocker,
  execDockerCompose,
  filterToolOutput,
  getCanonicalComposeConfigEvidence,
  getCanonicalComposeConfig,
  getConflictRuntimeContainers,
  getConflictRuntimeNetworks,
  getConflictRuntimeVolumes,
  getComposeContainerObservations,
  getComposeConfig,
  getComposeServiceDependencies,
  getComposeServices,
  getContainerStats,
  getDockerComposeVersion,
  getLocalImageDigest,
  getLogs,
  getRemoteImageDigest,
  getRunningContainers,
  getRunningServiceContainerMap,
  imageExists,
  inspectContainerIdentity,
  inspectContainers,
  inspectImageDefaultEnvironment,
  inspectImageDefaultEnvironments,
  isDockerAvailable,
  isImageInUse,
  listContainers,
  pruneImages,
  pruneVolumes,
  probeComposeCapabilities,
  pullImages,
  reconcileService,
  removeImage,
  removeServices,
  recreateServiceWithImage,
  startServices,
  stopServices,
  validateComposeFile,
} from "./docker.js";

const OLD_DIGEST = `sha256:${"a".repeat(64)}`;
const NEW_DIGEST = `sha256:${"b".repeat(64)}`;
const LOCAL_IMAGE_ID = `sha256:${"c".repeat(64)}`;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rfapps-docker-spec-"));
  tempDirs.push(directory);
  return directory;
}

type MockProc = EventEmitter & {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function mockSpawnResult(result: {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  onSpawn?: (command: string, args: string[]) => void;
}): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  childProcessMocks.spawn.mockImplementationOnce((command: string, args: string[]) => {
    result.onSpawn?.(command, args);
    queueMicrotask(() => {
      if (result.stdout !== undefined) proc.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr !== undefined) proc.stderr.emit("data", Buffer.from(result.stderr));
      if (result.error !== undefined) {
        proc.emit("error", result.error);
      } else {
        proc.emit("close", result.code ?? 0);
      }
    });
    return proc;
  });

  return proc;
}

describe("docker command utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    clearComposeCapabilityCache();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("filters tool and runtime noise from command output", () => {
    expect(
      filterToolOutput([
        "",
        "[dotenvx@1.0.0] injecting env",
        "(node:123) Warning: noisy",
        "[INFO] info",
        "[WARN] warn",
        "[ERROR] error",
        "[DEBUG] debug",
        "[op] notice",
        "actual",
      ]),
    ).toEqual(["actual"]);
  });

  it("executes docker commands, wraps env tools, and retries transient SSH failures", async () => {
    mockSpawnResult({ code: 1, stderr: "connection reset by peer" });
    mockSpawnResult({ code: 0, stdout: "ok\n" });
    vi.useFakeTimers();

    const resultPromise = execDocker(["ps"], {
      maxRetries: 2,
      retryDelay: 25,
      envTool: { tool: "dotenvx", envFile: ".env.local" },
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stdout: "ok\n",
      stderr: "",
      success: true,
    });
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      "dotenvx",
      ["run", "-q", "-f", ".env.local", "--", "docker", "ps"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("returns command errors and supports docker compose prefixing", async () => {
    mockSpawnResult({ error: new Error("spawn failed") });
    await expect(execDocker(["version"])).resolves.toMatchObject({
      code: 1,
      stderr: "spawn failed",
      success: false,
    });

    mockSpawnResult({ code: 0, stdout: "compose ok" });
    await expect(execDockerCompose(["version"])).resolves.toMatchObject({
      stdout: "compose ok",
      success: true,
    });
    expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
      "docker",
      ["compose", "version"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("bounds captured stdout and stderr and classifies overflow as failure", async () => {
    const stdoutProc = mockSpawnResult({ code: 0, stdout: "x".repeat(64) });
    await expect(execDocker(["inspect", "large"], { maxStdoutBytes: 16 })).resolves.toEqual({
      code: 1,
      stdout: "x".repeat(16),
      stderr: "Command stdout exceeded capture limit of 16 bytes",
      success: false,
    });
    expect(stdoutProc.kill).toHaveBeenCalledWith("SIGTERM");

    const stderrProc = mockSpawnResult({ code: 0, stdout: "safe", stderr: "y".repeat(64) });
    await expect(execDocker(["inspect", "noisy"], { maxStderrBytes: 16 })).resolves.toEqual({
      code: 1,
      stdout: "safe",
      stderr: "Command stderr exceeded capture limit of 16 bytes",
      success: false,
    });
    expect(stderrProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("hard-bounds a child that ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as MockProc;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    childProcessMocks.spawn.mockReturnValueOnce(proc);

    const resultPromise = execDocker(["inspect", "stuck"], {
      timeout: 5,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(5);
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      code: 1,
      stdout: "",
      stderr: "Command timed out",
      success: false,
    });
  });

  it("forwards parent interruption to the detached Docker process group", async () => {
    const proc = new EventEmitter() as MockProc;
    proc.pid = 424_242;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    childProcessMocks.spawn.mockReturnValueOnce(proc);
    const previousHandlers = new Set(process.listeners("SIGINT"));
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const resultPromise = execDocker(["pull", "example"], { maxRetries: 1 });
      const handler = process
        .listeners("SIGINT")
        .find((candidate) => !previousHandlers.has(candidate));
      expect(handler).toBeDefined();

      handler?.("SIGINT");
      expect(processKill).toHaveBeenCalledWith(-424_242, "SIGINT");

      proc.emit("close", 130);
      await expect(resultPromise).resolves.toMatchObject({ code: 130, success: false });
      await Promise.resolve();

      expect(processKill).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(process.listeners("SIGINT")).not.toContain(handler);
    } finally {
      processKill.mockRestore();
    }
  });

  it("builds common docker and compose command arguments", async () => {
    for (let i = 0; i < 17; i++) mockSpawnResult({ code: 0, stdout: "ok\n" });

    await isDockerAvailable();
    await getDockerComposeVersion();
    await listContainers(true, "json", { timeout: 500 });
    await getContainerStats(["plex"], false);
    await pullImages("compose.yml", ["plex"], { profiles: ["media"] });
    await buildImages("compose.yml", ["plex"], { profiles: ["media"] });
    await startServices("compose.yml", ["plex"], {
      profiles: ["media"],
      noPull: true,
      forceRecreate: true,
    });
    await stopServices("compose.yml", ["plex"], { profiles: ["media"] });
    await downServices("compose.yml", { volumes: true });
    await removeServices("compose.yml", ["plex"], { profiles: ["media"], force: true });
    await pruneImages({ all: true });
    await getLogs("compose.yml", ["plex"], { tail: 10, follow: true, timestamps: true });
    await validateComposeFile("compose.yml", { profiles: ["media"] });
    await getRunningContainers("compose.yml", { profiles: ["media"] });
    await removeImage("plex:latest", { force: true });
    await pruneVolumes({ all: true });
    await imageExists("plex:latest");

    const calls = childProcessMocks.spawn.mock.calls.map((call) => call[1]);
    expect(calls).toContainEqual(["version", "--format", "{{.Server.Version}}"]);
    expect(calls).toContainEqual(["compose", "version", "--short"]);
    expect(calls).toContainEqual(["ps", "-a", "--format", "json"]);
    expect(calls).toContainEqual(["stats", "--format", "json", "plex"]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "pull",
      "plex",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "build",
      "plex",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "up",
      "-d",
      "--remove-orphans",
      "--pull",
      "never",
      "--force-recreate",
      "plex",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "stop",
      "plex",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "down",
      "-v",
      "--remove-orphans",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "rm",
      "-f",
      "plex",
    ]);
    expect(calls).toContainEqual(["image", "prune", "-f", "--all"]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "logs",
      "--tail",
      "10",
      "-f",
      "-t",
      "plex",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "config",
      "--quiet",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "compose.yml",
      "--profile",
      "media",
      "ps",
      "--status",
      "running",
      "--format",
      "{{.Name}}",
    ]);
    expect(calls).toContainEqual(["image", "rm", "-f", "plex:latest"]);
    expect(calls).toContainEqual(["volume", "prune", "-f", "--all"]);
    expect(calls).toContainEqual(["image", "inspect", "plex:latest", "--format", "{{.Id}}"]);
  });

  it("binds pull, start, and running-container Compose calls to explicit pinned options", async () => {
    const pinnedEnvironment = { PATH: "/usr/bin", DOCKER_CONTEXT: "reviewed" };
    const execution = {
      cwd: "/project",
      env: pinnedEnvironment,
      replaceEnv: true,
      envFile: "/project/reviewed.env",
      projectName: "reviewed-project",
      profiles: ["core"],
    };
    for (let i = 0; i < 3; i++) mockSpawnResult({ code: 0, stdout: "ok\n" });

    await pullImages("/project/compose.yml", ["app"], execution);
    await startServices("/project/compose.yml", ["app"], {
      ...execution,
      noPull: true,
    });
    await getRunningContainers("/project/compose.yml", execution);

    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      "docker",
      [
        "compose",
        "-f",
        "/project/compose.yml",
        "--project-name",
        "reviewed-project",
        "--env-file",
        "/project/reviewed.env",
        "--profile",
        "core",
        "pull",
        "app",
      ],
      expect.objectContaining({
        cwd: "/project",
        env: pinnedEnvironment,
        stdio: "pipe",
      }),
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "compose",
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
        "--remove-orphans",
        "--pull",
        "never",
        "app",
      ],
      expect.objectContaining({
        cwd: "/project",
        env: pinnedEnvironment,
        stdio: "pipe",
      }),
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      3,
      "docker",
      [
        "compose",
        "-f",
        "/project/compose.yml",
        "--project-name",
        "reviewed-project",
        "--env-file",
        "/project/reviewed.env",
        "--profile",
        "core",
        "ps",
        "--status",
        "running",
        "--format",
        "{{.Name}}",
      ],
      expect.objectContaining({
        cwd: "/project",
        env: pinnedEnvironment,
        stdio: "pipe",
      }),
    );
  });

  it("parses compose service lists, service/container maps, and compose config JSON", async () => {
    mockSpawnResult({ code: 0, stdout: "[dotenvx] ignore\nplex\nsonarr\n\n" });
    await expect(getComposeServices("compose.yml")).resolves.toEqual(["plex", "sonarr"]);

    mockSpawnResult({ code: 1, stderr: "bad compose" });
    await expect(getComposeServices("compose.yml")).resolves.toEqual([]);

    mockSpawnResult({
      code: 0,
      stdout: "[op] ignore\nplex\trfapps-plex-1\nbad-line\nsonarr\trfapps-sonarr-1\n",
    });
    await expect(getRunningServiceContainerMap("compose.yml")).resolves.toEqual(
      new Map([
        ["plex", "rfapps-plex-1"],
        ["sonarr", "rfapps-sonarr-1"],
      ]),
    );

    mockSpawnResult({ code: 1, stderr: "ps failed" });
    await expect(getRunningServiceContainerMap("compose.yml")).resolves.toBeUndefined();

    mockSpawnResult({ code: 0, stdout: 'noise\n{"services":{"plex":{"image":"plex:latest"}}}' });
    await expect(getComposeConfig("compose.yml")).resolves.toEqual({
      services: { plex: { image: "plex:latest" } },
    });

    mockSpawnResult({ code: 0, stdout: "not-json" });
    await expect(getComposeConfig("compose.yml")).resolves.toBeUndefined();
  });

  it("observes every Compose container from array output with canonical project arguments", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const envFile = join(directory, "reviewed.env");
    await writeFile(composePath, "services: {}\n");
    await writeFile(envFile, "REVIEWED_PROJECT=approved-project\n");
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          ID: "cccccccccccc",
          Name: "project-plex-2",
          Service: "plex",
          State: "running",
          Health: "healthy",
        },
        {
          ID: "aaaaaaaaaaaa",
          Name: "project-sonarr-1",
          Service: "sonarr",
          State: "exited",
          Health: "",
        },
        {
          ID: "bbbbbbbbbbbb",
          Name: "project-plex-1",
          Service: "plex",
          State: "running",
          Health: "starting",
        },
      ]),
    });

    await expect(
      getComposeContainerObservations(composePath, {
        cwd: directory,
        projectName: "approved-project",
        envFile: `${directory}/./reviewed.env`,
        profiles: ["media", "core", "media"],
        envTool: { tool: "dotenvx", envFile: ".env.local" },
      }),
    ).resolves.toEqual([
      {
        containerId: "bbbbbbbbbbbb",
        containerName: "project-plex-1",
        serviceName: "plex",
        state: "running",
        health: "starting",
      },
      {
        containerId: "cccccccccccc",
        containerName: "project-plex-2",
        serviceName: "plex",
        state: "running",
        health: "healthy",
      },
      {
        containerId: "aaaaaaaaaaaa",
        containerName: "project-sonarr-1",
        serviceName: "sonarr",
        state: "exited",
        health: "",
      },
    ]);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "dotenvx",
      [
        "run",
        "-q",
        "-f",
        ".env.local",
        "--",
        "docker",
        "compose",
        "--project-name",
        "approved-project",
        "-f",
        composePath,
        "--env-file",
        envFile,
        "--profile",
        "core",
        "--profile",
        "media",
        "ps",
        "--all",
        "--format",
        "json",
      ],
      expect.objectContaining({ cwd: directory, stdio: "pipe" }),
    );
  });

  it("passes the same plain env file to service discovery and running-container lookup", async () => {
    const envFile = "/project/reviewed.env";
    mockSpawnResult({ stdout: "app\n" });
    await getComposeServices("/project/compose.yml", {
      projectName: "reviewed-project",
      envFile,
    });
    mockSpawnResult({ stdout: "app\treviewed-project-app-1\n" });
    await getRunningServiceContainerMap("/project/compose.yml", {
      projectName: "reviewed-project",
      envFile,
    });

    const calls = childProcessMocks.spawn.mock.calls.map(([, args]) => args);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "/project/compose.yml",
      "--project-name",
      "reviewed-project",
      "--env-file",
      envFile,
      "config",
      "--services",
    ]);
    expect(calls).toContainEqual([
      "compose",
      "-f",
      "/project/compose.yml",
      "--project-name",
      "reviewed-project",
      "--env-file",
      envFile,
      "ps",
      "--status",
      "running",
      "--format",
      "{{.Service}}\t{{.Name}}",
    ]);
  });

  it("accepts JSON-Lines Compose observations and preserves missing services as absence", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    mockSpawnResult({
      stdout: [
        JSON.stringify({
          ID: "222222222222",
          Name: "project-db-1",
          Service: "db",
          State: "created",
          Health: "",
        }),
        JSON.stringify({
          ID: "111111111111",
          Name: "project-app-1",
          Service: "app",
          State: "running",
          Health: "healthy",
        }),
      ].join("\n"),
    });

    const observations = await getComposeContainerObservations(composePath);
    expect(observations.map((entry) => entry.serviceName)).toEqual(["app", "db"]);
    expect(observations.some((entry) => entry.serviceName === "missing")).toBe(false);

    mockSpawnResult({ stdout: "\n" });
    await expect(getComposeContainerObservations(composePath)).resolves.toEqual([]);
  });

  it("rejects malformed, incomplete, and duplicate Compose observation evidence", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");

    mockSpawnResult({ stdout: '{"ID":"not-finished"\n' });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_INVALID",
      message: "Docker Compose returned invalid container observation data",
    });

    mockSpawnResult({
      stdout: JSON.stringify({
        ID: "111111111111",
        Name: "project-app-1",
        Service: "app",
        State: "running",
      }),
    });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_INVALID",
    });

    mockSpawnResult({
      stdout: JSON.stringify([
        {
          ID: "111111111111",
          Name: "project-app-1",
          Service: "app",
          State: "running",
          Health: "",
        },
        {
          ID: "111111111111",
          Name: "project-app-2",
          Service: "app",
          State: "running",
          Health: "",
        },
      ]),
    });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_INVALID",
      message: "Docker Compose returned duplicate container observation data",
    });

    mockSpawnResult({
      stdout: JSON.stringify([
        {
          ID: "111111111111",
          Name: "project-app-1",
          Service: "app",
          State: "running",
          Health: "",
        },
        {
          ID: "222222222222",
          Name: "project-app-1",
          Service: "app",
          State: "running",
          Health: "",
        },
      ]),
    });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_INVALID",
    });
  });

  it("bounds Compose observation bytes, items, and strings with sanitized typed failures", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const overflow = mockSpawnResult({
      stdout: JSON.stringify({
        ID: "111111111111",
        Name: "project-app-1",
        Service: "app",
        State: "running",
        Health: `password=${"x".repeat(256)}`,
      }),
    });
    await expect(
      getComposeContainerObservations(composePath, { maxStdoutBytes: 64 }),
    ).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_TOO_LARGE",
      message: "Docker Compose container observation exceeded the allowed size",
    });
    expect(overflow.kill).toHaveBeenCalledWith("SIGTERM");

    mockSpawnResult({
      stdout: JSON.stringify({
        ID: "111111111111",
        Name: "project-app-1",
        Service: "app",
        State: "running",
        Health: "x".repeat(1025),
      }),
    });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_INVALID",
    });

    const tooMany = Array.from({ length: 4097 }, (_, index) => ({
      ID: index.toString(16).padStart(12, "0"),
      Name: `project-app-${index}`,
      Service: "app",
      State: "running",
      Health: "",
    }));
    mockSpawnResult({ stdout: JSON.stringify(tooMany) });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_TOO_LARGE",
    });

    mockSpawnResult({ code: 1, stderr: "password=must-not-escape" });
    await expect(getComposeContainerObservations(composePath)).rejects.toMatchObject({
      code: "COMPOSE_OBSERVATION_FAILED",
      message: "Unable to observe Docker Compose containers",
    });
  });

  it("rejects hostile Compose observation operands before Docker execution", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");

    await expect(
      getComposeContainerObservations(composePath, { projectName: "--project" }),
    ).rejects.toMatchObject({ code: "UNSAFE_PROJECT_NAME" });
    await expect(
      getComposeContainerObservations(composePath, { profiles: ["media", "--all"] }),
    ).rejects.toMatchObject({ code: "UNSAFE_PROFILE_NAME" });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("strictly projects canonical Compose resources with pinned execution inputs", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const envFile = join(directory, "reviewed.env");
    await writeFile(composePath, "services: {}\n");
    await writeFile(envFile, "SECRET=reviewed\n");
    mockSpawnResult({
      stdout: JSON.stringify({
        name: "reviewed-project",
        services: {
          db: { image: "postgres:17" },
          app: {
            image: "example/app:latest",
            environment: { SECRET: "must-not-leave-adapter" },
            depends_on: { db: { condition: "service_healthy" } },
            ports: [
              {
                target: 8080,
                published: "18080-18082",
                host_ip: "127.0.0.1",
                protocol: "tcp",
                mode: "host",
                name: "ignored",
              },
            ],
            volumes: [
              {
                type: "bind",
                source: "/srv/private",
                target: "/data",
                read_only: true,
                bind: { create_host_path: true },
              },
            ],
            networks: { backend: { aliases: ["app"] } },
            network_mode: "service:db",
          },
        },
        volumes: {
          media: {
            name: "shared-media",
            external: true,
            driver: "local",
            driver_opts: { device: "/srv/media", o: "bind" },
            labels: { secret: "ignored" },
          },
        },
        networks: {
          backend: {
            name: "reviewed_backend",
            driver: "bridge",
            ipam: {
              driver: "default",
              config: [
                { subnet: "10.20.0.0/24", ip_range: "10.20.0.128/25", gateway: "10.20.0.1" },
              ],
            },
          },
        },
        secrets: { ignored: { environment: "SECRET" } },
      }),
    });

    await expect(
      getCanonicalComposeConfig(composePath, {
        cwd: directory,
        env: { RFAPPS_PINNED: "yes" },
        replaceEnv: true,
        projectName: "reviewed-project",
        envFile: `${directory}/./reviewed.env`,
        profiles: ["media", "core", "media"],
        envTool: { tool: "dotenvx", envFile: ".env.tool" },
        timeout: 12_345,
      }),
    ).resolves.toEqual({
      name: "reviewed-project",
      services: {
        app: {
          name: "app",
          image: "example/app:latest",
          depends_on: ["db"],
          ports: [
            {
              target: "8080",
              published: "18080-18082",
              host_ip: "127.0.0.1",
              protocol: "tcp",
              mode: "host",
            },
          ],
          volumes: [
            {
              type: "bind",
              source: "/srv/private",
              target: "/data",
              read_only: true,
            },
          ],
          networks: ["backend"],
          network_mode: "service:db",
        },
        db: {
          name: "db",
          image: "postgres:17",
          depends_on: [],
          ports: [],
          volumes: [],
          networks: [],
        },
      },
      volumes: {
        media: {
          name: "shared-media",
          external: true,
          driver: "local",
          driver_opts: { device: "/srv/media", o: "bind" },
        },
      },
      networks: {
        backend: {
          name: "reviewed_backend",
          external: false,
          driver: "bridge",
          ipam: {
            driver: "default",
            config: [{ subnet: "10.20.0.0/24", ip_range: "10.20.0.128/25" }],
          },
        },
      },
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "dotenvx",
      [
        "run",
        "-q",
        "-f",
        ".env.tool",
        "--",
        "docker",
        "compose",
        "--project-name",
        "reviewed-project",
        "-f",
        composePath,
        "--env-file",
        envFile,
        "--profile",
        "core",
        "--profile",
        "media",
        "config",
        "--format",
        "json",
      ],
      expect.objectContaining({
        cwd: directory,
        env: { RFAPPS_PINNED: "yes" },
        stdio: "pipe",
      }),
    );
  });

  it("does not start Compose or runtime evidence commands after an absolute deadline", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const deadline = Date.now() - 1;

    await expect(
      getCanonicalComposeConfigEvidence(composePath, { deadline }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "compose",
    });
    await expect(getConflictRuntimeContainers({ deadline })).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "containers",
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("accepts schema-valid Compose model keys without prototype pollution", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const payload = JSON.parse(
      '{"name":"project","services":{"constructor":{},"prototype":{},"web":{"depends_on":{"prototype":{}},"networks":{"-net":{}}}},"volumes":{"-cache":{}},"networks":{"-net":{}}}',
    ) as unknown;
    mockSpawnResult({ stdout: JSON.stringify(payload) });

    const config = await getCanonicalComposeConfig(composePath);

    expect(Object.getPrototypeOf(config.services)).toBeNull();
    expect(Object.getPrototypeOf(config.volumes)).toBeNull();
    expect(Object.getPrototypeOf(config.networks)).toBeNull();
    expect(Object.keys(config.services)).toEqual(["constructor", "prototype", "web"]);
    expect(config.services["constructor"]).toMatchObject({ name: "constructor" });
    expect(config.services["prototype"]).toMatchObject({ name: "prototype" });
    expect(config.services["web"]).toMatchObject({
      name: "web",
      depends_on: ["prototype"],
      networks: ["-net"],
    });
    expect(config.volumes["-cache"]).toMatchObject({
      name: "project_-cache",
    });
    expect(config.networks["-net"]).toMatchObject({
      name: "project_-net",
    });
  });

  it.each([
    {
      name: "--help service key",
      services: { "--help": {} },
    },
    {
      name: "value-taking option service key",
      services: { "--project-name": {}, attacker: {} },
    },
    {
      name: "--help dependency reference",
      services: { app: { depends_on: ["--help"] } },
    },
    {
      name: "value-taking option dependency reference",
      services: { app: { depends_on: { "--project-name": {} } } },
    },
    {
      name: "value-taking network-mode dependency reference",
      services: { app: { network_mode: "service:--project-name" } },
    },
  ])("rejects $name before it can become a Compose operand", async ({ services }) => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    mockSpawnResult({
      stdout: JSON.stringify({
        name: "project",
        services,
      }),
    });

    await expect(getCanonicalComposeConfig(composePath)).rejects.toMatchObject({
      code: "COMPOSE_CONFIG_INVALID",
      check: "compose",
    } satisfies Partial<DockerEvidenceError>);
  });

  it("reads running container evidence in bounded inspect batches from actual bindings", async () => {
    const ids = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, "0"));
    const inspectPayload = (batch: readonly string[]) =>
      batch.map((id, index) => ({
        Id: id,
        Name: `/runtime-${id.slice(-4)}`,
        Config: {
          Labels:
            id === ids[0]
              ? {
                  "com.docker.compose.project": "reviewed-project",
                  "com.docker.compose.service": "app",
                  SECRET: "ignored",
                }
              : {},
          Env: ["SECRET=ignored"],
        },
        NetworkSettings: {
          Ports:
            id === ids[0]
              ? {
                  "8080/tcp": [
                    { HostIp: "0.0.0.0", HostPort: "18080" },
                    { HostIp: "::", HostPort: "18080" },
                  ],
                  "9000/udp": null,
                }
              : {},
        },
        Mounts:
          id === ids[0]
            ? [
                {
                  Type: "volume",
                  Name: "shared-media",
                  Source: "/var/lib/docker/volumes/shared-media/_data",
                  Destination: "/data",
                  RW: false,
                  Driver: "local",
                },
              ]
            : [],
        HostConfig: {
          PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "9999" }] },
        },
        batchIndex: index,
      }));
    mockSpawnResult({ stdout: `${ids.join("\n")}\n` });
    mockSpawnResult({ stdout: JSON.stringify(inspectPayload(ids.slice(0, 64))) });
    mockSpawnResult({ stdout: JSON.stringify(inspectPayload(ids.slice(64))) });

    const containers = await getConflictRuntimeContainers({
      cwd: "/reviewed/project",
      env: { RFAPPS_PINNED: "yes" },
      replaceEnv: true,
      timeout: 12_345,
    });

    expect(containers).toHaveLength(65);
    expect(containers[0]).toEqual({
      id: ids[0],
      name: "runtime-0000",
      project: "reviewed-project",
      service: "app",
      ports: [
        {
          kind: "port",
          origin: "runtime",
          containerId: ids[0],
          containerName: "runtime-0000",
          family: "ipv4",
          hostIp: "0.0.0.0",
          protocol: "tcp",
          published: { start: 18080, end: 18080 },
        },
        {
          kind: "port",
          origin: "runtime",
          containerId: ids[0],
          containerName: "runtime-0000",
          family: "ipv6",
          hostIp: "::",
          protocol: "tcp",
          published: { start: 18080, end: 18080 },
        },
      ],
      mounts: [
        {
          type: "volume",
          source: "shared-media",
          target: "/data",
          readOnly: true,
        },
      ],
    });
    expect(childProcessMocks.spawn.mock.calls.map(([, args]) => args)).toEqual([
      ["ps", "--filter", "status=running", "--quiet", "--no-trunc"],
      ["inspect", ...ids.slice(0, 64)],
      ["inspect", ids[64]],
    ]);
    for (const [, , spawnOptions] of childProcessMocks.spawn.mock.calls) {
      expect(spawnOptions).toEqual(
        expect.objectContaining({
          cwd: "/reviewed/project",
          env: { RFAPPS_PINNED: "yes" },
          stdio: "pipe",
        }),
      );
    }
  });

  it("uses one shrinking deadline across inventory and inspect batches", async () => {
    const ids = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, "0"));
    mockSpawnResult({ stdout: `${ids.join("\n")}\n` });
    mockSpawnResult({
      stdout: JSON.stringify(
        ids.slice(0, 64).map((id) => ({
          Id: id,
          Name: `/runtime-${id.slice(-4)}`,
          Config: { Labels: {} },
          NetworkSettings: { Ports: {} },
          Mounts: [],
        })),
      ),
    });
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5)
      .mockReturnValue(11);

    await expect(getConflictRuntimeContainers({ timeout: 10 })).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "containers",
    } satisfies Partial<DockerEvidenceError>);
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("omits the empty source from valid tmpfs runtime mounts", async () => {
    const id = "a".repeat(64);
    mockSpawnResult({ stdout: `${id}\n` });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: id,
          Name: "/runtime-worker",
          Config: {
            Labels: {
              "com.docker.compose.project": "project",
              "com.docker.compose.service": ".worker",
            },
          },
          NetworkSettings: { Ports: {} },
          Mounts: [
            {
              Type: "tmpfs",
              Source: "",
              Destination: "/run",
              RW: true,
            },
          ],
        },
      ]),
    });

    await expect(getConflictRuntimeContainers()).resolves.toEqual([
      {
        id,
        name: "runtime-worker",
        project: "project",
        service: ".worker",
        ports: [],
        mounts: [
          {
            type: "tmpfs",
            target: "/run",
            readOnly: false,
          },
        ],
      },
    ]);
  });

  it("strictly reads network and volume projections with exact read-only argv", async () => {
    const networkId = "a".repeat(64);
    mockSpawnResult({ stdout: `${networkId}\n` });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: networkId,
          Name: "shared-network",
          Driver: "bridge",
          Scope: "local",
          Labels: { SECRET: "ignored" },
          IPAM: {
            Driver: "default",
            Config: [{ Subnet: "10.30.0.0/24", Gateway: "10.30.0.1" }, { Subnet: "fd00:30::/64" }],
          },
        },
      ]),
    });
    mockSpawnResult({ stdout: "shared-volume\n" });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Name: "shared-volume",
          Driver: "local",
          Scope: "local",
          Options: { device: "/srv/private", o: "bind" },
          Labels: { SECRET: "ignored" },
          Mountpoint: "/var/lib/docker/volumes/shared-volume/_data",
        },
      ]),
    });

    await expect(
      getConflictRuntimeNetworks({
        envTool: { tool: "dotenvx", envFile: ".env.local" },
        timeout: 12_345,
      }),
    ).resolves.toEqual([
      {
        id: networkId,
        name: "shared-network",
        driver: "bridge",
        subnets: ["10.30.0.0/24", "fd00:30::/64"],
      },
    ]);
    await expect(
      getConflictRuntimeVolumes({
        envTool: { tool: "dotenvx", envFile: ".env.local" },
        timeout: 12_345,
      }),
    ).resolves.toEqual([
      {
        name: "shared-volume",
        driver: "local",
        driverOptions: { device: "/srv/private", o: "bind" },
      },
    ]);
    expect(childProcessMocks.spawn.mock.calls.map(([, args]) => args)).toEqual([
      ["run", "-q", "-f", ".env.local", "--", "docker", "network", "ls", "--quiet", "--no-trunc"],
      ["run", "-q", "-f", ".env.local", "--", "docker", "network", "inspect", networkId],
      ["run", "-q", "-f", ".env.local", "--", "docker", "volume", "ls", "--quiet"],
      ["run", "-q", "-f", ".env.local", "--", "docker", "volume", "inspect", "shared-volume"],
    ]);
  });

  it("preserves reserved driver-option keys in null-prototype records", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const composePayload = JSON.parse(
      '{"name":"project","services":{},"volumes":{"data":{"driver_opts":{"__proto__":"reserved","constructor":"ctor","prototype":"proto"}}}}',
    ) as unknown;
    mockSpawnResult({ stdout: JSON.stringify(composePayload) });

    const config = await getCanonicalComposeConfig(composePath);
    const composeOptions = config.volumes["data"]?.driver_opts;
    if (composeOptions === undefined) throw new Error("missing Compose driver options");
    expect(Object.getPrototypeOf(composeOptions)).toBeNull();
    expect(Object.entries(composeOptions)).toEqual([
      ["__proto__", "reserved"],
      ["constructor", "ctor"],
      ["prototype", "proto"],
    ]);

    mockSpawnResult({ stdout: "shared-volume\n" });
    const runtimePayload = JSON.parse(
      '[{"Name":"shared-volume","Driver":"local","Options":{"__proto__":"reserved","constructor":"ctor","prototype":"proto"}}]',
    ) as unknown;
    mockSpawnResult({ stdout: JSON.stringify(runtimePayload) });

    const [runtimeVolume] = await getConflictRuntimeVolumes();
    if (runtimeVolume === undefined) throw new Error("missing runtime volume");
    expect(Object.getPrototypeOf(runtimeVolume.driverOptions)).toBeNull();
    expect(Object.entries(runtimeVolume.driverOptions)).toEqual([
      ["__proto__", "reserved"],
      ["constructor", "ctor"],
      ["prototype", "proto"],
    ]);
  });

  it("fails closed on duplicate, partial, malformed, and oversized strict evidence", async () => {
    const firstId = "a".repeat(64);
    const secondId = "b".repeat(64);

    mockSpawnResult({ stdout: `${firstId}\n${firstId}\n` });
    await expect(getConflictRuntimeContainers()).rejects.toMatchObject({
      name: "DockerEvidenceError",
      code: "EVIDENCE_MALFORMED",
      check: "containers",
    } satisfies Partial<DockerEvidenceError>);

    mockSpawnResult({ stdout: `${firstId}\n${secondId}\n` });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: firstId,
          Name: "/first",
          Config: { Labels: {} },
          NetworkSettings: { Ports: {} },
          Mounts: [],
        },
      ]),
    });
    await expect(getConflictRuntimeContainers()).rejects.toMatchObject({
      code: "EVIDENCE_INCOMPLETE",
      check: "containers",
    } satisfies Partial<DockerEvidenceError>);

    mockSpawnResult({ stdout: `${firstId}\n` });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: firstId,
          Name: "/partial",
          Config: { Labels: {} },
          NetworkSettings: {},
        },
      ]),
    });
    await expect(getConflictRuntimeContainers()).rejects.toMatchObject({
      code: "EVIDENCE_MALFORMED",
      check: "containers",
    } satisfies Partial<DockerEvidenceError>);

    mockSpawnResult({ stdout: `${firstId}\n` });
    mockSpawnResult({ stdout: "not-json" });
    await expect(getConflictRuntimeNetworks()).rejects.toMatchObject({
      code: "EVIDENCE_MALFORMED",
      check: "networks",
    } satisfies Partial<DockerEvidenceError>);

    const overflow = mockSpawnResult({ stdout: "sensitive-volume-name\n" });
    await expect(getConflictRuntimeVolumes({ maxStdoutBytes: 8 })).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "volumes",
      message: "Docker volume evidence exceeded safety limits",
    } satisfies Partial<DockerEvidenceError>);
    expect(overflow.kill).toHaveBeenCalledWith("SIGTERM");

    const stderrOverflow = mockSpawnResult({ stderr: "sensitive-network-error" });
    await expect(getConflictRuntimeNetworks({ maxStderrBytes: 8 })).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "networks",
      message: "Docker network evidence exceeded safety limits",
    } satisfies Partial<DockerEvidenceError>);
    expect(stderrOverflow.kill).toHaveBeenCalledWith("SIGTERM");

    mockSpawnResult({ code: 1, stderr: "DOCKER_HOST=ssh://secret.example" });
    await expect(getConflictRuntimeNetworks()).rejects.toMatchObject({
      code: "NETWORK_SNAPSHOT_UNAVAILABLE",
      message: "Docker network evidence was unavailable",
    } satisfies Partial<DockerEvidenceError>);
  });

  it("rejects malformed and oversized canonical Compose evidence without leaking payloads", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");

    mockSpawnResult({
      stdout: JSON.stringify({
        name: "project",
        services: {
          app: {
            environment: { SECRET: "must-not-escape" },
            ports: [{ target: 80, protocol: "invalid" }],
          },
        },
      }),
    });
    await expect(getCanonicalComposeConfig(composePath)).rejects.toMatchObject({
      code: "COMPOSE_CONFIG_INVALID",
      check: "compose",
      message: "Compose configuration was malformed",
    } satisfies Partial<DockerEvidenceError>);

    const overflow = mockSpawnResult({
      stdout: JSON.stringify({
        name: "project",
        services: { app: { environment: { SECRET: "must-not-escape" } } },
      }),
    });
    await expect(
      getCanonicalComposeConfig(composePath, { maxStdoutBytes: 32 }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      message: "Compose configuration exceeded safety limits",
    } satisfies Partial<DockerEvidenceError>);
    expect(overflow.kill).toHaveBeenCalledWith("SIGTERM");

    const stderrOverflow = mockSpawnResult({ stderr: "sensitive-compose-error" });
    await expect(
      getCanonicalComposeConfig(composePath, { maxStderrBytes: 8 }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "compose",
      message: "Compose configuration exceeded safety limits",
    } satisfies Partial<DockerEvidenceError>);
    expect(stderrOverflow.kill).toHaveBeenCalledWith("SIGTERM");

    expect(commonMocks.logError).not.toHaveBeenCalledWith(expect.stringContaining("SECRET"));
    expect(commonMocks.logDebug).not.toHaveBeenCalledWith(expect.stringContaining("SECRET"));
  });

  it("does not retain secret-bearing JSON parser errors for Compose or runtime evidence", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const secret = "must-not-escape";

    mockSpawnResult({ stdout: `{"name":"project","services":${secret}}` });
    let composeError: unknown;
    try {
      await getCanonicalComposeConfig(composePath);
    } catch (error) {
      composeError = error;
    }
    expect(composeError).toBeInstanceOf(DockerEvidenceError);
    if (!(composeError instanceof Error)) throw new Error("missing Compose evidence error");
    expect((composeError as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(`${composeError.message}\n${composeError.stack ?? ""}`).not.toContain(secret);

    const id = "a".repeat(64);
    mockSpawnResult({ stdout: `${id}\n` });
    mockSpawnResult({ stdout: `[{"Id":${secret}}]` });
    let runtimeError: unknown;
    try {
      await getConflictRuntimeContainers();
    } catch (error) {
      runtimeError = error;
    }
    expect(runtimeError).toBeInstanceOf(DockerEvidenceError);
    if (!(runtimeError instanceof Error)) throw new Error("missing runtime evidence error");
    expect((runtimeError as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(`${runtimeError.message}\n${runtimeError.stack ?? ""}`).not.toContain(secret);
  });

  it.each(["create", "start"] as const)(
    "executes an exact one-service %s reconciliation action with reviewed authority",
    async (action) => {
      const directory = await makeTempDir();
      const composePath = join(directory, "compose.yml");
      await writeFile(composePath, "services: {}\n");
      mockSpawnResult({ stdout: "started\n" });

      await expect(
        reconcileService(
          {
            composePath,
            projectName: "approved-project",
            service: "plex",
            profiles: ["media", "core", "media"],
            action,
          },
          {
            cwd: directory,
            env: { RFAPPS_TEST: "bounded" },
            timeout: 12_345,
            envTool: { tool: "dotenvx", envFile: ".env.local" },
            captureOutput: false,
            streamOutput: true,
            maxStdoutBytes: 32,
            maxStderrBytes: 48,
          },
        ),
      ).resolves.toMatchObject({ success: true, stdout: "started\n" });

      expect(childProcessMocks.spawn).toHaveBeenCalledWith(
        "dotenvx",
        [
          "run",
          "-q",
          "-f",
          ".env.local",
          "--",
          "docker",
          "compose",
          "--project-name",
          "approved-project",
          "-f",
          composePath,
          "--profile",
          "core",
          "--profile",
          "media",
          "up",
          "-d",
          "--pull",
          "never",
          "--no-build",
          "--no-deps",
          "plex",
        ],
        expect.objectContaining({
          cwd: directory,
          env: expect.objectContaining({ RFAPPS_TEST: "bounded" }),
          stdio: "pipe",
        }),
      );
      const spawnOptions = childProcessMocks.spawn.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(spawnOptions).not.toHaveProperty("shell");
    },
  );

  it("adds force-recreate only to the exact reviewed recreate action", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    mockSpawnResult({ stdout: "recreated\n" });

    await reconcileService({
      composePath,
      projectName: "approved-project",
      service: "plex",
      profiles: ["media"],
      action: "recreate",
    });

    const args = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "compose",
      "--project-name",
      "approved-project",
      "-f",
      composePath,
      "--profile",
      "media",
      "up",
      "-d",
      "--pull",
      "never",
      "--no-build",
      "--no-deps",
      "--force-recreate",
      "plex",
    ]);
    expect(args).not.toContain("--remove-orphans");
    expect(args).not.toContain("pull");
    expect(args).not.toContain("build");
    expect(args).not.toContain("--renew-anon-volumes");
    expect(args).not.toContain("-V");
    expect(args.filter((argument) => argument === "plex")).toHaveLength(1);
    expect(args.at(-1)).toBe("plex");
  });

  it("binds a reviewed plain environment file to the exact Compose action argv", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const envFile = join(directory, ".env.reconcile");
    const nonCanonicalEnvFile = `${directory}/./.env.reconcile`;
    await writeFile(composePath, "services: {}\n");
    await writeFile(envFile, "RFAPPS_RECONCILE_TEST=reviewed\n");
    mockSpawnResult({ stdout: "started\n" });

    await reconcileService({
      composePath,
      projectName: "approved-project",
      service: "plex",
      profiles: ["media"],
      envFile: nonCanonicalEnvFile,
      action: "start",
    });

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "--project-name",
        "approved-project",
        "-f",
        composePath,
        "--env-file",
        envFile,
        "--profile",
        "media",
        "up",
        "-d",
        "--pull",
        "never",
        "--no-build",
        "--no-deps",
        "plex",
      ],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("pins the resolved Compose authority in a private snapshot after source replacement", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const envFile = join(directory, ".env.reconcile");
    const reviewedModel = {
      name: "approved-project",
      services: {
        plex: {
          image: "example/plex:reviewed",
          environment: { API_TOKEN: "reviewed-secret" },
        },
      },
    };
    await writeFile(composePath, "services:\n  plex:\n    image: example/plex:reviewed\n");
    await writeFile(envFile, "API_TOKEN=reviewed-secret\n");

    // Simulate the source paths changing after the resolved model was captured.
    writeFileSync(composePath, "services:\n  plex:\n    image: attacker/replaced:latest\n");
    writeFileSync(envFile, "API_TOKEN=attacker-secret\n");

    let privateSnapshotPath = "";
    mockSpawnResult({
      stdout: "started\n",
      onSpawn(_command, args) {
        const fileIndex = args.indexOf("-f");
        privateSnapshotPath = args[fileIndex + 1] ?? "";
        expect(privateSnapshotPath).not.toBe(composePath);
        expect(args).not.toContain(envFile);
        expect(args).toContain("--project-directory");
        expect(args[args.indexOf("--project-directory") + 1]).toBe(directory);
        expect(JSON.parse(readFileSync(privateSnapshotPath, "utf8"))).toEqual(reviewedModel);
        expect(statSync(privateSnapshotPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(privateSnapshotPath, "..")).mode & 0o777).toBe(0o700);
      },
    });

    await expect(
      reconcileService({
        composePath,
        projectName: "approved-project",
        projectDirectory: directory,
        resolvedComposeJson: JSON.stringify(reviewedModel),
        service: "plex",
        action: "recreate",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(privateSnapshotPath).not.toBe("");
    expect(existsSync(privateSnapshotPath)).toBe(false);
    const args = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args.slice(-8)).toEqual([
      "up",
      "-d",
      "--pull",
      "never",
      "--no-build",
      "--no-deps",
      "--force-recreate",
      "plex",
    ]);
    expect(args).not.toContain("--remove-orphans");
    expect(args).not.toContain("--env-file");
  });

  it("cleans the private authority after Docker failure and sanitizes cleanup failures", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const model = JSON.stringify({ name: "approved-project", services: { plex: {} } });
    await writeFile(composePath, "services: {}\n");
    let failedSnapshotPath = "";
    mockSpawnResult({
      code: 1,
      stderr: "compose failed",
      onSpawn(_command, args) {
        failedSnapshotPath = args[args.indexOf("-f") + 1] ?? "";
      },
    });
    await expect(
      reconcileService({
        composePath,
        projectName: "approved-project",
        projectDirectory: directory,
        resolvedComposeJson: model,
        service: "plex",
        action: "start",
      }),
    ).resolves.toMatchObject({ success: false });
    expect(existsSync(failedSnapshotPath)).toBe(false);

    let retainedDirectory = "";
    mockSpawnResult({ code: 0 });
    await expect(
      reconcileService(
        {
          composePath,
          projectName: "approved-project",
          projectDirectory: directory,
          resolvedComposeJson: model,
          service: "plex",
          action: "start",
        },
        {},
        {
          async removeTemporaryDirectory(path) {
            retainedDirectory = path;
            throw new Error("API_TOKEN=cleanup-secret");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "UNSAFE_COMPOSE_PATH",
      message: "Unable to remove private resolved Compose authority",
    });
    tempDirs.push(retainedDirectory);
  });

  it("rejects an invalid resolved Compose snapshot before Docker execution", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");

    await expect(
      reconcileService({
        composePath,
        projectName: "approved-project",
        projectDirectory: directory,
        resolvedComposeJson: "API_TOKEN=not-json",
        service: "plex",
        action: "start",
      }),
    ).rejects.toMatchObject({
      code: "UNSAFE_COMPOSE_PATH",
      message: "Resolved Compose authority is invalid",
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("bounds reconciliation output and keeps the exact one-target argv on failure", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const proc = mockSpawnResult({ code: 0, stdout: "s".repeat(128) });

    await expect(
      reconcileService(
        {
          composePath,
          projectName: "approved-project",
          service: "plex",
          action: "start",
        },
        { maxStdoutBytes: 16 },
      ),
    ).resolves.toEqual({
      code: 1,
      stdout: "s".repeat(16),
      stderr: "Command stdout exceeded capture limit of 16 bytes",
      success: false,
    });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(childProcessMocks.spawn.mock.calls[0]?.[1]).toEqual([
      "compose",
      "--project-name",
      "approved-project",
      "-f",
      composePath,
      "up",
      "-d",
      "--pull",
      "never",
      "--no-build",
      "--no-deps",
      "plex",
    ]);
  });

  it("enforces the caller's reconciliation timeout", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");
    const proc = new EventEmitter() as MockProc;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    childProcessMocks.spawn.mockReturnValueOnce(proc);

    const resultPromise = reconcileService(
      {
        composePath,
        projectName: "approved-project",
        service: "plex",
        action: "start",
      },
      { timeout: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    proc.emit("close", 143);
    await expect(resultPromise).resolves.toMatchObject({
      code: 1,
      stderr: "Command timed out",
      success: false,
    });
  });

  it("rejects hostile reconciliation operands before Docker execution", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const linkedCompose = join(directory, "compose-link.yml");
    const envFile = join(directory, ".env");
    const linkedEnvFile = join(directory, ".env-link");
    await writeFile(composePath, "services: {}\n");
    await writeFile(envFile, "SAFE=value\n");
    await symlink(composePath, linkedCompose);
    await symlink(envFile, linkedEnvFile);
    const valid = {
      composePath,
      projectName: "approved-project",
      service: "plex",
      action: "start" as const,
    };

    await expect(reconcileService({ ...valid, service: "plex sonarr" })).rejects.toMatchObject({
      code: "UNSAFE_SERVICE_NAME",
    });
    await expect(reconcileService({ ...valid, projectName: "--project" })).rejects.toMatchObject({
      code: "UNSAFE_PROJECT_NAME",
    });
    await expect(
      reconcileService({ ...valid, profiles: ["media", "--all"] }),
    ).rejects.toMatchObject({ code: "UNSAFE_PROFILE_NAME" });
    await expect(reconcileService({ ...valid, action: "pull" as never })).rejects.toMatchObject({
      code: "UNSAFE_RECONCILE_ACTION",
    });
    await expect(reconcileService({ ...valid, composePath: linkedCompose })).rejects.toMatchObject({
      code: "UNSAFE_COMPOSE_PATH",
    });
    await expect(reconcileService({ ...valid, envFile: "" })).rejects.toMatchObject({
      code: "UNSAFE_ENV_FILE",
    });
    await expect(reconcileService({ ...valid, envFile: "unsafe\0.env" })).rejects.toMatchObject({
      code: "UNSAFE_ENV_FILE",
    });
    await expect(reconcileService({ ...valid, envFile: linkedEnvFile })).rejects.toMatchObject({
      code: "UNSAFE_ENV_FILE",
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("extracts compose service dependencies from array and object forms", () => {
    expect(getComposeServiceDependencies()).toEqual([]);
    expect(getComposeServiceDependencies({ name: "plex" })).toEqual([]);
    expect(getComposeServiceDependencies({ name: "app", depends_on: ["db", 1] as never })).toEqual([
      "db",
    ]);
    expect(
      getComposeServiceDependencies({
        name: "app",
        depends_on: { db: { condition: "service_healthy" }, redis: {} },
      }),
    ).toEqual(["db", "redis"]);
  });

  it("checks image usage with container ID filtering and retry fallback", async () => {
    mockSpawnResult({
      code: 0,
      stdout: "[dotenvx] ignore\nabc123def456\nnot-a-container\n",
    });
    await expect(isImageInUse("plex:latest")).resolves.toBe(true);

    vi.useFakeTimers();
    mockSpawnResult({ code: 1, stderr: "daemon busy" });
    mockSpawnResult({ code: 1, stderr: "daemon busy" });
    mockSpawnResult({ code: 1, stderr: "daemon busy" });
    const resultPromise = isImageInUse("plex:latest");
    await vi.advanceTimersByTimeAsync(400);
    await expect(resultPromise).resolves.toBe(false);
    expect(commonMocks.logWarn).toHaveBeenCalledWith(
      "Could not verify image usage for plex:latest, proceeding with removal attempt",
    );
  });

  it("parses container inspection output and handles invalid inspect JSON", async () => {
    const inspect = [{ Name: "/plex", Config: { Image: "plex:latest", Env: [] } }];
    mockSpawnResult({ code: 0, stdout: JSON.stringify(inspect) });
    await expect(inspectContainers(["plex"])).resolves.toEqual(inspect);

    await expect(inspectContainers([])).resolves.toEqual([]);

    mockSpawnResult({ code: 1, stderr: "inspect failed" });
    await expect(inspectContainers(["missing"])).resolves.toBeUndefined();

    mockSpawnResult({ code: 0, stdout: "not-json" });
    await expect(inspectContainers(["bad"])).resolves.toBeUndefined();
  });

  it("resolves local and remote image digests and update status", async () => {
    mockSpawnResult({ code: 0, stdout: "sha256:id\n" });
    mockSpawnResult({
      code: 0,
      stdout: JSON.stringify([
        `registry.example/other@${NEW_DIGEST}`,
        `docker.io/repo/image@${OLD_DIGEST}`,
      ]),
    });
    await expect(getLocalImageDigest("repo/image:latest")).resolves.toBe(
      `docker.io/repo/image@${OLD_DIGEST}`,
    );

    mockSpawnResult({
      code: 0,
      stdout: JSON.stringify({ Descriptor: { digest: NEW_DIGEST } }),
    });
    await expect(getRemoteImageDigest("repo/image:latest")).resolves.toBe(
      `docker.io/repo/image@${NEW_DIGEST}`,
    );

    mockSpawnResult({ code: 0, stdout: "sha256:id\n" });
    mockSpawnResult({
      code: 0,
      stdout: JSON.stringify({ Descriptor: { digest: NEW_DIGEST } }),
    });
    mockSpawnResult({ code: 0, stdout: JSON.stringify([`repo/image@${OLD_DIGEST}`]) });
    await expect(checkImageUpdate("repo/image:latest")).resolves.toEqual({
      hasUpdate: true,
      localDigest: `docker.io/repo/image@${OLD_DIGEST}`,
      remoteDigest: `docker.io/repo/image@${NEW_DIGEST}`,
    });

    mockSpawnResult({ code: 1, stderr: "missing" });
    mockSpawnResult({
      code: 0,
      stdout: JSON.stringify({ Descriptor: { digest: NEW_DIGEST } }),
    });
    await expect(checkImageUpdate("missing:latest")).resolves.toEqual({
      hasUpdate: false,
      error: "Local image not found",
    });
  });

  it("inspects immutable container identity with a repository-matched digest and health", async () => {
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: "container-id",
          Image: LOCAL_IMAGE_ID,
          Config: { Image: "nginx:latest", Env: [] },
          State: {
            Running: true,
            Restarting: false,
            ExitCode: 0,
            Health: { Status: "healthy" },
          },
        },
      ]),
    });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: LOCAL_IMAGE_ID,
          RepoDigests: [
            `example.invalid/nginx@${OLD_DIGEST}`,
            `docker.io/library/nginx@${NEW_DIGEST}`,
          ],
          Os: "linux",
          Architecture: "amd64",
        },
      ]),
    });

    await expect(inspectContainerIdentity("rfapps-nginx-1")).resolves.toEqual({
      containerId: "container-id",
      localImageId: LOCAL_IMAGE_ID,
      configuredImage: "nginx:latest",
      repositoryDigest: `docker.io/library/nginx@${NEW_DIGEST}`,
      platform: "linux/amd64",
      state: "running",
      exitCode: 0,
      health: "healthy",
    });
  });

  it("returns bounded, validated image-default environment evidence", async () => {
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: LOCAL_IMAGE_ID,
          Config: { Env: ["PATH=/usr/bin", "EMPTY=", "VALUE=with=equals"] },
        },
      ]),
    });

    await expect(inspectImageDefaultEnvironment(LOCAL_IMAGE_ID)).resolves.toEqual({
      PATH: "/usr/bin",
      EMPTY: "",
      VALUE: "with=equals",
    });

    mockSpawnResult({
      stdout: JSON.stringify([{ Id: LOCAL_IMAGE_ID, Config: { Env: ["invalid"] } }]),
    });
    await expect(inspectImageDefaultEnvironment(LOCAL_IMAGE_ID)).rejects.toMatchObject({
      code: "IMAGE_INSPECTION_INVALID",
    });
    await expect(inspectImageDefaultEnvironment("not-an-image-id")).rejects.toMatchObject({
      code: "INVALID_IMAGE_IDENTITY",
    });
  });

  it("inspects multiple image environments with one bounded subprocess", async () => {
    const secondImageId = `sha256:${"d".repeat(64)}`;
    mockSpawnResult({
      stdout: JSON.stringify([
        { Id: secondImageId, Config: { Env: ["SECOND=2"] } },
        { Id: LOCAL_IMAGE_ID, Config: { Env: ["FIRST=1"] } },
      ]),
    });

    await expect(inspectImageDefaultEnvironments([LOCAL_IMAGE_ID, secondImageId])).resolves.toEqual(
      new Map([
        [secondImageId, { SECOND: "2" }],
        [LOCAL_IMAGE_ID, { FIRST: "1" }],
      ]),
    );
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", LOCAL_IMAGE_ID, secondImageId],
      expect.any(Object),
    );

    childProcessMocks.spawn.mockClear();
    const oversized = Array.from(
      { length: 257 },
      (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
    );
    await expect(inspectImageDefaultEnvironments(oversized)).rejects.toMatchObject({
      code: "INVALID_IMAGE_IDENTITY",
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("selects the remote manifest digest for the requested platform", async () => {
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Descriptor: {
            digest: OLD_DIGEST,
            platform: { os: "linux", architecture: "amd64" },
          },
        },
        {
          Descriptor: {
            digest: NEW_DIGEST,
            platform: { os: "linux", architecture: "arm64", variant: "v8" },
          },
        },
      ]),
    });

    await expect(
      getRemoteImageDigest("repo/image:latest", { platform: "linux/arm64/v8" }),
    ).resolves.toBe(`docker.io/repo/image@${NEW_DIGEST}`);
  });

  it("rejects a remote manifest when the selected platform has no exact match", async () => {
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Descriptor: {
            digest: OLD_DIGEST,
            platform: { os: "linux", architecture: "arm64", variant: "v8" },
          },
        },
      ]),
    });

    await expect(
      getRemoteImageDigest("repo/image:latest", { platform: "linux/arm64" }),
    ).resolves.toBeUndefined();
  });

  it("bounds registry-controlled manifest output before parsing", async () => {
    const proc = mockSpawnResult({
      code: 0,
      stdout: JSON.stringify({
        Descriptor: { digest: NEW_DIGEST },
        annotations: { attackerControlled: "z".repeat(1024) },
      }),
    });

    await expect(
      getRemoteImageDigest("repo/image:latest", { maxStdoutBytes: 128 }),
    ).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(commonMocks.logDebug).toHaveBeenCalledWith(
      "Failed to get remote image digest for repo/image:latest: Command stdout exceeded capture limit of 128 bytes",
    );
  });

  it("reports a selected-platform mismatch as unsupported update evidence", async () => {
    mockSpawnResult({ code: 0, stdout: "sha256:id\n" });
    mockSpawnResult({
      code: 0,
      stdout: JSON.stringify([
        {
          Descriptor: {
            digest: OLD_DIGEST,
            platform: { os: "linux", architecture: "amd64" },
          },
        },
      ]),
    });
    mockSpawnResult({ code: 0, stdout: JSON.stringify([`repo/image@${OLD_DIGEST}`]) });

    await expect(
      checkImageUpdate("repo/image:latest", { platform: "linux/arm64/v8" }),
    ).resolves.toEqual({
      hasUpdate: false,
      localDigest: `docker.io/repo/image@${OLD_DIGEST}`,
      error: "No matching manifest for the selected platform",
    });
  });

  it("probes and caches Compose update capabilities", async () => {
    mockSpawnResult({ stdout: "2.35.1\n" });
    mockSpawnResult({ stdout: "--wait --wait-timeout\n" });
    mockSpawnResult({ stdout: "--resolve-image-digests --lock-image-digests\n" });

    const first = await probeComposeCapabilities();
    const second = await probeComposeCapabilities();

    expect(first).toEqual({
      status: "supported",
      version: "2.35.1",
      digestResolution: "resolve-image-digests",
      wait: "wait-with-timeout",
    });
    expect(second).toEqual(first);
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(3);
  });

  it("returns an actionable unsupported Compose capability result", async () => {
    mockSpawnResult({ stdout: "2.16.0\n" });
    mockSpawnResult({ stdout: "usage: up\n" });
    mockSpawnResult({ stdout: "usage: config\n" });

    await expect(probeComposeCapabilities()).resolves.toEqual({
      status: "unsupported",
      version: "2.16.0",
      missing: ["config --resolve-image-digests", "up --wait", "up --wait-timeout"],
      message:
        "Managed updates require Docker Compose support for config --resolve-image-digests, up --wait, and up --wait-timeout.",
    });
  });

  it("pulls and recreates one service from the reviewed digest with exact Compose argv", async () => {
    const directory = await makeTempDir();
    const firstCompose = join(directory, "compose.yml");
    const secondCompose = join(directory, "compose.prod.yml");
    await writeFile(firstCompose, "services: {}\n");
    await writeFile(secondCompose, "services: {}\n");

    mockSpawnResult({ stdout: "pulled\n" });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: LOCAL_IMAGE_ID,
          RepoDigests: [`ghcr.io/example/plex@${NEW_DIGEST}`],
          Os: "linux",
          Architecture: "amd64",
        },
      ]),
    });
    mockSpawnResult({ stdout: "started\n" });

    const result = await recreateServiceWithImage({
      composePaths: [firstCompose, secondCompose],
      projectName: "approved-project",
      service: "plex",
      profiles: ["media"],
      source: {
        kind: "repository-digest",
        configuredImage: "ghcr.io/example/plex:latest",
        repositoryDigest: `ghcr.io/example/plex@${NEW_DIGEST}`,
        platform: "linux/amd64",
      },
    });

    expect(result).toMatchObject({ success: true, identity: { localImageId: LOCAL_IMAGE_ID } });
    const calls = childProcessMocks.spawn.mock.calls.map((call) => call[1] as string[]);
    const pullArgs = calls[0] ?? [];
    const overridePath = pullArgs[pullArgs.lastIndexOf("-f") + 1];
    expect(pullArgs).toEqual([
      "compose",
      "--project-name",
      "approved-project",
      "-f",
      firstCompose,
      "-f",
      secondCompose,
      "-f",
      overridePath,
      "--profile",
      "media",
      "pull",
      "plex",
    ]);
    expect(calls[2]).toEqual([
      "compose",
      "--project-name",
      "approved-project",
      "-f",
      firstCompose,
      "-f",
      secondCompose,
      "-f",
      overridePath,
      "--profile",
      "media",
      "up",
      "-d",
      "--force-recreate",
      "--pull",
      "never",
      "plex",
    ]);
    await expect(lstat(overridePath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a successful recreation and returns safe evidence when override cleanup fails", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");

    mockSpawnResult({ stdout: "pulled\n" });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: LOCAL_IMAGE_ID,
          RepoDigests: [`ghcr.io/example/plex@${NEW_DIGEST}`],
          Os: "linux",
          Architecture: "amd64",
        },
      ]),
    });
    mockSpawnResult({ stdout: "started\n" });
    const removeTemporaryDirectory = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValue(new Error("password=must-not-escape"));

    const result = await recreateServiceWithImage(
      {
        composePaths: [composePath],
        service: "plex",
        source: {
          kind: "repository-digest",
          configuredImage: "ghcr.io/example/plex:latest",
          repositoryDigest: `ghcr.io/example/plex@${NEW_DIGEST}`,
        },
      },
      {},
      { removeTemporaryDirectory },
    );

    expect(result).toMatchObject({
      success: true,
      identity: { localImageId: LOCAL_IMAGE_ID },
      cleanup: {
        status: "failed",
        code: "TEMP_OVERRIDE_CLEANUP_FAILED",
        message: "Temporary image override cleanup failed; remove the retained directory manually",
        temporaryDirectory: expect.stringContaining("rfapps-update-"),
      },
    });
    expect(removeTemporaryDirectory).toHaveBeenCalledOnce();
    expect(commonMocks.logWarn).toHaveBeenCalledWith(
      expect.not.stringContaining("password=must-not-escape"),
    );
  });

  it("propagates the environment tool and cleans the override after identity mismatch", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "services: {}\n");

    mockSpawnResult({ stdout: "pulled\n" });
    mockSpawnResult({
      stdout: JSON.stringify([
        {
          Id: LOCAL_IMAGE_ID,
          RepoDigests: [`ghcr.io/example/plex@${OLD_DIGEST}`],
          Os: "linux",
          Architecture: "amd64",
        },
      ]),
    });

    const recreation = recreateServiceWithImage(
      {
        composePaths: [composePath],
        service: "plex",
        source: {
          kind: "repository-digest",
          configuredImage: "ghcr.io/example/plex:latest",
          repositoryDigest: `ghcr.io/example/plex@${NEW_DIGEST}`,
        },
      },
      { envTool: { tool: "dotenvx", envFile: ".env.local" } },
    );

    await expect(recreation).rejects.toMatchObject({
      code: "IMAGE_IDENTITY_MISMATCH",
    } satisfies Partial<DockerIdentityError>);
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      "dotenvx",
      expect.arrayContaining(["docker", "compose", "-f", composePath]),
      expect.objectContaining({ stdio: "pipe" }),
    );
    const pullArgs = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    const overridePath = pullArgs[pullArgs.lastIndexOf("-f") + 1];
    await expect(lstat(overridePath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe service names, digest values, and Compose symlinks before Docker execution", async () => {
    const directory = await makeTempDir();
    const composePath = join(directory, "compose.yml");
    const linkedCompose = join(directory, "compose-link.yml");
    await writeFile(composePath, "services: {}\n");
    await symlink(composePath, linkedCompose);

    const validSource = {
      kind: "repository-digest" as const,
      configuredImage: "ghcr.io/example/plex:latest",
      repositoryDigest: `ghcr.io/example/plex@${NEW_DIGEST}`,
    };

    await expect(
      recreateServiceWithImage({
        composePaths: [composePath],
        service: "--all",
        source: validSource,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_SERVICE_NAME" });
    await expect(
      recreateServiceWithImage({
        composePaths: [composePath],
        service: "plex",
        source: { ...validSource, repositoryDigest: "ghcr.io/example/plex@sha256:short" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE_IDENTITY" });
    await expect(
      recreateServiceWithImage({
        composePaths: [linkedCompose],
        service: "plex",
        source: validSource,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_COMPOSE_PATH" });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});
