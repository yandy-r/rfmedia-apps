import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";
import {
  EMPTY_WANTED_PAGE,
  createLidarrWantedRecordFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (_tier: unknown, task: { run: () => Promise<unknown> }) =>
      ({
        value: await task.run(),
        execution: {
          taskId: "lidarr-wanted",
          operation: "lidarr wanted",
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

import { TIER, executeLidarrWanted } from "./wanted.js";

let clientMock: LidarrClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  clientMock = createLidarrClientMock();
  mockResolveRequiredLidarrClient.mockReturnValue(clientMock);
});

describe("executeLidarrWanted", () => {
  it("declares the local-only tier", () => {
    expect(TIER).toBe("local-only");
  });

  it("forwards paging and sort options to the client, mapping sortDir to sortDirection", async () => {
    clientMock.getWantedMissing.mockResolvedValue(EMPTY_WANTED_PAGE);

    await executeLidarrWanted({
      page: 3,
      pageSize: 25,
      sortKey: "title",
      sortDir: "ascending",
    });

    expect(clientMock.getWantedMissing).toHaveBeenCalledWith({
      page: 3,
      pageSize: 25,
      sortKey: "title",
      sortDirection: "ascending",
    });
  });

  it("projects wanted records into flat rows", async () => {
    clientMock.getWantedMissing.mockResolvedValue({
      page: 1,
      pageSize: 50,
      totalRecords: 2,
      records: [
        createLidarrWantedRecordFixture({
          id: 501,
          title: "OK Computer",
          artist: { id: 7, artistName: "Radiohead" },
          releaseDate: "1997-05-21",
          monitored: true,
        }),
        createLidarrWantedRecordFixture({
          id: 502,
          title: "Kid A",
          artist: { id: 7, artistName: "Radiohead" },
          releaseDate: undefined,
          monitored: false,
        }),
      ],
    });

    const result = await executeLidarrWanted({});

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.totalRecords).toBe(2);
    expect(result.records).toEqual([
      {
        albumId: 501,
        title: "OK Computer",
        artistName: "Radiohead",
        releaseDate: "1997-05-21",
        monitored: true,
      },
      {
        albumId: 502,
        title: "Kid A",
        artistName: "Radiohead",
        releaseDate: undefined,
        monitored: false,
      },
    ]);
    expect(result.execution).toEqual({
      taskId: "lidarr-wanted",
      operation: "lidarr wanted",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    });
    expect(mockRunSingle).toHaveBeenCalledWith(
      "local-only",
      expect.objectContaining({ id: "lidarr-wanted", idempotent: true }),
    );
  });

  it("handles an empty wanted page", async () => {
    clientMock.getWantedMissing.mockResolvedValue(EMPTY_WANTED_PAGE);

    const result = await executeLidarrWanted({});

    expect(result.records).toEqual([]);
    expect(result.totalRecords).toBe(0);
  });

  it("forwards CLI connection overrides to the resolver", async () => {
    await executeLidarrWanted({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
      expect.objectContaining({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-key" }),
      expect.objectContaining({ tier: TIER }),
    );
  });

  it("passes the explicit local-only tier as the resolver's resilience options", async () => {
    await executeLidarrWanted({});

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledTimes(1);
    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({ tier: "local-only", retryAttemptsOverride: 0 }),
    );
  });

  it("rethrows a client request failure", async () => {
    const failure = new Error("lidarr unreachable");
    clientMock.getWantedMissing.mockRejectedValue(failure);

    await expect(executeLidarrWanted({})).rejects.toBe(failure);
  });
});
