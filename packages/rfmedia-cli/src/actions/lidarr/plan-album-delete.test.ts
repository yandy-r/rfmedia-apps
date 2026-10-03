import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
} from "../test-helpers/lidarr-fixtures.js";
import type { LidarrAlbumQuery } from "../../lib/lidarr/client.js";
import type { LidarrConfigOptions } from "../../types/config.js";
import type { LidarrAlbum } from "../../types/lidarr.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn(() => mockClient.current));
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "plan-album-delete",
      operation: "lidarr plan album delete",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);
const mockRunBatch = vi.hoisted(() =>
  vi.fn(
    async (
      _tier: unknown,
      tasks: readonly { id: string; operation: string; run: () => Promise<unknown> }[],
    ) => {
      const results = [];
      for (const task of tasks) {
        results.push({
          taskId: task.id,
          operation: task.operation,
          lane: "local-only",
          outcome: "succeeded" as const,
          attempts: 1,
          value: await task.run(),
        });
      }
      return {
        lane: "local-only",
        summary: {
          total: tasks.length,
          admitted: tasks.length,
          succeeded: tasks.length,
          failed: 0,
          skipped: 0,
          attempts: tasks.length,
        },
        results,
      };
    },
  ),
);
const mockWritePlanArtifact = vi.hoisted(() => vi.fn(async () => {}));
const mockLoadedLidarrConfigState = vi.hoisted(() => ({
  current: {
    cascadeAnalysis: {
      budgets: {
        indexerQueries: 50,
        acquisitionCandidates: 25,
      },
    },
  } as LidarrConfigOptions,
}));
const mockGetLoadedLidarrConfig = vi.hoisted(() =>
  vi.fn(() => mockLoadedLidarrConfigState.current),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle, runBatch: mockRunBatch }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));

vi.mock("../../lib/lidarr/plan-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/lidarr/plan-engine.js")>();
  return { ...actual, writeLidarrPlanArtifact: mockWritePlanArtifact };
});

vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: mockGetLoadedLidarrConfig,
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { executeLidarrAlbumDeletePlan, TIER } from "./plan-album-delete.js";

