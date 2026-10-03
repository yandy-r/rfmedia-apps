import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StagedExecutionContext } from "../types/staged.js";

import type { ContainerInspect } from "./docker.js";
import { getComposeContainerObservations, inspectContainers } from "./docker.js";
import { getServiceStatusMap } from "./service-status.js";
import type { StagedBatchObservation, StagedServiceObservation } from "./staged-gate.js";
import { createBatchObserver, waitForBatchReady } from "./staged-gate.js";

vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    getComposeContainerObservations: vi.fn(),
    inspectContainers: vi.fn(),
  };
});

vi.mock("./service-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-status.js")>();
  return { ...actual, getServiceStatusMap: vi.fn() };
});

function frame(services: Record<string, StagedServiceObservation>): StagedBatchObservation {
  return {
    services: new Map(Object.entries(services)),
    signalAvailability: { available: true, unavailableSignals: [] },
  };
}

/**
 * Virtual clock: time advances ONLY inside the mocked sleep, `now()` is a closure
 * read, and no fake timers are installed. The frame helper HOLDS the last frame
 * instead of draining to `undefined`, so a repeated observation can be expressed
 * with a single frame.
 */
function createGateDeps(frames: StagedBatchObservation[]) {
  let currentTime = 0;
  let last: StagedBatchObservation | undefined;
  const observe = vi.fn(async () => {
    const next = frames.shift();
    if (next !== undefined) {
      last = next;
    }
    if (last === undefined) {
      throw new Error("no observation frames");
    }
    return last;
  });
  const sleep = vi.fn(async (ms: number) => {
    currentTime += ms;
  });
  return { deps: { now: () => currentTime, sleep, observe }, observe, sleep };
}

describe("waitForBatchReady", () => {
  it("gates on the batch's own services with a bounded soak, and exempts completed one-shots", async () => {
    // (a) A dependency-free batch does not pass instantly. `created` lands on the
    // `state !== "running"` branch, and the attempt bound fires long before the
    // 600s wall clock does.
    const notRunning = createGateDeps([frame({ app: { state: "created", health: "unknown" } })]);
    const notRunningReport = await waitForBatchReady(
      {
        services: ["app"],
        poll: { timeoutSeconds: 600, intervalSeconds: 1, retries: 2 },
        waitForReady: true,
      },
      notRunning.deps,
    );

    expect(notRunningReport).toMatchObject({
      ready: false,
      timedOut: true,
      degraded: false,
      attempts: 2,
      elapsedMs: 1000,
    });
    expect(notRunningReport.services).toEqual([
      expect.objectContaining({ service: "app", status: "pending", reason: "not-running" }),
    ]);
    expect(notRunning.observe).toHaveBeenCalledTimes(2);
    expect(notRunning.observe).toHaveBeenCalledWith(["app"]);

    // (b) A healthcheck-less service must soak for the bounded stable-running
    // window before it is ready: five pending attempts, ready on the sixth.
    const soak = createGateDeps([
      frame({ app: { state: "running", health: "none", exitCode: 0, imageId: "sha256:a" } }),
    ]);
    const pendingProgress: string[][] = [];
    const soakReport = await waitForBatchReady(
      {
        services: ["app"],
        poll: { timeoutSeconds: 30, intervalSeconds: 1, retries: 12 },
        waitForReady: true,
        onProgress: (pending) => pendingProgress.push([...pending]),
      },
      soak.deps,
    );

    expect(soakReport).toMatchObject({
      ready: true,
      timedOut: false,
      degraded: false,
      attempts: 6,
      elapsedMs: 5000,
    });
    expect(soakReport.services).toEqual([
      {
        service: "app",
        status: "ready",
        reason: "ready",
        assurance: "running-only",
        stableForMs: 5000,
      },
    ]);
    expect(soak.sleep).toHaveBeenCalledTimes(5);
    expect(soak.sleep).toHaveBeenCalledWith(1000);
    expect(pendingProgress).toEqual([["app"]]);

    // (c) A one-shot that ran to completion is exempt from the `exited` failure.
    const oneShot = createGateDeps([
      frame({
        "plex-ratings-sync": {
          state: "exited",
          health: "none",
          exitCode: 0,
          restartPolicy: "on-failure",
        },
      }),
    ]);
    const oneShotReport = await waitForBatchReady(
      {
        services: ["plex-ratings-sync"],
        poll: { timeoutSeconds: 30, intervalSeconds: 1, retries: 12 },
        waitForReady: true,
      },
      oneShot.deps,
    );

    expect(oneShotReport).toMatchObject({ ready: true, timedOut: false, attempts: 1 });
    expect(oneShotReport.services).toEqual([
      {
        service: "plex-ratings-sync",
        status: "ready",
        reason: "completed",
        assurance: "running-only",
        stableForMs: 0,
      },
    ]);
    expect(oneShot.sleep).not.toHaveBeenCalled();

    // ...but an always-restart container sitting at exited(0) is genuinely broken,
    // and the terminal failure short-circuits the gate instead of timing out.
    const restarter = createGateDeps([
      frame({
        worker: { state: "exited", health: "none", exitCode: 0, restartPolicy: "always" },
      }),
    ]);
    const restarterReport = await waitForBatchReady(
      {
        services: ["worker"],
        poll: { timeoutSeconds: 30, intervalSeconds: 1, retries: 12 },
        waitForReady: true,
      },
      restarter.deps,
    );

    expect(restarterReport).toMatchObject({
      ready: false,
      timedOut: false,
      attempts: 1,
      elapsedMs: 0,
    });
    expect(restarterReport.services).toEqual([
      expect.objectContaining({ service: "worker", status: "failed", reason: "exited" }),
    ]);
    expect(restarter.observe).toHaveBeenCalledTimes(1);
    expect(restarter.sleep).not.toHaveBeenCalled();
  });
});

