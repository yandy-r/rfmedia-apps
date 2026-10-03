import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrArtistFixture,
  createLidarrArtistStatisticsFixture,
  createLidarrProfileFixture,
  createLidarrTagFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockResolveClient = vi.hoisted(() => vi.fn(() => mockClient.current));
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "artist-delete-plan",
      operation: "lidarr plan artist-delete",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveClient,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { setLoadedConfig } from "../../lib/loaded-config.js";
import { readLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import { LIDARR_PLAN_VERSION_V3 } from "../../types/lidarr-plan.js";
import {
  executeLidarrArtistDeletePlan,
  type LidarrArtistDeletePlanActionOptions,
} from "./plan-artist-delete.js";

const roots: string[] = [];
const artists = [
  createLidarrArtistFixture({
    id: 9,
    artistName: "Nine",
    monitored: true,
    qualityProfileId: 5,
    metadataProfileId: 2,
    path: "/music/Nine",
    tags: [4, 8],
    statistics: createLidarrArtistStatisticsFixture({
      albumCount: 3,
      trackFileCount: 30,
      sizeOnDisk: 3_000,
    }),
  }),
  createLidarrArtistFixture({
    id: 2,
    artistName: "Two",
    monitored: false,
    qualityProfileId: 6,
    metadataProfileId: 2,
    path: "/music/Two",
    tags: [4],
    statistics: createLidarrArtistStatisticsFixture({
      albumCount: 0,
      trackFileCount: 0,
      sizeOnDisk: 0,
    }),
  }),
];

function currentClient() {
  return mockClient.current as ReturnType<typeof createLidarrClientMock>;
}

async function outputPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-artist-delete-plan-"));
  roots.push(root);
  return join(root, "plan.json");
}

