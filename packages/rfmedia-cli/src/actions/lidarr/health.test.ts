import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrHealthReport } from "../../lib/lidarr/health.js";
import type { LidarrResilienceSnapshot } from "../../types/lidarr-resilience.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";
import { createLidarrHealthCheckFixture } from "../test-helpers/lidarr-fixtures.js";

const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (_tier: unknown, task: { run: () => Promise<unknown> }) =>
      ({
        value: await task.run(),
        execution: {
          taskId: "lidarr-health",
          operation: "lidarr health",
          lane: "local-only",
          outcome: "succeeded",
          attempts: 1,
        },
      }) as const,
  ),
);
const mockLogger = vi.hoisted(() => ({ logDebug: vi.fn(), logInfo: vi.fn() }));
const mockHealthLib = vi.hoisted(() => ({
  runHealthProbe: vi.fn(),
  readLidarrResilienceSnapshot: vi.fn(),
}));

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
}));
vi.mock("../../lib/lidarr/health.js", () => ({
  runHealthProbe: mockHealthLib.runHealthProbe,
  readLidarrResilienceSnapshot: mockHealthLib.readLidarrResilienceSnapshot,
}));
vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("../../lib/logger.js", () => ({
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
}));

import { TIER, executeLidarrHealth } from "./health.js";

/** Builds a classified health report with a healthy default shape. */
function createHealthReportFixture(
  overrides: Partial<LidarrHealthReport> = {},
): LidarrHealthReport {
  return {
    status: "healthy",
    checkedAt: "2026-07-22T00:00:00.000Z",
    errors: [],
    warnings: [],
    metadataProvider: { available: true, failingChecks: [] },
    ...overrides,
  };
}

const CLOSED_SNAPSHOT: LidarrResilienceSnapshot = {
  circuits: [
    { scope: "lidarr", state: { state: "closed", recentFailures: [] } },
    { scope: "metadata", state: { state: "closed", recentFailures: [] } },
  ],
  deferredIntents: { pending: 0, failed: 0 },
};

let clientMock: LidarrClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  clientMock = createLidarrClientMock();
  mockResolveRequiredLidarrClient.mockReturnValue(clientMock);
  mockHealthLib.runHealthProbe.mockResolvedValue(createHealthReportFixture());
  mockHealthLib.readLidarrResilienceSnapshot.mockResolvedValue(CLOSED_SNAPSHOT);
});

describe("executeLidarrHealth", () => {
  it("declares the local-only tier", () => {
    expect(TIER).toBe("local-only");
  });

  it("passes checks through and flags no errors for warnings only", async () => {
    const checks = [
      createLidarrHealthCheckFixture({ source: "IndexerCheck", type: "warning" }),
      createLidarrHealthCheckFixture({ source: "UpdateCheck", type: "notice" }),
    ];
    clientMock.getHealth.mockResolvedValue(checks);

    const result = await executeLidarrHealth({});

    expect(result.checks).toEqual(checks);
    expect(result.hasErrors).toBe(false);
    expect(result.execution).toEqual({
      taskId: "lidarr-health",
      operation: "lidarr health",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    });
    expect(mockRunSingle).toHaveBeenCalledWith(
      "local-only",
      expect.objectContaining({ id: "lidarr-health", idempotent: true }),
    );
  });

  it("flags errors when an error-level check is present", async () => {
    clientMock.getHealth.mockResolvedValue([
      createLidarrHealthCheckFixture({ type: "warning" }),
      createLidarrHealthCheckFixture({ source: "DownloadClientCheck", type: "error" }),
    ]);

    const result = await executeLidarrHealth({});

    expect(result.hasErrors).toBe(true);
  });

  it("filters checks by the requested severities", async () => {
    clientMock.getHealth.mockResolvedValue([
      createLidarrHealthCheckFixture({ source: "A", type: "warning" }),
      createLidarrHealthCheckFixture({ source: "B", type: "error" }),
      createLidarrHealthCheckFixture({ source: "C", type: "notice" }),
    ]);

    const result = await executeLidarrHealth({ type: ["error"] });

    expect(result.checks.map((c) => c.source)).toEqual(["B"]);
    expect(result.hasErrors).toBe(true);
  });

  it("forwards CLI connection overrides to the resolver", async () => {
    await executeLidarrHealth({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
      expect.objectContaining({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" }),
      expect.objectContaining({ tier: "local-only", retryAttemptsOverride: 0 }),
    );
  });

  it("attaches the metadata-provider view from the health probe", async () => {
    const failing = createLidarrHealthCheckFixture({
      source: "MetadataProviderCheck",
      type: "error",
      message: "Unable to reach api.lidarr.audio",
    });
    mockHealthLib.runHealthProbe.mockResolvedValue(
      createHealthReportFixture({
        status: "degraded",
        errors: [failing],
        metadataProvider: { available: false, failingChecks: [failing] },
      }),
    );

    const result = await executeLidarrHealth({});

    expect(mockHealthLib.runHealthProbe).toHaveBeenCalledWith(clientMock);
    expect(result.metadataProvider).toEqual({ available: false, failingChecks: [failing] });
  });

  it("attaches the resilience snapshot and forwards connection overrides to it", async () => {
    const result = await executeLidarrHealth({
      lidarrUrl: "http://lidarr:8686",
      lidarrApiKey: "secret-key",
    });

    expect(mockHealthLib.readLidarrResilienceSnapshot).toHaveBeenCalledWith({
      lidarrUrl: "http://lidarr:8686",
      lidarrApiKey: "secret-key",
    });
    expect(result.resilience).toEqual(CLOSED_SNAPSHOT);
  });

  it("still succeeds when the snapshot reports unknown circuit state", async () => {
    const unknownSnapshot: LidarrResilienceSnapshot = {
      circuits: [
        {
          scope: "lidarr",
          state: { state: "unknown", reason: "cannot open tracking database: boom" },
        },
        {
          scope: "metadata",
          state: { state: "unknown", reason: "cannot open tracking database: boom" },
        },
      ],
      deferredIntents: { pending: 0, failed: 0 },
    };
    mockHealthLib.readLidarrResilienceSnapshot.mockResolvedValue(unknownSnapshot);

    const result = await executeLidarrHealth({});

    expect(result.resilience).toEqual(unknownSnapshot);
    expect(result.checks).toEqual([]);
    expect(result.hasErrors).toBe(false);
  });

  it("keeps the existing checks/hasErrors shape alongside the additive fields", async () => {
    const checks = [createLidarrHealthCheckFixture({ source: "IndexerCheck", type: "warning" })];
    clientMock.getHealth.mockResolvedValue(checks);

    const result = await executeLidarrHealth({});

    expect(result.checks).toEqual(checks);
    expect(result.hasErrors).toBe(false);
    expect(result.metadataProvider).toEqual({ available: true, failingChecks: [] });
    expect(result.resilience).toEqual(CLOSED_SNAPSHOT);
  });

  it("rethrows a client request failure without probing or snapshotting", async () => {
    const failure = new Error("lidarr unreachable");
    clientMock.getHealth.mockRejectedValue(failure);

    await expect(executeLidarrHealth({})).rejects.toBe(failure);
    expect(mockHealthLib.runHealthProbe).not.toHaveBeenCalled();
    expect(mockHealthLib.readLidarrResilienceSnapshot).not.toHaveBeenCalled();
  });
});