const CTX: StagedExecutionContext = {
  composePath: "/repo/compose.yml",
  projectDir: "/repo",
  profiles: ["media"],
  exec: { cwd: "/repo", projectName: "rfmedia" },
};

function inspectFixture(name: string, exitCode: number, restartPolicy: string): ContainerInspect {
  return {
    Id: "c0ffee",
    Name: `/${name}`,
    Image: "sha256:image",
    Config: { Image: "ghcr.io/example/app:1", Env: [] },
    HostConfig: { RestartPolicy: { Name: restartPolicy, MaximumRetryCount: 10 } },
    NetworkSettings: {},
    State: { Running: false, ExitCode: exitCode, Status: "exited" },
  };
}

/**
 * Regression coverage for the one-shot exemption. `isCompletedOneShot` requires
 * `exitCode === 0`, which only exists on the frame when the observer resolves a
 * container name for an ALREADY-EXITED container. A running-only container map
 * cannot do that, so the exemption was unreachable and `plex-ratings-sync` at
 * exited(0) halted a `--staged` media-stack rollout.
 */
describe("createBatchObserver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inspects exited containers so a completed one-shot passes the gate", async () => {
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["plex-ratings-sync", { state: "exited", health: "none" }]]),
    );
    vi.mocked(getComposeContainerObservations).mockResolvedValue([
      {
        containerId: "c0ffee",
        containerName: "rfmedia-plex-ratings-sync-1",
        serviceName: "plex-ratings-sync",
        state: "exited",
        health: "",
      },
    ]);
    vi.mocked(inspectContainers).mockResolvedValue([
      inspectFixture("rfmedia-plex-ratings-sync-1", 0, "on-failure"),
    ]);

    const observe = createBatchObserver(CTX);
    const observation = await observe(["plex-ratings-sync"]);

    expect(inspectContainers).toHaveBeenCalledWith(
      ["rfmedia-plex-ratings-sync-1"],
      expect.objectContaining({ projectName: "rfmedia" }),
    );
    expect(observation.services.get("plex-ratings-sync")).toEqual({
      imageId: "sha256:image",
      state: "exited",
      exitCode: 0,
      health: "none",
      restartPolicy: "on-failure",
    });
    expect(observation.signalAvailability).toEqual({ available: true, unavailableSignals: [] });

    const report = await waitForBatchReady(
      {
        services: ["plex-ratings-sync"],
        poll: { timeoutSeconds: 30, intervalSeconds: 1, retries: 12 },
        waitForReady: true,
      },
      { observe, sleep: async () => {} },
    );

    expect(report).toMatchObject({ ready: true, timedOut: false, degraded: false, attempts: 1 });
    expect(report.services).toEqual([
      expect.objectContaining({
        service: "plex-ratings-sync",
        status: "ready",
        reason: "completed",
      }),
    ]);
  });

  it("reports the container map as an unavailable signal when the listing fails", async () => {
    vi.mocked(getServiceStatusMap).mockResolvedValue(
      new Map([["app", { state: "running", health: "none" }]]),
    );
    vi.mocked(getComposeContainerObservations).mockRejectedValue(
      new Error("Unable to observe Docker Compose containers"),
    );

    const observation = await createBatchObserver(CTX)(["app"]);

    expect(inspectContainers).not.toHaveBeenCalled();
    expect(observation.signalAvailability).toEqual({
      available: false,
      unavailableSignals: ["service-container-map"],
    });
    expect(observation.services.get("app")).toEqual({
      imageId: undefined,
      state: "running",
      exitCode: undefined,
      health: "none",
      restartPolicy: undefined,
    });
  });
});
