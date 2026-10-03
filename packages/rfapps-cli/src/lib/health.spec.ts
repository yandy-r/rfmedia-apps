import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";

import type { ComposeServiceConfig, ContainerInspect } from "./docker.js";
import type { DependencyReadinessSummary, TargetServiceObservation } from "../types/health.js";

vi.mock("./docker.js", () => ({
  getComposeConfig: vi.fn(),
  getComposeServiceDependencies: vi.fn((service: ComposeServiceConfig | undefined) => {
    if (service?.depends_on === undefined) {
      return [];
    }
    if (Array.isArray(service.depends_on)) {
      return service.depends_on;
    }
    return Object.keys(service.depends_on);
  }),
  getRunningServiceContainerMap: vi.fn(),
  inspectContainers: vi.fn(),
}));

vi.mock("./service-status.js", () => ({
  getServiceStatusMap: vi.fn(),
}));

import { getComposeConfig, getRunningServiceContainerMap, inspectContainers } from "./docker.js";
import { getServiceStatusMap } from "./service-status.js";
import { verifyServiceReadiness, waitForDependencyReadiness } from "./health.js";

function createInspect(
  containerName: string,
  ports: string[],
  options: {
    ip?: string;
    networkMode?: string;
    id?: string;
  } = {},
): ContainerInspect {
  const exposedPorts = Object.fromEntries(ports.map((port) => [port, {}]));
  const networks =
    options.ip === undefined
      ? {}
      : {
          apps: {
            IPAddress: options.ip,
          },
        };
  return {
    Id: options.id ?? `${containerName}-id`,
    Name: `/${containerName}`,
    Image: "image",
    Config: {
      Image: "image",
      Env: [],
      ExposedPorts: exposedPorts,
      Volumes: undefined,
    },
    HostConfig:
      options.networkMode === undefined
        ? {}
        : {
            NetworkMode: options.networkMode,
          },
    NetworkSettings: {
      Networks: networks,
    },
    State: {
      Running: true,
      ExitCode: 0,
    },
  };
}

