import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrTrack, LidarrTrackFile } from "../../types/lidarr.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockReadRating = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "track-filter",
      operation: "lidarr plan track filter",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);
const mockGetLoadedLidarrConfig = vi.hoisted(() =>
  vi.fn(() => ({
    cascadeAnalysis: {
      assumptions: { indexerQueriesPerCandidate: 2 },
    },
  })),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: () => mockClient.current,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));
vi.mock("../../lib/ratings.js", () => ({ readRating: mockReadRating }));
vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: mockGetLoadedLidarrConfig,
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { readLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import { executeLidarrTrackFilterPlan } from "./plan-track-filter.js";

function track(overrides: Partial<LidarrTrack> = {}): LidarrTrack {
  return {
    id: 1,
    artistId: 7,
    albumId: 11,
    title: "Track 1",
    trackFileId: 101,
    absoluteTrackNumber: 1,
    mediumNumber: 1,
    hasFile: true,
    ...overrides,
  };
}

function trackFile(overrides: Partial<LidarrTrackFile> = {}): LidarrTrackFile {
  return {
    id: 101,
    artistId: 7,
    albumId: 11,
    path: "/music/album/01.flac",
    size: 1_000,
    ...overrides,
  };
}

let client: LidarrClientMock;
const roots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  const tracks = [
    track(),
    track({
      id: 2,
      title: "Track 2",
      trackFileId: 102,
      absoluteTrackNumber: 2,
    }),
    track({
      id: 3,
      title: "Track 3",
      trackFileId: 103,
      absoluteTrackNumber: 3,
    }),
    track({
      id: 4,
      title: "Missing",
      trackFileId: undefined,
      absoluteTrackNumber: 4,
      hasFile: false,
    }),
  ];
  const trackFiles = [
    trackFile(),
    trackFile({ id: 102, path: "/music/album/02.flac", size: 2_000 }),
    trackFile({ id: 103, path: "/music/album/03.flac", size: 3_000 }),
  ];
  client = createLidarrClientMock({
    listAlbums: async () => [createLidarrAlbumFixture({ id: 11, artistId: 7 })],
    getArtist: async () => createLidarrArtistFixture({ id: 7, artistName: "Artist" }),
    listTracks: async () => tracks,
    listTrackFiles: async () => trackFiles,
  });
  mockClient.current = client;
  mockReadRating.mockImplementation(async (path: string) => {
    const ratings: Record<string, number> = {
      "/music/album/01.flac": 0.1,
      "/music/album/02.flac": 0.8,
      "/music/album/03.flac": 0.2,
    };
    return { value: ratings[path], source: "Vorbis" };
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executeLidarrTrackFilterPlan", () => {
  it("unions explicit retention with ratings and retains uncertain tracks", async () => {
    const result = await executeLidarrTrackFilterPlan({
      albumId: 11,
      keepTrackIds: [1],
      minStars: 3,
      dryRun: true,
    });

    expect(result.status).toBe("previewed");
    if (result.status !== "previewed") throw new Error("expected preview");
    expect(result.plan.version).toBe("rfmedia.lidarr-plan.v3");
    expect(result.plan.entries[0].before.albumMonitored).toBe(true);
    expect(result.plan.operation).toEqual({
      kind: "track-file-filter",
      explicitKeepTrackIds: [1],
      minStars: 3,
    });
    expect(result.plan.entries[0].keptTrackIds).toEqual([1, 2, 4]);
    expect(result.plan.entries[0].before.deleteCandidates).toEqual([
      expect.objectContaining({ trackId: 3, trackFileId: 103, rating: 0.2 }),
    ]);
    expect(result.plan.entries[0].warnings).toEqual([
      expect.objectContaining({ code: "missing-file", trackId: 4 }),
    ]);
    expect(mockReadRating).toHaveBeenCalledTimes(2);
    expect(mockReadRating).not.toHaveBeenCalledWith("/music/album/01.flac");
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
  });

  it.each([
    {
      albumMonitored: true,
      acquisitionCandidates: 1,
      conditionalIndexerQueries: 2,
      basis: "monitored-album-file-removal",
    },
    {
      albumMonitored: false,
      acquisitionCandidates: 0,
      conditionalIndexerQueries: 0,
      basis: "unmonitored-album-file-removal",
    },
  ] as const)(
    "seals albumMonitored=$albumMonitored with preview/write parity",
    async ({ albumMonitored, acquisitionCandidates, conditionalIndexerQueries, basis }) => {
      client.listAlbums.mockResolvedValue([
        createLidarrAlbumFixture({ id: 11, artistId: 7, monitored: albumMonitored }),
      ]);
      const options = { albumId: 11, keepTrackIds: [1] };

      const preview = await executeLidarrTrackFilterPlan({ ...options, dryRun: true });
      expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(1);
      const root = await mkdtemp(join(tmpdir(), "rfmedia-track-filter-plan-"));
      roots.push(root);
      const output = join(root, "plan.json");
      const written = await executeLidarrTrackFilterPlan({ ...options, output });

      if (preview.status !== "previewed") throw new Error("expected preview");
      if (written.status !== "planned") throw new Error("expected planned");
      expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(2);
      expect(preview.plan.version).toBe("rfmedia.lidarr-plan.v3");
      expect(preview.plan.entries[0].before.albumMonitored).toBe(albumMonitored);
      expect(preview.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
        value: acquisitionCandidates,
        certainty: "exact",
        basis,
      });
      expect(preview.plan.cascadeAnalysis.metrics.conditionalIndexerQueries.value).toBe(
        conditionalIndexerQueries,
      );
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
      await expect(readLidarrPlanArtifact(output)).resolves.toEqual(written.plan);
      expect(client.listAlbums).toHaveBeenCalledTimes(2);
      expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
    },
  );

  it("fails closed for unknown explicit IDs and an empty retained set", async () => {
    await expect(
      executeLidarrTrackFilterPlan({
        albumId: 11,
        keepTrackIds: [99],
        dryRun: true,
      }),
    ).rejects.toThrow("keep track IDs are not in album 11: 99");

    client.listTracks.mockResolvedValue([track()]);
    client.listTrackFiles.mockResolvedValue([trackFile()]);
    mockReadRating.mockResolvedValue({ value: 0.1, source: "Vorbis" });
    await expect(
      executeLidarrTrackFilterPlan({ albumId: 11, minStars: 5, dryRun: true }),
    ).rejects.toThrow("retention criteria would keep no tracks");
  });

  it("retains and warns on cross-parent and unreadable trackfiles", async () => {
    client.listTracks.mockResolvedValue([
      track(),
      track({ id: 2, trackFileId: 102, absoluteTrackNumber: 2 }),
    ]);
    client.listTrackFiles.mockResolvedValue([
      trackFile({ artistId: 9 }),
      trackFile({ id: 102, path: "/music/album/02.flac" }),
    ]);
    mockReadRating.mockResolvedValue(null);

    const result = await executeLidarrTrackFilterPlan({
      albumId: 11,
      minStars: 3,
      dryRun: true,
    });

    expect(result.status).toBe("no-change");
    expect(result.selection.warnings.map(({ code }) => code)).toEqual([
      "cross-album-file",
      "unrated-or-unreadable",
    ]);
    expect(result.selection.kept).toBe(2);
  });

  it("retains cross-parent tracks while planning valid same-parent candidates", async () => {
    client.listTracks.mockResolvedValue([
      track(),
      track({ id: 2, trackFileId: 102, absoluteTrackNumber: 2 }),
      track({ id: 3, albumId: 12, trackFileId: 103, absoluteTrackNumber: 3 }),
    ]);
    client.listTrackFiles.mockResolvedValue([
      trackFile(),
      trackFile({ id: 102, path: "/music/album/02.flac" }),
      trackFile({ id: 103, albumId: 12, path: "/music/other-album/03.flac" }),
    ]);
    mockReadRating.mockResolvedValue({ value: 0.1, source: "Vorbis" });

    const result = await executeLidarrTrackFilterPlan({
      albumId: 11,
      keepTrackIds: [1],
      minStars: 3,
      dryRun: true,
    });

    expect(result.status).toBe("previewed");
    if (result.status !== "previewed") throw new Error("expected preview");
    expect(result.plan.entries[0].keptTrackIds).toEqual([1, 3]);
    expect(result.plan.entries[0].before.deleteCandidates).toEqual([
      expect.objectContaining({ trackId: 2, trackFileId: 102, rating: 0.1 }),
    ]);
    expect(result.plan.entries[0].warnings).toEqual([
      {
        code: "cross-album-file",
        trackId: 3,
        message: "Track belongs to a different parent; retained",
      },
    ]);
    expect(mockReadRating).toHaveBeenCalledOnce();
    expect(mockReadRating).toHaveBeenCalledWith("/music/album/02.flac");
  });

  it("counts exact delete candidates against the defaultable batch guard", async () => {
    client.listTracks.mockResolvedValue([
      track(),
      track({ id: 2, trackFileId: 102, absoluteTrackNumber: 2 }),
    ]);
    client.listTrackFiles.mockResolvedValue([
      trackFile(),
      trackFile({ id: 102, path: "/music/album/02.flac" }),
    ]);

    await expect(
      executeLidarrTrackFilterPlan({
        albumId: 11,
        keepTrackIds: [1],
        maxBatch: 0,
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);

    client.listTracks.mockResolvedValue([
      track(),
      track({ id: 2, trackFileId: 102, absoluteTrackNumber: 2 }),
      track({ id: 3, trackFileId: 103, absoluteTrackNumber: 3 }),
    ]);
    client.listTrackFiles.mockResolvedValue([
      trackFile(),
      trackFile({ id: 102, path: "/music/album/02.flac" }),
      trackFile({ id: 103, path: "/music/album/03.flac" }),
    ]);
    await expect(
      executeLidarrTrackFilterPlan({
        albumId: 11,
        keepTrackIds: [1],
        maxBatch: 1,
        dryRun: true,
      }),
    ).rejects.toThrow("planned 2 trackfile deletion(s) exceed --max-batch 1");
  });
});
