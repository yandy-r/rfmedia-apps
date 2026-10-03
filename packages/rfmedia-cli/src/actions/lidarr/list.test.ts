import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrResilienceCallOptions } from "../../lib/lidarr/resilience.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";
import { createLidarrArtistFixture } from "../test-helpers/lidarr-fixtures.js";

const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (_tier: unknown, task: { run: () => Promise<unknown> }) =>
      ({
        value: await task.run(),
        execution: {
          taskId: "lidarr-list",
          operation: "lidarr list",
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

import { TIER, executeLidarrList } from "./list.js";

let clientMock: LidarrClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  clientMock = createLidarrClientMock();
  mockResolveRequiredLidarrClient.mockReturnValue(clientMock);
});

describe("executeLidarrList", () => {
  it("declares the local-only tier", () => {
    expect(TIER).toBe("local-only");
  });

  it("projects artist rows with statistics defaults", async () => {
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({
        id: 7,
        artistName: "Radiohead",
        foreignArtistId: "mbid-7",
        qualityProfileId: 2,
        tags: [1, 2],
        statistics: {
          albumCount: 9,
          trackFileCount: 100,
          trackCount: 100,
          sizeOnDisk: 42,
        },
      }),
      createLidarrArtistFixture({ id: 8, statistics: undefined }),
    ]);

    const result = await executeLidarrList({});

    expect(result.total).toBe(2);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.artists[0]).toEqual({
      id: 7,
      artistName: "Radiohead",
      foreignArtistId: "mbid-7",
      monitored: true,
      qualityProfileId: 2,
      tags: [1, 2],
      albumCount: 9,
      sizeOnDisk: 42,
    });
    expect(result.artists[1]?.albumCount).toBe(0);
    expect(result.artists[1]?.sizeOnDisk).toBe(0);
    expect(result.execution).toEqual({
      taskId: "lidarr-list",
      operation: "lidarr list",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    });
    expect(mockRunSingle).toHaveBeenCalledWith(
      "local-only",
      expect.objectContaining({ id: "lidarr-list", idempotent: true }),
    );
  });

  it("filters by monitored state", async () => {
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({ id: 1, monitored: true }),
      createLidarrArtistFixture({ id: 2, monitored: false }),
    ]);

    const result = await executeLidarrList({ monitored: true });

    expect(result.total).toBe(1);
    expect(result.artists.map((a) => a.id)).toEqual([1]);
  });

  it("filters by unmonitored state", async () => {
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({ id: 1, monitored: true }),
      createLidarrArtistFixture({ id: 2, monitored: false }),
    ]);

    const result = await executeLidarrList({ unmonitored: true });

    expect(result.artists.map((a) => a.id)).toEqual([2]);
  });

  it("filters by quality profile", async () => {
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({ id: 1, qualityProfileId: 1 }),
      createLidarrArtistFixture({ id: 2, qualityProfileId: 2 }),
    ]);

    const result = await executeLidarrList({ qualityProfile: 2 });

    expect(result.artists.map((a) => a.id)).toEqual([2]);
  });

  it("filters by tag membership requiring all specified tags", async () => {
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({ id: 1, tags: [1, 2, 3] }),
      createLidarrArtistFixture({ id: 2, tags: [1] }),
      createLidarrArtistFixture({ id: 3, tags: [2, 3] }),
    ]);

    const result = await executeLidarrList({ tag: [1, 2] });

    expect(result.artists.map((a) => a.id)).toEqual([1]);
  });

  it("applies offset and limit against the pre-slice total", async () => {
    clientMock.listArtists.mockResolvedValue([
      createLidarrArtistFixture({ id: 1 }),
      createLidarrArtistFixture({ id: 2 }),
      createLidarrArtistFixture({ id: 3 }),
      createLidarrArtistFixture({ id: 4 }),
    ]);

    const result = await executeLidarrList({ limit: 2, offset: 1 });

    expect(result.total).toBe(4);
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(1);
    expect(result.artists.map((a) => a.id)).toEqual([2, 3]);
  });

  it("forwards CLI connection overrides to the resolver", async () => {
    await executeLidarrList({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
      expect.objectContaining({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" }),
      expect.objectContaining({ tier: "local-only" }),
    );
  });

  it("forwards resilience call options with the local-only tier", async () => {
    await executeLidarrList({ allowStale: true });

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
    clientMock.listArtists.mockImplementation(async () => {
      resilienceOptions?.onStaleServe?.(staleStatus);
      return [createLidarrArtistFixture({ id: 1 })];
    });

    const result = await executeLidarrList({ allowStale: true });

    expect(result.cacheStatus).toEqual(staleStatus);
    expect(result.total).toBe(1);
  });

  it("omits cacheStatus when no stale projection is served", async () => {
    clientMock.listArtists.mockResolvedValue([createLidarrArtistFixture({ id: 1 })]);

    const result = await executeLidarrList({});

    expect(result).not.toHaveProperty("cacheStatus");
  });

  it("rethrows a client request failure", async () => {
    const failure = new Error("lidarr unreachable");
    clientMock.listArtists.mockRejectedValue(failure);

    await expect(executeLidarrList({})).rejects.toBe(failure);
  });
});