/** Serves per-artist and explicit-ID album queries from one in-memory library. */
function libraryClient(artists: readonly { id: number; name: string }[], albums: LidarrAlbum[]) {
  return createLidarrClientMock({
    listArtists: async () =>
      artists.map((artist) =>
        createLidarrArtistFixture({ id: artist.id, artistName: artist.name }),
      ),
    listAlbums: async (query: LidarrAlbumQuery) => {
      if (query.artistId !== undefined) {
        return albums.filter((album) => album.artistId === query.artistId);
      }
      return albums.filter((album) => query.albumIds?.includes(album.id) ?? false);
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadedLidarrConfigState.current = {
    cascadeAnalysis: {
      budgets: {
        indexerQueries: 50,
        acquisitionCandidates: 25,
      },
    },
  };
  mockClient.current = createLidarrClientMock();
});

describe("executeLidarrAlbumDeletePlan", () => {
  it("runs on the local-only lane, disables in-place retries, and uses its own task ids", async () => {
    expect(TIER).toBe("local-only");
    mockClient.current = libraryClient([{ id: 1, name: "One" }], []);

    await executeLidarrAlbumDeletePlan({ artistIds: [1], dryRun: true });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(expect.anything(), {
      tier: "local-only",
      retryAttemptsOverride: 0,
    });
    const [, tasks] = mockRunBatch.mock.calls[0]!;
    expect(tasks.map((task) => task.id)).toEqual(["lidarr-plan-album-delete-1"]);
    expect(tasks.map((task) => task.operation)).toEqual(["lidarr plan album delete"]);
  });

  it("rejects --types without --artist-ids with the explicit-scope message", async () => {
    await expect(executeLidarrAlbumDeletePlan({ types: ["demos"] })).rejects.toThrow(
      "album deletion requires an explicit --album-ids or --artist-ids scope",
    );
    await expect(executeLidarrAlbumDeletePlan({})).rejects.toThrow(
      "album deletion requires an explicit --album-ids or --artist-ids scope",
    );
    await expect(
      executeLidarrAlbumDeletePlan({ albumIds: [10], types: ["demos"] }),
    ).rejects.toThrow(/--album-ids conflicts with --types and --artist-ids/u);
    await expect(executeLidarrAlbumDeletePlan({ albumIds: [10], artistIds: [1] })).rejects.toThrow(
      /--album-ids conflicts with --types and --artist-ids/u,
    );
    await expect(executeLidarrAlbumDeletePlan({ albumIds: [10, 10] })).rejects.toThrow(
      /album IDs must be unique/u,
    );
    await expect(executeLidarrAlbumDeletePlan({ artistIds: [1, 1] })).rejects.toThrow(
      /artist IDs must be unique/u,
    );
    expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
  });

  it("excludes monitored albums by default and accounts for the blast radius honestly", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: true }),
        createLidarrAlbumFixture({
          id: 11,
          artistId: 1,
          monitored: false,
          foreignAlbumId: "mbid-11",
          statistics: { trackFileCount: 2, sizeOnDisk: 2048 },
        }),
        createLidarrAlbumFixture({ id: 12, artistId: 1, monitored: false }),
      ],
    );

    const result = await executeLidarrAlbumDeletePlan({ artistIds: [1], dryRun: true });

    expect(result.status).toBe("previewed");
    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toEqual({
      artistsScanned: 1,
      albumsScanned: 3,
      matched: 3,
      excludedMonitored: 1,
      planned: 2,
      withFiles: 1,
      totalSizeOnDisk: 2048,
      bySelector: {},
    });
    expect(result.plan.operation).toEqual({
      kind: "album-delete",
      deleteFiles: false,
      addImportListExclusion: false,
      includeMonitored: false,
      selectors: [],
    });
    expect(result.plan.selection).toEqual({
      kind: "album-filters",
      artistIds: [1],
      selectors: [],
      includeMonitored: false,
    });
    expect(result.plan.entries).toEqual([
      expect.objectContaining({
        id: "album:11",
        albumId: 11,
        foreignAlbumId: "mbid-11",
        before: { monitored: false, trackFileCount: 2, sizeOnDisk: 2048 },
        after: { deleted: true },
      }),
      expect.objectContaining({
        id: "album:12",
        albumId: 12,
        before: { monitored: false, trackFileCount: 0, sizeOnDisk: 0 },
        after: { deleted: true },
      }),
    ]);
    expect(result.plan.entries[1]).not.toHaveProperty("foreignAlbumId");
    expect(result.plan.version).toBe("rfmedia.lidarr-plan.v3");
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      horizon: "none",
      basis: "operation-removes-acquisition-scope",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries.value).toBe(0);
    expect(result.plan.risk).toMatchObject({ level: "high", destructive: true });
    expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(1);
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("opts monitored albums in with includeMonitored and seals the destruction mode", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: true }),
        createLidarrAlbumFixture({ id: 11, artistId: 1, monitored: false }),
      ],
    );

    const result = await executeLidarrAlbumDeletePlan({
      artistIds: [1],
      includeMonitored: true,
      deleteFiles: true,
      addImportListExclusion: true,
      dryRun: true,
    });

    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toMatchObject({ matched: 2, excludedMonitored: 0, planned: 2 });
    expect(result.plan.operation).toEqual({
      kind: "album-delete",
      deleteFiles: true,
      addImportListExclusion: true,
      includeMonitored: true,
      selectors: [],
    });
    expect(result.plan.summary).toMatchObject({
      kind: "album-delete",
      albums: 2,
      deleteFiles: true,
      importListExclusions: true,
    });
  });

  it("narrows the artist scope with --types and counts matches per selector", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, albumType: "Single", monitored: false }),
        createLidarrAlbumFixture({ id: 11, artistId: 1, albumType: "Album", monitored: false }),
      ],
    );

    const result = await executeLidarrAlbumDeletePlan({
      artistIds: [1],
      types: ["singles"],
      dryRun: true,
    });

    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toMatchObject({
      albumsScanned: 2,
      matched: 1,
      planned: 1,
      bySelector: { singles: 1 },
    });
    expect(result.plan.entries.map((entry) => entry.albumId)).toEqual([10]);
    expect(result.plan.selection).toEqual({
      kind: "album-filters",
      artistIds: [1],
      selectors: ["singles"],
      includeMonitored: false,
    });
  });

  it("fails closed on missing or unrequested explicit IDs without writing an artifact", async () => {
    const client = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: false }),
        createLidarrAlbumFixture({ id: 20, artistId: 1, monitored: false }),
      ],
    );
    mockClient.current = client;

    await expect(executeLidarrAlbumDeletePlan({ albumIds: [10, 20, 30] })).rejects.toThrow(
      /Lidarr album IDs were not found: 30/u,
    );

    const extraClient = createLidarrClientMock({
      listArtists: async () => [createLidarrArtistFixture({ id: 1, artistName: "One" })],
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: false }),
        createLidarrAlbumFixture({ id: 99, artistId: 1, monitored: false }),
      ],
    });
    mockClient.current = extraClient;
    await expect(executeLidarrAlbumDeletePlan({ albumIds: [10] })).rejects.toThrow(
      /Lidarr returned album IDs that were not requested: 99/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
    expect(client.deleteAlbum).not.toHaveBeenCalled();
    expect(extraClient.deleteAlbum).not.toHaveBeenCalled();
  });

  it("applies the monitored guard in explicit-ID mode and seals only the planned IDs", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: true }),
        createLidarrAlbumFixture({ id: 11, artistId: 1, monitored: false }),
        createLidarrAlbumFixture({ id: 12, artistId: 1, monitored: false }),
      ],
    );

    const result = await executeLidarrAlbumDeletePlan({ albumIds: [12, 11, 10], dryRun: true });

    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toMatchObject({ matched: 3, excludedMonitored: 1, planned: 2 });
    // The sealed explicit selection lists exactly the planned albums, sorted.
    expect(result.plan.selection).toEqual({ kind: "album-ids", albumIds: [11, 12] });
    expect(result.plan.entries.map((entry) => entry.albumId)).toEqual([11, 12]);
  });

  it("names the exact corrective --max-batch value with per-mode narrow-hints", async () => {
    const albums = [10, 20, 30].map((id) =>
      createLidarrAlbumFixture({ id, artistId: 1, monitored: false }),
    );
    mockClient.current = libraryClient([{ id: 1, name: "One" }], albums);

    await expect(executeLidarrAlbumDeletePlan({ artistIds: [1], maxBatch: 2 })).rejects.toThrow(
      /planned 3 deletion\(s\) exceed --max-batch 2; re-run with --max-batch 3 or narrow --types\/--artist-ids/u,
    );
    await expect(
      executeLidarrAlbumDeletePlan({ albumIds: [10, 20, 30], maxBatch: 2 }),
    ).rejects.toThrow(
      /planned 3 deletion\(s\) exceed --max-batch 2; re-run with --max-batch 3 or pass fewer --album-ids/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("advises --artist-ids slicing beyond the 1000-entry plan cap", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      Array.from({ length: 1001 }, (_unused, index) =>
        createLidarrAlbumFixture({ id: index + 1, artistId: 1, monitored: false }),
      ),
    );

    await expect(executeLidarrAlbumDeletePlan({ artistIds: [1], maxBatch: 1000 })).rejects.toThrow(
      /planned 1001 deletion\(s\) exceed the 1000-entry plan cap; split the work with --artist-ids/u,
    );
  });

  it("returns no-change in dry-run and throws when sealing would write an empty plan", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: true })],
    );

    const result = await executeLidarrAlbumDeletePlan({ artistIds: [1], dryRun: true });
    expect(result.status).toBe("no-change");
    expect(result.selection).toMatchObject({ matched: 1, excludedMonitored: 1, planned: 0 });

    await expect(executeLidarrAlbumDeletePlan({ artistIds: [1] })).rejects.toBeInstanceOf(
      LidarrPlanValidationError,
    );
    await expect(executeLidarrAlbumDeletePlan({ artistIds: [1] })).rejects.toThrow(
      /no album deletions to plan; inspect the selection with --dry-run/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("previews in dry-run without writing and seals a plan artifact on a real run", async () => {
    const client = libraryClient(
      [{ id: 1, name: "One" }],
      [createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: false })],
    );
    mockClient.current = client;

    const previewed = await executeLidarrAlbumDeletePlan({ artistIds: [1], dryRun: true });
    expect(previewed.status).toBe("previewed");
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
    expect(client.deleteAlbum).not.toHaveBeenCalled();

    const planned = await executeLidarrAlbumDeletePlan({
      artistIds: [1],
      output: "/tmp/rfmedia-album-delete-plan.json",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned result");
    expect(planned.planPath).toBe("/tmp/rfmedia-album-delete-plan.json");
    expect(planned.plan.version).toBe("rfmedia.lidarr-plan.v3");
    if (previewed.status !== "previewed") throw new Error("expected a previewed result");
    expect(planned.plan.cascadeAnalysis).toEqual(previewed.plan.cascadeAnalysis);
    expect(mockWritePlanArtifact).toHaveBeenCalledWith(
      "/tmp/rfmedia-album-delete-plan.json",
      planned.plan,
    );
    expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(2);
    expect(planned.execution.outcome).toBe("succeeded");
    expect(client.deleteAlbum).not.toHaveBeenCalled();
  });
});