describe("waitForDependencyReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ready on first attempt when dependency checks pass", async () => {
    const probePort = 15432;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function mockConnect(
      this: net.Socket,
      ..._args: unknown[]
    ): net.Socket {
      queueMicrotask(() => this.emit("connect"));
      return this;
    });

    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: [String(probePort)] },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([
      createInspect("project-db-1", [`${probePort}/tcp`], { ip: "127.0.0.1" }),
    ]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: true,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 3,
      },
    });

    expect(summary.ready).toBe(true);
    expect(summary.timedOut).toBe(false);
    expect(summary.attempts).toBe(1);
    expect(summary.totalDependencies).toBe(1);
    expect(summary.readyDependencies).toEqual(["db"]);
    expect(summary.pendingDependencies).toEqual([]);
    expect(summary.failedDependencies).toEqual([]);
    expect(summary.signalAvailability).toEqual({
      available: true,
      unavailableSignals: [],
    });
  });

  it("uses profiles for profile-gated dependency status reads", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([createInspect("project-db-1", [])]);

    await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      profiles: ["all"],
      waitForReady: false,
      poll: { timeoutSeconds: 5, intervalSeconds: 0, retries: 1 },
    });

    expect(getServiceStatusMap).toHaveBeenCalledWith(
      "compose.yml",
      expect.any(String),
      expect.objectContaining({ profiles: ["all"] }),
    );
  });

  it("uses state and health without probing remote bridge IPs when requested", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: ["5432"] },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([
      createInspect("project-db-1", ["5432/tcp"], { ip: "172.20.0.2" }),
    ]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      tcpProbeMode: "state-and-health-only",
      poll: { timeoutSeconds: 5, intervalSeconds: 0, retries: 1 },
    });

    expect(connect).not.toHaveBeenCalled();
    expect(summary.ready).toBe(true);
    expect(summary.services[0]?.dependencies[0]?.probes).toContainEqual(
      expect.objectContaining({
        type: "tcp-port",
        status: "ready",
        message: expect.stringContaining("state and health only"),
      }),
    );
  });

  it("still fails unhealthy dependencies when TCP probing is disabled", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: ["5432"] },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "unhealthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([
      createInspect("project-db-1", ["5432/tcp"], { ip: "172.20.0.2" }),
    ]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      tcpProbeMode: "state-and-health-only",
      poll: { timeoutSeconds: 5, intervalSeconds: 0, retries: 1 },
    });

    expect(summary.ready).toBe(false);
    expect(summary.failedDependencies).toEqual(["db"]);
  });

  it("retries until readiness transitions from pending to ready", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db" },
      },
    });
    vi.mocked(getServiceStatusMap)
      .mockResolvedValueOnce(new Map([["db", { state: "running", health: "starting" }]]))
      .mockResolvedValueOnce(new Map([["db", { state: "running", health: "healthy" }]]));
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([createInspect("project-db-1", [])]);

    const onProgress = vi.fn();
    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: true,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 3,
      },
      onProgress,
    });

    expect(summary.ready).toBe(true);
    expect(summary.attempts).toBe(2);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getServiceStatusMap)).toHaveBeenCalledTimes(2);
  });

  it("times out when dependencies remain pending", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "starting" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([createInspect("project-db-1", [])]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: true,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 2,
      },
    });

    expect(summary.ready).toBe(false);
    expect(summary.timedOut).toBe(true);
    expect(summary.attempts).toBe(2);
    expect(summary.pendingDependencies).toEqual(["db"]);
    expect(summary.failedDependencies).toEqual([]);
  });

  it("returns snapshot immediately when waitForReady is disabled", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "starting" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([createInspect("project-db-1", [])]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      poll: {
        timeoutSeconds: 30,
        intervalSeconds: 10,
        retries: 10,
      },
    });

    expect(summary.ready).toBe(false);
    expect(summary.timedOut).toBe(false);
    expect(summary.attempts).toBe(1);
    expect(vi.mocked(getServiceStatusMap)).toHaveBeenCalledTimes(1);
  });

  it("classifies mixed dependency states for partial readiness", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db", "cache"] },
        db: { name: "db" },
        cache: { name: "cache" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([
        ["db", { state: "running", health: "healthy" }],
        ["cache", { state: "exited", health: "none" }],
      ]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([createInspect("project-db-1", [])]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 1,
      },
    });

    expect(summary.ready).toBe(false);
    expect(summary.readyDependencies).toEqual(["db"]);
    expect(summary.failedDependencies).toEqual(["cache"]);
    expect(summary.pendingDependencies).toEqual([]);
    expect(summary.services[0]?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependency: "db", status: "ready" }),
        expect.objectContaining({ dependency: "cache", status: "failed" }),
      ]),
    );
  });

  it("classifies TCP probe failures as pending when no endpoint is reachable", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: ["65534"] },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([
      createInspect("project-db-1", ["65534/tcp"], { ip: "127.0.0.1" }),
    ]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 1,
      },
    });

    expect(summary.ready).toBe(false);
    expect(summary.pendingDependencies).toEqual(["db"]);
  });

  it("uses shared-network provider IP when dependency container has no direct IP", async () => {
    const probePort = 25432;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function mockConnect(
      this: net.Socket,
      ..._args: unknown[]
    ): net.Socket {
      queueMicrotask(() => this.emit("connect"));
      return this;
    });

    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: [String(probePort)], network_mode: "service:db-ts" },
        "db-ts": { name: "db-ts" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(
      new Map([
        ["db", "project-db-1"],
        ["db-ts", "project-db-ts-1"],
      ]),
    );
    vi.mocked(inspectContainers).mockResolvedValue([
      createInspect("project-db-1", [`${probePort}/tcp`], {
        networkMode: "container:provider-id",
      }),
      createInspect("project-db-ts-1", [], {
        ip: "127.0.0.1",
        id: "provider-id",
      }),
    ]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 1,
      },
    });

    expect(summary.ready).toBe(true);
    expect(summary.pendingDependencies).toEqual([]);
  });

  it("skips TCP probe with warning when shared-network provider has no IP", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: ["5432"], network_mode: "service:db-ts" },
        "db-ts": { name: "db-ts" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(
      new Map([
        ["db", "project-db-1"],
        ["db-ts", "project-db-ts-1"],
      ]),
    );
    vi.mocked(inspectContainers).mockResolvedValue([
      createInspect("project-db-1", ["5432/tcp"], {
        networkMode: "container:provider-id",
      }),
      createInspect("project-db-ts-1", [], { id: "provider-id" }),
    ]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: true,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 1,
      },
    });

    expect(summary.ready).toBe(true);
    expect(summary.pendingDependencies).toEqual([]);
    expect(summary.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("TCP probe skipped for 'db'")]),
    );
  });

  it("reports structured readiness signal availability when service-container map is unavailable", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db" },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(undefined);
    vi.mocked(inspectContainers).mockResolvedValue([]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 1,
      },
    });

    expect(summary.ready).toBe(true);
    expect(summary.signalAvailability).toEqual({
      available: false,
      unavailableSignals: ["service-container-map"],
    });
  });

  it("reports structured readiness signal availability when container inspect is unavailable", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: { name: "app", depends_on: ["db"] },
        db: { name: "db", expose: ["5432"] },
      },
    });
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["db", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["db", "project-db-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([]);

    const summary = await waitForDependencyReadiness({
      composePath: "compose.yml",
      targetServices: ["app"],
      waitForReady: false,
      poll: {
        timeoutSeconds: 5,
        intervalSeconds: 0,
        retries: 1,
      },
    });

    expect(summary.ready).toBe(false);
    expect(summary.signalAvailability).toEqual({
      available: false,
      unavailableSignals: ["container-inspect"],
    });
    expect(summary.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Unable to inspect running containers")]),
    );
  });
});