async function execute(overrides: Partial<LidarrArtistDeletePlanActionOptions> = {}) {
  return executeLidarrArtistDeletePlan({
    all: true,
    output: await outputPath(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setLoadedConfig({
    lidarr: {
      cascadeAnalysis: {
        assumptions: {
          albumsPerArtist: 4,
          indexerQueriesPerCandidate: 2,
        },
        budgets: {
          indexerQueries: 1,
          acquisitionCandidates: 1,
        },
      },
    },
  });
  mockClient.current = createLidarrClientMock({
    listArtists: async () => [...artists],
    listQualityProfiles: async () => [
      createLidarrProfileFixture({ id: 5, name: "Lossless" }),
      createLidarrProfileFixture({ id: 6, name: "Any" }),
    ],
    listMetadataProfiles: async () => [createLidarrProfileFixture({ id: 2, name: "Standard" })],
    listTags: async () => [
      createLidarrTagFixture({ id: 4, label: "Favorite" }),
      createLidarrTagFixture({ id: 8, label: "Curated" }),
    ],
  });
});

afterEach(async () => {
  setLoadedConfig({});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executeLidarrArtistDeletePlan", () => {
  it("writes a deterministic keep-files plan from one fresh artist snapshot", async () => {
    const result = await execute();

    expect(result.plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(result.plan.operation).toEqual({ kind: "artist-delete", deleteFiles: false });
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([2, 9]);
    expect(result.plan.entries).toMatchObject([
      {
        artistId: 2,
        before: {
          path: "/music/Two",
          albumCount: 0,
          trackFileCount: 0,
          sizeOnDisk: 0,
        },
        after: { exists: false },
      },
      {
        artistId: 9,
        before: {
          path: "/music/Nine",
          albumCount: 3,
          trackFileCount: 30,
          sizeOnDisk: 3_000,
        },
        after: { exists: false },
      },
    ]);
    expect(result.plan.summary).toEqual({
      kind: "artist-delete",
      artists: 2,
      albums: 3,
      trackFiles: 30,
      sizeOnDisk: 3_000,
    });
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      basis: "operation-removes-acquisition-scope",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries).toMatchObject({
      value: 0,
      certainty: "exact",
    });
    expect(result.plan.cascadeAnalysis.metrics.filesAffected.value).toBe(0);
    expect(result.plan.cascadeAnalysis.metrics.bytesAffected.value).toBe(0);
    await expect(readLidarrPlanArtifact(result.planPath)).resolves.toEqual(result.plan);
    expect(currentClient().listArtists).toHaveBeenCalledTimes(1);
    expect(currentClient().deleteArtist).not.toHaveBeenCalled();
  });

  it("forwards resolved AND filters and explicit delete-files intent", async () => {
    const result = await execute({
      all: undefined,
      selectMonitored: true,
      selectQualityProfile: "Lossless",
      selectMetadataProfile: "2",
      selectTags: ["Favorite", "8"],
      deleteFiles: true,
      dryRun: true,
    });

    expect(result.plan.selection).toEqual({
      kind: "filters",
      monitored: true,
      qualityProfile: { id: 5, name: "Lossless" },
      metadataProfile: { id: 2, name: "Standard" },
      tags: [
        { id: 4, label: "Favorite" },
        { id: 8, label: "Curated" },
      ],
    });
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([9]);
    expect(result.plan.operation).toEqual({ kind: "artist-delete", deleteFiles: true });
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates.value).toBe(0);
    expect(result.plan.cascadeAnalysis.metrics.filesAffected).toMatchObject({
      value: 30,
      certainty: "exact",
      horizon: "immediate",
    });
    expect(result.plan.cascadeAnalysis.metrics.bytesAffected).toMatchObject({
      value: 3_000,
      certainty: "exact",
      horizon: "immediate",
    });
    expect(result.plan.cascadeAnalysis.budgets).toMatchObject({
      indexerQueries: { status: "within", projected: 0, limit: 1 },
      acquisitionCandidates: { status: "within", projected: 0, limit: 1 },
    });
    expect(currentClient().listArtists).toHaveBeenCalledTimes(1);
    expect(currentClient().listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(currentClient().listMetadataProfiles).toHaveBeenCalledTimes(1);
    expect(currentClient().listTags).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "missing path",
      artist: createLidarrArtistFixture({ id: 1, path: undefined }),
      message: /artist 1.*path/iu,
    },
    {
      label: "empty path",
      artist: createLidarrArtistFixture({ id: 1, path: "" }),
      message: /artist 1.*path/iu,
    },
    {
      label: "missing statistics",
      artist: createLidarrArtistFixture({ id: 1, path: "/music/One", statistics: undefined }),
      message: /artist 1.*statistics/iu,
    },
    {
      label: "negative album count",
      artist: createLidarrArtistFixture({
        id: 1,
        path: "/music/One",
        statistics: createLidarrArtistStatisticsFixture({ albumCount: -1 }),
      }),
      message: /artist 1.*albumCount/iu,
    },
    {
      label: "unsafe track-file count",
      artist: createLidarrArtistFixture({
        id: 1,
        path: "/music/One",
        statistics: createLidarrArtistStatisticsFixture({
          trackFileCount: Number.MAX_SAFE_INTEGER + 1,
        }),
      }),
      message: /artist 1.*trackFileCount/iu,
    },
    {
      label: "non-integer bytes",
      artist: createLidarrArtistFixture({
        id: 1,
        path: "/music/One",
        statistics: createLidarrArtistStatisticsFixture({ sizeOnDisk: 1.5 }),
      }),
      message: /artist 1.*sizeOnDisk/iu,
    },
  ])("fails closed for $label without writing an artifact", async ({ artist, message }) => {
    currentClient().listArtists.mockResolvedValue([artist]);
    const output = await outputPath();

    await expect(executeLidarrArtistDeletePlan({ all: true, output })).rejects.toBeInstanceOf(
      LidarrPlanValidationError,
    );
    await expect(executeLidarrArtistDeletePlan({ all: true, output })).rejects.toThrow(message);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the whole cohort when it exceeds maxBatch", async () => {
    const output = await outputPath();

    await expect(executeLidarrArtistDeletePlan({ all: true, maxBatch: 1, output })).rejects.toThrow(
      /matched 2 artists, exceeding maxBatch 1/iu,
    );
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the complete plan without writing during planning dry-run", async () => {
    const output = await outputPath();

    const result = await executeLidarrArtistDeletePlan({
      artistIds: [9, 2],
      output,
      dryRun: true,
    });

    expect(result.planPath).toBe(output);
    expect(result.plan.selection).toEqual({ kind: "ids", artistIds: [2, 9] });
    expect(result.plan.entries).toHaveLength(2);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
