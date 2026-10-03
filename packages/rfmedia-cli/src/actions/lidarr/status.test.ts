import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrResilienceCallOptions } from "../../lib/lidarr/resilience.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";
import { HEALTHY_STATUS, createLidarrArtistFixture } from "../test-helpers/lidarr-fixtures.js";

const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (_tier: unknown, task: { run: () => Promise<unknown> }) =>
      ({
        value: await task.run(),
        execution: {
          taskId: "lidarr-status",
          operation: "lidarr status",
          lane: "local-only",
          outcome: "succeeded",
          attempts: 1,
        },
      }) as const,
  ),
);
const mockLogger = vi.hoisted(() => ({ logDebug: vi.fn(), logInfo: vi.fn() }));

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
}));
vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("../../lib/logger.js", () => ({
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
}));

import { TIER, executeLidarrStatus } from "./status.js";

let clientMock: LidarrClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  clientMock = createLidarrClientMock();
  mockResolveRequiredLidarrClient.mockReturnValue(clientMock);
});

describe("executeLidarrStatus", () => {
  it("declares the local-only tier", () => {
    expect(TIER).toBe("local-only");
  });

  it("aggregates artist counts, disk usage, and track totals", async () => {
    clientMock.getSystemStatus.mockResolvedValue(HEALTHY_STATUS);
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({
        id: 1,
        monitored: true,
        statistics: {
          albumCount: 2,
          trackFileCount: 20,
          trackCount: 25,
          sizeOnDisk: 1_000,
        },
      }),
      createLidarrArtistFixture({
        id: 2,
        monitored: false,
        statistics: {
          albumCount: 1,
          trackFileCount: 5,
          trackCount: 10,
          sizeOnDisk: 500,
        },
      }),
      createLidarrArtistFixture({ id: 3, monitored: true, statistics: undefined }),
    ]);

    const result = await executeLidarrStatus({});

    expect(result).toEqual({
      version: HEALTHY_STATUS.version,
      instanceName: HEALTHY_STATUS.instanceName,
      artistCount: 3,
      monitoredCount: 2,
      unmonitoredCount: 1,
      totalSizeOnDisk: 1_500,
      trackFileCount: 25,
      trackCount: 35,
      execution: {
        taskId: "lidarr-status",
        operation: "lidarr status",
        lane: "local-only",
        outcome: "succeeded",
        attempts: 1,
      },
    });
    expect(mockRunSingle).toHaveBeenCalledWith(
      "local-only",
      expect.objectContaining({ id: "lidarr-status", idempotent: true }),
    );
  });

  it("returns zeroed aggregates for an empty library", async () => {
    clientMock.getSystemStatus.mockResolvedValue(HEALTHY_STATUS);
    clientMock.listArtists.mockResolvedValue([]);

    const result = await executeLidarrStatus({});

    expect(result.artistCount).toBe(0);
    expect(result.monitoredCount).toBe(0);
    expect(result.unmonitoredCount).toBe(0);
    expect(result.totalSizeOnDisk).toBe(0);
  });

  it("forwards CLI connection overrides to the resolver", async () => {
    await executeLidarrStatus({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
      expect.objectContaining({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" }),
      expect.objectContaining({ tier: "local-only" }),
    );
  });

  it("forwards resilience call options with the local-only tier", async () => {
    await executeLidarrStatus({ allowStale: true });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({
        tier: "local-only",
        allowStale: true,
        retryAttemptsOverride: 0,
        onStaleServe: expect.any(Function),
      }),
    );
  });

  it("attaches cacheStatus when the decorator serves a stale projection", async () => {
    const staleStatus: LidarrCacheStatus = {
      source: "stale-cache",
      fetchedAt: "2026-07-22T09:48:00.000Z",
      ageSeconds: 720,
    };
    let resilienceOptions: LidarrResilienceCallOptions | undefined;
    mockResolveRequiredLidarrClient.mockImplementation(
      (_overrides: unknown, resilience?: LidarrResilienceCallOptions) => {
        resilienceOptions = resilience;
        return clientMock;
      },
    );
    clientMock.getSystemStatus.mockImplementation(async () => {
      resilienceOptions?.onStaleServe?.(staleStatus);
      return HEALTHY_STATUS;
    });
    clientMock.listArtists.mockResolvedValue([]);

    const result = await executeLidarrStatus({ allowStale: true });

    expect(result.cacheStatus).toEqual(staleStatus);
  });

  it("omits cacheStatus when no stale projection is served", async () => {
    clientMock.getSystemStatus.mockResolvedValue(HEALTHY_STATUS);
    clientMock.listArtists.mockResolvedValue([]);

    const result = await executeLidarrStatus({});

    expect(result).not.toHaveProperty("cacheStatus");
  });

  it("fetches system status before the artist list", async () => {
    const callOrder: string[] = [];
    clientMock.getSystemStatus.mockImplementation(async () => {
      callOrder.push("getSystemStatus");
      return HEALTHY_STATUS;
    });
    clientMock.listArtists.mockImplementation(async () => {
      callOrder.push("listArtists");
      return [];
    });

    await executeLidarrStatus({});

    expect(callOrder).toEqual(["getSystemStatus", "listArtists"]);
  });

  it("fails fast without a stale warning when only artists are cached", async () => {
    // Realistic cache coverage: user only ever ran `lidarr list`, so artists
    // are cached but system-status has no cache row. The system-status call
    // must fail BEFORE the artists call can serve stale data.
    const failure = new Error("lidarr unreachable and no cached system status");
    const staleStatus: LidarrCacheStatus = {
      source: "stale-cache",
      fetchedAt: "2026-07-22T09:48:00.000Z",
      ageSeconds: 720,
    };
    let resilienceOptions: LidarrResilienceCallOptions | undefined;
    mockResolveRequiredLidarrClient.mockImplementation(
      (_overrides: unknown, resilience?: LidarrResilienceCallOptions) => {
        resilienceOptions = resilience;
        return clientMock;
      },
    );
    clientMock.getSystemStatus.mockRejectedValue(failure);
    clientMock.listArtists.mockImplementation(async () => {
      resilienceOptions?.onStaleServe?.(staleStatus);
      return [];
    });

    await expect(executeLidarrStatus({ allowStale: true })).rejects.toBe(failure);
    expect(clientMock.listArtists).not.toHaveBeenCalled();
  });

  it("propagates a resolver failure", async () => {
    const failure = new Error("configuration missing");
    mockResolveRequiredLidarrClient.mockImplementation(() => {
      throw failure;
    });

    await expect(executeLidarrStatus({})).rejects.toBe(failure);
  });

  it("rethrows a client request failure", async () => {
    const failure = new Error("lidarr unreachable");
    clientMock.getSystemStatus.mockRejectedValue(failure);

    await expect(executeLidarrStatus({})).rejects.toBe(failure);
  });
});