function createDependencySummary(ready = true): DependencyReadinessSummary {
  return {
    ready,
    timedOut: false,
    totalDependencies: ready ? 0 : 1,
    readyDependencies: [],
    pendingDependencies: ready ? [] : ["db"],
    failedDependencies: [],
    elapsedMs: 0,
    attempts: 1,
    services: [],
    signalAvailability: { available: true, unavailableSignals: [] },
  };
}

function createTargetObservation(
  overrides: Partial<TargetServiceObservation> = {},
): TargetServiceObservation {
  return {
    imageId: "sha256:expected",
    state: "running",
    exitCode: 0,
    health: "healthy",
    ...overrides,
  };
}

describe("verifyServiceReadiness", () => {
  function createPollingDependencies(
    observations: TargetServiceObservation[],
    dependencySummary = createDependencySummary(),
  ) {
    let currentTime = 0;
    const inspectTarget = vi.fn(async () => observations.shift() ?? createTargetObservation());
    const inspectDependencies = vi.fn(async () => dependencySummary);
    const pollSleep = vi.fn(async (ms: number) => {
      currentTime += ms;
    });

    return {
      dependencies: {
        now: () => currentTime,
        sleep: pollSleep,
        inspectTarget,
        inspectDependencies,
      },
      inspectTarget,
      inspectDependencies,
      pollSleep,
    };
  }

  const baseOptions = {
    composePath: "compose.yml",
    targetService: "app",
    expectedImageId: "sha256:expected",
    poll: { timeoutSeconds: 10, intervalSeconds: 1, retries: 3 },
  };

  it("uses profiles and the plain env file for target and dependency status reads", async () => {
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["app", { state: "running", health: "healthy" }]]),
    );
    vi.mocked(getRunningServiceContainerMap).mockResolvedValue(new Map([["app", "project-app-1"]]));
    vi.mocked(inspectContainers).mockResolvedValue([createInspect("project-app-1", [])]);
    vi.mocked(getComposeConfig).mockResolvedValue({ services: { app: { name: "app" } } });

    await verifyServiceReadiness({
      ...baseOptions,
      expectedImageId: "image",
      profiles: ["all"],
      envFile: "/project/reviewed.env",
      poll: { ...baseOptions.poll, retries: 1 },
    });

    expect(getServiceStatusMap).toHaveBeenCalledWith(
      "compose.yml",
      expect.any(String),
      expect.objectContaining({ profiles: ["all"], envFile: "/project/reviewed.env" }),
    );
    expect(getRunningServiceContainerMap).toHaveBeenCalledWith(
      "compose.yml",
      expect.objectContaining({ profiles: ["all"], envFile: "/project/reviewed.env" }),
    );
    expect(getComposeConfig).toHaveBeenCalledWith(
      "compose.yml",
      expect.objectContaining({ profiles: ["all"], envFile: "/project/reviewed.env" }),
    );
  });

  it("passes a healthy target using the expected local image ID", async () => {
    const polling = createPollingDependencies([createTargetObservation()]);

    const summary = await verifyServiceReadiness(baseOptions, polling.dependencies);

    expect(summary).toMatchObject({
      ready: true,
      timedOut: false,
      assurance: "healthcheck",
      attempts: 1,
      target: {
        status: "ready",
        reason: "ready",
        imageMatches: true,
        imageId: "sha256:expected",
        exitCode: 0,
        health: "healthy",
      },
    });
  });

  it.each([
    {
      name: "unhealthy",
      observation: createTargetObservation({ health: "unhealthy" }),
      status: "failed",
      reason: "health-unhealthy",
    },
    {
      name: "wrong image",
      observation: createTargetObservation({ imageId: "sha256:other" }),
      status: "pending",
      reason: "image-mismatch",
    },
    {
      name: "exited",
      observation: createTargetObservation({ state: "exited", exitCode: 1, health: "none" }),
      status: "failed",
      reason: "exited",
    },
    {
      name: "restarting",
      observation: createTargetObservation({ state: "restarting", health: "none" }),
      status: "pending",
      reason: "restarting",
    },
    {
      name: "non-zero exit evidence",
      observation: createTargetObservation({ exitCode: 1 }),
      status: "failed",
      reason: "exit-code-nonzero",
    },
  ])("rejects a $name target", async ({ observation, status, reason }) => {
    const polling = createPollingDependencies([observation]);

    const summary = await verifyServiceReadiness(
      { ...baseOptions, poll: { ...baseOptions.poll, retries: 1 } },
      polling.dependencies,
    );

    expect(summary.ready).toBe(false);
    expect(summary.timedOut).toBe(true);
    expect(summary.target).toMatchObject({ status, reason });
  });

  it("uses elapsed time as a polling bound", async () => {
    const pending = createTargetObservation({ health: "starting" });
    const polling = createPollingDependencies([pending, pending, pending]);

    const summary = await verifyServiceReadiness(
      { ...baseOptions, poll: { timeoutSeconds: 1, intervalSeconds: 1, retries: 10 } },
      polling.dependencies,
    );

    expect(summary).toMatchObject({ ready: false, timedOut: true, attempts: 2, elapsedMs: 1000 });
    expect(polling.pollSleep).toHaveBeenCalledTimes(1);
  });

  it("does not accept a leaf target from dependency evidence alone", async () => {
    const polling = createPollingDependencies([
      createTargetObservation({ imageId: "sha256:other" }),
    ]);

    const summary = await verifyServiceReadiness(
      { ...baseOptions, poll: { ...baseOptions.poll, retries: 1 } },
      polling.dependencies,
    );

    expect(summary.dependencies).toMatchObject({ ready: true, totalDependencies: 0 });
    expect(summary.ready).toBe(false);
    expect(summary.target.reason).toBe("image-mismatch");
  });

  it("requires supplementary dependency readiness", async () => {
    const polling = createPollingDependencies(
      [createTargetObservation()],
      createDependencySummary(false),
    );

    const summary = await verifyServiceReadiness(
      { ...baseOptions, poll: { ...baseOptions.poll, retries: 1 } },
      polling.dependencies,
    );

    expect(summary.target.status).toBe("ready");
    expect(summary.dependencies.ready).toBe(false);
    expect(summary.ready).toBe(false);
  });

  it("requires a bounded stable-running window when no healthcheck exists", async () => {
    const runningOnly = createTargetObservation({ health: "none" });
    const polling = createPollingDependencies([runningOnly, runningOnly, runningOnly]);
    const onProgress = vi.fn();

    const summary = await verifyServiceReadiness(
      { ...baseOptions, stableRunningSeconds: 2, onProgress },
      polling.dependencies,
    );

    expect(summary).toMatchObject({
      ready: true,
      assurance: "running-only",
      attempts: 3,
      elapsedMs: 2000,
      target: { status: "ready", reason: "ready", stableForMs: 2000 },
    });
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ target: expect.objectContaining({ reason: "stabilizing" }) }),
    );
  });
});
