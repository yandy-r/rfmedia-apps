import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      taskId: "plan-album-edit",
      operation: "lidarr plan album edit",
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

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle, runBatch: mockRunBatch }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));

vi.mock("../../lib/lidarr/plan-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/lidarr/plan-engine.js")>();
  return { ...actual, writeLidarrPlanArtifact: mockWritePlanArtifact };
});

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { setLoadedConfig } from "../../lib/loaded-config.js";
import { LIDARR_PLAN_VERSION_V3 } from "../../types/lidarr-plan.js";
import { executeLidarrAlbumEditPlan, TIER } from "./plan-album-edit.js";

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
  setLoadedConfig({
    lidarr: {
      cascadeAnalysis: {
        assumptions: { indexerQueriesPerCandidate: 2 },
        budgets: {
          indexerQueries: 10,
          acquisitionCandidates: 5,
        },
      },
    },
  });
  mockClient.current = createLidarrClientMock();
});

afterEach(() => {
  setLoadedConfig({});
});

describe("executeLidarrAlbumEditPlan", () => {
  it("runs on the local-only lane, disables in-place retries, and uses its own task ids", async () => {
    expect(TIER).toBe("local-only");
    mockClient.current = libraryClient([{ id: 1, name: "One" }], []);

    await executeLidarrAlbumEditPlan({
      desiredAnyReleaseOk: true,
      types: ["singles"],
      dryRun: true,
    });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(expect.anything(), {
      tier: "local-only",
      retryAttemptsOverride: 0,
    });
    const [, tasks] = mockRunBatch.mock.calls[0]!;
    expect(tasks.map((task) => task.id)).toEqual(["lidarr-plan-album-edit-1"]);
    expect(tasks.map((task) => task.operation)).toEqual(["lidarr plan album edit"]);
  });

  it("enforces the album-monitoring selection triad before touching Lidarr", async () => {
    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, albumIds: [10], types: ["singles"] }),
    ).rejects.toThrow(/--album-ids conflicts with --types and --artist-ids/u);
    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, albumIds: [10], artistIds: [1] }),
    ).rejects.toThrow(/--album-ids conflicts with --types and --artist-ids/u);
    await expect(executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true })).rejects.toThrow(
      /pass --types or --album-ids to select albums/u,
    );
    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, albumIds: [10, 10] }),
    ).rejects.toThrow(/album IDs must be unique/u);
    await expect(
      executeLidarrAlbumEditPlan({
        desiredAnyReleaseOk: true,
        types: ["singles"],
        artistIds: [1, 1],
      }),
    ).rejects.toThrow(/artist IDs must be unique/u);
    expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
  });

  it("plans changes-only entries with honest alreadyInDesiredState accounting", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 1,
          albumType: "Single",
          monitored: true,
          anyReleaseOk: false,
        }),
        createLidarrAlbumFixture({
          id: 11,
          artistId: 1,
          albumType: "Single",
          monitored: true,
          anyReleaseOk: true,
        }),
        createLidarrAlbumFixture({
          id: 12,
          artistId: 1,
          albumType: "Album",
          monitored: true,
          anyReleaseOk: false,
        }),
      ],
    );

    const result = await executeLidarrAlbumEditPlan({
      desiredAnyReleaseOk: true,
      types: ["singles"],
      artistIds: [1],
      dryRun: true,
    });

    expect(result.status).toBe("previewed");
    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(result.selection).toEqual({
      artistsScanned: 1,
      albumsScanned: 3,
      matched: 2,
      alreadyInDesiredState: 1,
      planned: 1,
      bySelector: { singles: 2 },
    });
    expect(result.plan.operation).toEqual({
      kind: "album-edit",
      desiredAnyReleaseOk: true,
      selectors: ["singles"],
    });
    expect(result.plan.selection).toEqual({
      kind: "album-filters",
      artistIds: [1],
      selectors: ["singles"],
    });
    expect(result.plan.entries).toEqual([
      expect.objectContaining({
        id: "album:10",
        albumId: 10,
        before: { anyReleaseOk: false },
        after: { anyReleaseOk: true },
      }),
    ]);
    expect(result.plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      basis: "release-automation-evidence-unavailable",
    });
    expect(result.plan.cascadeAnalysis.budgets).toMatchObject({
      indexerQueries: { status: "unknown", limit: 10, projected: null },
      acquisitionCandidates: { status: "unknown", limit: 5, projected: null },
    });
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("fails closed when Lidarr omits anyReleaseOk for a matched album", async () => {
    const client = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, anyReleaseOk: false }),
        createLidarrAlbumFixture({ id: 11, artistId: 1 }),
        createLidarrAlbumFixture({ id: 12, artistId: 1 }),
      ],
    );
    mockClient.current = client;

    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, albumIds: [10, 11, 12] }),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, albumIds: [10, 11, 12] }),
    ).rejects.toThrow(/Lidarr did not report anyReleaseOk for album IDs: 11, 12/u);
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
    expect(client.setAlbumAnyReleaseOk).not.toHaveBeenCalled();
  });

  it("plans exact album IDs changes-only and seals only the planned IDs", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1, anyReleaseOk: true }),
        createLidarrAlbumFixture({ id: 20, artistId: 1, anyReleaseOk: true }),
        createLidarrAlbumFixture({ id: 30, artistId: 1, anyReleaseOk: false }),
      ],
    );

    const result = await executeLidarrAlbumEditPlan({
      desiredAnyReleaseOk: false,
      albumIds: [30, 20, 10],
      dryRun: true,
    });

    if (result.status !== "previewed") throw new Error("expected a previewed result");
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(result.selection).toMatchObject({ matched: 3, alreadyInDesiredState: 1, planned: 2 });
    // The sealed explicit selection lists exactly the planned albums, sorted.
    expect(result.plan.selection).toEqual({ kind: "album-ids", albumIds: [10, 20] });
    expect(result.plan.operation).toEqual({
      kind: "album-edit",
      desiredAnyReleaseOk: false,
      selectors: [],
    });
    expect(result.plan.entries.map((entry) => entry.albumId)).toEqual([10, 20]);
    expect(result.selection.bySelector).toEqual({});
  });

  it("names the exact corrective --max-batch value with per-mode narrow-hints", async () => {
    const albums = [10, 20, 30].map((id) =>
      createLidarrAlbumFixture({ id, artistId: 1, albumType: "Single", anyReleaseOk: false }),
    );
    mockClient.current = libraryClient([{ id: 1, name: "One" }], albums);

    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, types: ["singles"], maxBatch: 2 }),
    ).rejects.toThrow(
      /planned 3 change\(s\) exceed --max-batch 2; re-run with --max-batch 3 or narrow --types\/--artist-ids/u,
    );
    await expect(
      executeLidarrAlbumEditPlan({
        desiredAnyReleaseOk: true,
        albumIds: [10, 20, 30],
        maxBatch: 2,
      }),
    ).rejects.toThrow(
      /planned 3 change\(s\) exceed --max-batch 2; re-run with --max-batch 3 or pass fewer --album-ids/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("returns no-change in dry-run and throws when sealing would write an empty plan", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 1,
          albumType: "Single",
          anyReleaseOk: true,
        }),
      ],
    );

    const result = await executeLidarrAlbumEditPlan({
      desiredAnyReleaseOk: true,
      types: ["singles"],
      dryRun: true,
    });
    expect(result.status).toBe("no-change");
    expect(result.selection).toMatchObject({ matched: 1, alreadyInDesiredState: 1, planned: 0 });

    await expect(
      executeLidarrAlbumEditPlan({ desiredAnyReleaseOk: true, types: ["singles"] }),
    ).rejects.toThrow(
      /no album release-policy changes to plan; inspect the selection with --dry-run/u,
    );
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
  });

  it("previews in dry-run without writing and seals a plan artifact on a real run", async () => {
    const client = libraryClient(
      [{ id: 1, name: "One" }],
      [createLidarrAlbumFixture({ id: 10, artistId: 1, albumType: "Single", anyReleaseOk: true })],
    );
    mockClient.current = client;

    const previewed = await executeLidarrAlbumEditPlan({
      desiredAnyReleaseOk: false,
      types: ["singles"],
      dryRun: true,
    });
    expect(previewed.status).toBe("previewed");
    if (previewed.status !== "previewed") throw new Error("expected a previewed result");
    expect(mockWritePlanArtifact).not.toHaveBeenCalled();
    expect(client.setAlbumAnyReleaseOk).not.toHaveBeenCalled();

    const planned = await executeLidarrAlbumEditPlan({
      desiredAnyReleaseOk: false,
      types: ["singles"],
      output: "/tmp/rfmedia-album-edit-plan.json",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error("expected a planned result");
    expect(planned.planPath).toBe("/tmp/rfmedia-album-edit-plan.json");
    expect(mockWritePlanArtifact).toHaveBeenCalledWith(
      "/tmp/rfmedia-album-edit-plan.json",
      planned.plan,
    );
    expect(previewed.plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(planned.plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(previewed.plan.cascadeAnalysis).toEqual(planned.plan.cascadeAnalysis);
    expect(planned.plan.cascadeAnalysis.metrics.acquisitionCandidates.value).toBeNull();
    expect(planned.plan.cascadeAnalysis.budgets).toMatchObject({
      indexerQueries: { status: "unknown", projected: null },
      acquisitionCandidates: { status: "unknown", projected: null },
    });
    expect(planned.execution.outcome).toBe("succeeded");
    expect(client.setAlbumAnyReleaseOk).not.toHaveBeenCalled();
  });
});
