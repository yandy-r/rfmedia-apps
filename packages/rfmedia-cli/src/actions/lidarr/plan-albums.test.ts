import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
} from "../test-helpers/lidarr-fixtures.js";
import type { LidarrAlbumQuery } from "../../lib/lidarr/client.js";
import type { LidarrAlbum } from "../../types/lidarr.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn(() => mockClient.current));
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "plan-albums",
      operation: "lidarr plan album monitoring",
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
const mockGetLoadedLidarrConfig = vi.hoisted(() => vi.fn(() => ({})));

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
import { executeLidarrAlbumPlan, TIER } from "./plan-albums.js";

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
  mockClient.current = createLidarrClientMock();
});

describe("executeLidarrAlbumPlan", () => {
  it("runs on the local-only lane and disables in-place client retries", async () => {
    expect(TIER).toBe("local-only");
    mockClient.current = libraryClient([{ id: 1, name: "One" }], []);

    await executeLidarrAlbumPlan({ monitored: false, types: ["singles"], dryRun: true });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(expect.anything(), {
      tier: "local-only",
      retryAttemptsOverride: 0,
    });
    expect(mockRunBatch).toHaveBeenCalledWith("local-only", expect.any(Array));
  });

  it("previews a selector plan with per-artist batch tasks and changes-only entries", async () => {
    const client = libraryClient(
      [
        { id: 1, name: "One" },
        { id: 2, name: "Two" },
      ],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, albumType: "Single", monitored: true }),
        createLidarrAlbumFixture({ id: 11, artistId: 1, albumType: "Album", monitored: true }),
        createLidarrAlbumFixture({
          id: 20,
          artistId: 2,
          albumType: "Album",
          secondaryTypes: ["Live"],
          monitored: true,
        }),
        createLidarrAlbumFixture({ id: 21, artistId: 2, albumType: "Single", monitored: false }),
      ],
    );
    mockClient.current = client;

    const result = await executeLidarrAlbumPlan({
      monitored: false,
      types: ["singles", "live"],
      dryRun: true,
    });

    const [, tasks] = mockRunBatch.mock.calls[0]!;
    expect(tasks.map((task) => task.id)).toEqual([
      "lidarr-plan-album-monitoring-1",
      "lidarr-plan-album-monitoring-2",
    ]);
    expect(result.status).toBe("previewed");
    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toEqual({
      artistsScanned: 2,
      albumsScanned: 4,
      matched: 3,
      alreadyInDesiredState: 1,
      planned: 2,
      bySelector: { singles: 2, live: 1 },
    });
    expect(result.plan.operation).toEqual({
      kind: "album-monitoring",
      desiredMonitored: false,
      selectors: ["live", "singles"],
    });
    expect(result.plan.version).toBe("rfmedia.lidarr-plan.v3");
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      horizon: "none",
      basis: "operation-removes-acquisition-scope",
    });
    expect(result.plan.cascadeAnalysis.metrics.newlyMonitored).toMatchObject({
      value: 0,
      certainty: "exact",
      unit: "albums",
    });
    expect(
      result.plan.entries.map((entry) => ("albumId" in entry ? entry.albumId : undefined)),
    ).toEqual([10, 20]);
    expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(1);
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("counts only false-to-true albums as exact acquisition candidates", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 1,
          albumType: "Single",
          monitored: false,
        }),
        createLidarrAlbumFixture({
          id: 11,
          artistId: 1,
          albumType: "Single",
          monitored: true,
        }),
      ],
    );

    const result = await executeLidarrAlbumPlan({
      monitored: true,
      types: ["singles"],
      dryRun: true,
    });

    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toMatchObject({
      matched: 2,
      alreadyInDesiredState: 1,
      planned: 1,
    });
    expect(result.plan.entries.map((entry) => entry.albumId)).toEqual([10]);
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 1,
      certainty: "exact",
      horizon: "conditional",
      unit: "acquisition-candidates",
      basis: "changed-album-monitoring",
    });
    expect(result.plan.cascadeAnalysis.metrics.newlyMonitored).toMatchObject({
      value: 1,
      certainty: "exact",
      horizon: "immediate",
      unit: "albums",
      basis: "changed-album-monitoring",
    });
  });

  it("counts a multi-selector album once in matched but in every selector bucket", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 1,
          albumType: "Single",
          secondaryTypes: ["Live"],
          monitored: true,
        }),
      ],
    );

    const result = await executeLidarrAlbumPlan({
      monitored: false,
      types: ["singles", "live"],
      dryRun: true,
    });

    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection.matched).toBe(1);
    expect(result.selection.planned).toBe(1);
    expect(result.selection.bySelector).toEqual({ singles: 1, live: 1 });
  });

  it("scopes the batch with --artist-ids and fails closed on unknown artist IDs", async () => {
    const albums = [
      createLidarrAlbumFixture({ id: 10, artistId: 1, albumType: "Single", monitored: true }),
      createLidarrAlbumFixture({ id: 20, artistId: 2, albumType: "Single", monitored: true }),
    ];
    mockClient.current = libraryClient(
      [
        { id: 1, name: "One" },
        { id: 2, name: "Two" },
      ],
      albums,
    );

    await expect(
      executeLidarrAlbumPlan({
        monitored: false,
        types: ["singles"],
        artistIds: [1, 99],
        dryRun: true,
      }),
    ).rejects.toThrow(/Lidarr artist IDs were not found: 99/u);

    mockRunBatch.mockClear();
    const result = await executeLidarrAlbumPlan({
      monitored: false,
      types: ["singles"],
      artistIds: [2],
      dryRun: true,
    });
    const [, tasks] = mockRunBatch.mock.calls[0]!;
    expect(tasks.map((task) => task.id)).toEqual(["lidarr-plan-album-monitoring-2"]);
    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection.artistsScanned).toBe(1);
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([2]);
  });

  it("plans exact album IDs without a batch and fails closed on missing IDs", async () => {
    const client = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: true }),
        createLidarrAlbumFixture({ id: 20, artistId: 1, monitored: true }),
      ],
    );
    mockClient.current = client;

    await expect(
      executeLidarrAlbumPlan({ monitored: false, albumIds: [10, 20, 30], dryRun: true }),
    ).rejects.toThrow(/Lidarr album IDs were not found: 30/u);

    const result = await executeLidarrAlbumPlan({
      monitored: false,
      albumIds: [10, 20],
      dryRun: true,
    });
    expect(client.listAlbums).toHaveBeenCalledWith({ albumIds: [10, 20] });
    expect(mockRunBatch).not.toHaveBeenCalled();
    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.plan.operation).toEqual({
      kind: "album-monitoring",
      desiredMonitored: false,
      selectors: [],
    });
    expect(result.plan.entries.map((entry) => entry.artistName)).toEqual(["One", "One"]);
    expect(result.selection.bySelector).toEqual({});
  });

  it("fails closed when Lidarr returns albums that were never requested", async () => {
    const client = createLidarrClientMock({
      listArtists: async () => [createLidarrArtistFixture({ id: 1, artistName: "One" })],
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 10, artistId: 1, monitored: true }),
        createLidarrAlbumFixture({ id: 20, artistId: 1, monitored: true }),
        createLidarrAlbumFixture({ id: 99, artistId: 1, monitored: true }),
      ],
    });
    mockClient.current = client;

    await expect(
      executeLidarrAlbumPlan({ monitored: false, albumIds: [10, 20] }),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    await expect(executeLidarrAlbumPlan({ monitored: false, albumIds: [10, 20] })).rejects.toThrow(
      /Lidarr returned album IDs that were not requested: 99/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("rejects explicit album IDs combined with selector flags", async () => {
    await expect(
      executeLidarrAlbumPlan({ monitored: false, albumIds: [10], types: ["singles"] }),
    ).rejects.toThrow(/--album-ids conflicts with --types and --artist-ids/u);
    await expect(executeLidarrAlbumPlan({ monitored: false })).rejects.toThrow(
      /pass --types or --album-ids/u,
    );
    expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
  });

  it("returns no-change in dry-run and throws when sealing would write an empty plan", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [createLidarrAlbumFixture({ id: 10, artistId: 1, albumType: "Single", monitored: false })],
    );

    const result = await executeLidarrAlbumPlan({
      monitored: false,
      types: ["singles"],
      dryRun: true,
    });
    expect(result.status).toBe("no-change");
    expect(result.selection).toMatchObject({ matched: 1, alreadyInDesiredState: 1, planned: 0 });

    await expect(executeLidarrAlbumPlan({ monitored: false, types: ["singles"] })).rejects.toThrow(
      /no album monitoring changes to plan; inspect the selection with --dry-run/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("fails closed when any batch task is skipped, pointing at --artist-ids", async () => {
    mockClient.current = libraryClient([{ id: 1, name: "One" }], []);
    mockRunBatch.mockResolvedValueOnce({
      lane: "local-only",
      summary: { total: 1, admitted: 0, succeeded: 0, failed: 0, skipped: 1, attempts: 0 },
      results: [
        {
          taskId: "lidarr-plan-album-monitoring-1",
          operation: "lidarr plan album monitoring",
          lane: "local-only",
          outcome: "skipped" as never,
          attempts: 0,
          value: [],
        },
      ],
    });

    await expect(executeLidarrAlbumPlan({ monitored: false, types: ["singles"] })).rejects.toThrow(
      /\(0 failed, 1 skipped\).*narrow with --artist-ids and retry/u,
    );
  });

  it("names the exact corrective --max-batch value on overflow", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [10, 20, 30].map((id) =>
        createLidarrAlbumFixture({ id, artistId: 1, albumType: "Single", monitored: true }),
      ),
    );

    await expect(
      executeLidarrAlbumPlan({ monitored: false, types: ["singles"], maxBatch: 2 }),
    ).rejects.toThrow(
      /planned 3 change\(s\) exceed --max-batch 2; re-run with --max-batch 3 or narrow --types\/--artist-ids/u,
    );
  });

  it("suggests passing fewer --album-ids on overflow in explicit-ID mode", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [10, 20, 30].map((id) => createLidarrAlbumFixture({ id, artistId: 1, monitored: true })),
    );

    await expect(
      executeLidarrAlbumPlan({ monitored: false, albumIds: [10, 20, 30], maxBatch: 2 }),
    ).rejects.toThrow(
      /planned 3 change\(s\) exceed --max-batch 2; re-run with --max-batch 3 or pass fewer --album-ids/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("advises --artist-ids slicing beyond the 1000-entry plan cap", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      Array.from({ length: 1001 }, (_unused, index) =>
        createLidarrAlbumFixture({
          id: index + 1,
          artistId: 1,
          albumType: "Single",
          monitored: true,
        }),
      ),
    );

    await expect(
      executeLidarrAlbumPlan({ monitored: false, types: ["singles"], maxBatch: 1000 }),
    ).rejects.toThrow(
      /planned 1001 change\(s\) exceed the 1000-entry plan cap; split the work with --artist-ids/u,
    );
  });

  it("rejects duplicate explicit IDs before touching Lidarr", async () => {
    await expect(
      executeLidarrAlbumPlan({ monitored: false, albumIds: [10, 10] }),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    await expect(
      executeLidarrAlbumPlan({ monitored: false, types: ["singles"], artistIds: [1, 1] }),
    ).rejects.toThrow(/artist IDs must be unique/u);
    expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
  });

  it("keeps preview and written v3 payloads in parity", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [createLidarrAlbumFixture({ id: 10, artistId: 1, albumType: "Single", monitored: true })],
    );

    const preview = await executeLidarrAlbumPlan({
      monitored: false,
      types: ["singles"],
      dryRun: true,
    });
    const written = await executeLidarrAlbumPlan({
      monitored: false,
      types: ["singles"],
      output: "/tmp/rfmedia-album-plan.json",
    });

    if (preview.status !== "previewed") throw new Error("expected a previewed result");
    if (written.status !== "planned") throw new Error("expected a planned result");
    const {
      id: _previewId,
      createdAt: _previewCreatedAt,
      payloadChecksum: _previewChecksum,
      ...previewPayload
    } = preview.plan;
    const {
      id: _writtenId,
      createdAt: _writtenCreatedAt,
      payloadChecksum: _writtenChecksum,
      ...writtenPayload
    } = written.plan;
    expect(writtenPayload).toEqual(previewPayload);
    expect(written.planPath).toBe("/tmp/rfmedia-album-plan.json");
    expect(mockWritePlanArtifact).toHaveBeenCalledWith(
      "/tmp/rfmedia-album-plan.json",
      written.plan,
    );
    expect(written.execution.outcome).toBe("succeeded");
  });
});
