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
  vi.fn(async (_tier: unknown, task: { id: string; run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: task.id,
      operation: "lidarr albums",
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

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle, runBatch: mockRunBatch }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
}));

import { MissingRequiredArgumentError, OptionConflictError } from "../../lib/errors.js";
import { executeLidarrAlbums, TIER } from "./albums.js";

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

describe("executeLidarrAlbums", () => {
  it("rejects zero scopes and every scope combination before touching Lidarr", async () => {
    await expect(executeLidarrAlbums({ limit: 50, offset: 0 })).rejects.toThrow(
      /Choose exactly one selection scope: --artist-ids, --album-ids, or --all/u,
    );
    await expect(executeLidarrAlbums({ limit: 50, offset: 0 })).rejects.toBeInstanceOf(
      MissingRequiredArgumentError,
    );
    await expect(
      executeLidarrAlbums({ artistIds: [1], albumIds: [10], limit: 50, offset: 0 }),
    ).rejects.toThrow(/Choose exactly one selection scope/u);
    await expect(
      executeLidarrAlbums({ artistIds: [1], all: true, limit: 50, offset: 0 }),
    ).rejects.toThrow(/Choose exactly one selection scope/u);
    await expect(
      executeLidarrAlbums({ albumIds: [10], all: true, limit: 50, offset: 0 }),
    ).rejects.toThrow(/Choose exactly one selection scope/u);
    await expect(
      executeLidarrAlbums({ artistIds: [1], albumIds: [10], all: true, limit: 50, offset: 0 }),
    ).rejects.toThrow(/Choose exactly one selection scope/u);
    expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
  });

  it("rejects explicit album IDs combined with type selectors before touching Lidarr", async () => {
    await expect(
      executeLidarrAlbums({ albumIds: [10], types: ["singles"], limit: 50, offset: 0 }),
    ).rejects.toBeInstanceOf(OptionConflictError);
    await expect(
      executeLidarrAlbums({ albumIds: [10], types: ["singles"], limit: 50, offset: 0 }),
    ).rejects.toThrow(/Cannot use --album-ids with --types/u);
    expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
  });

  it("ANDs type, monitored, and file filters, counting absent statistics as no files", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 1,
          albumType: "Single",
          monitored: true,
          statistics: { trackCount: 2, trackFileCount: 2, sizeOnDisk: 1024 },
        }),
        // Absent statistics block: honestly reports as file-less.
        createLidarrAlbumFixture({ id: 11, artistId: 1, albumType: "Single", monitored: true }),
        createLidarrAlbumFixture({
          id: 12,
          artistId: 1,
          albumType: "Single",
          monitored: false,
          statistics: { trackFileCount: 3 },
        }),
        createLidarrAlbumFixture({
          id: 13,
          artistId: 1,
          albumType: "Album",
          monitored: true,
          statistics: { trackFileCount: 5 },
        }),
      ],
    );

    const withFiles = await executeLidarrAlbums({
      artistIds: [1],
      types: ["singles"],
      monitored: true,
      hasFiles: true,
      limit: 50,
      offset: 0,
    });
    expect(withFiles.albums.map((album) => album.id)).toEqual([10]);
    expect(withFiles.albums[0]?.artistName).toBe("One");
    expect(withFiles.total).toBe(1);
    expect(withFiles.scanned).toEqual({ artists: 1, albums: 4 });
    expect(withFiles.pagination).toEqual({ limit: 50, offset: 0, returned: 1 });

    const withoutFiles = await executeLidarrAlbums({
      artistIds: [1],
      types: ["singles"],
      monitored: true,
      hasFiles: false,
      limit: 50,
      offset: 0,
    });
    expect(withoutFiles.albums.map((album) => album.id)).toEqual([11]);
    expect(withoutFiles.total).toBe(1);
  });

  it("windows a deterministic (artistId, albumId) sort under --all with stable task ids", async () => {
    expect(TIER).toBe("local-only");
    mockClient.current = libraryClient(
      [
        { id: 2, name: "Two" },
        { id: 1, name: "One" },
      ],
      [
        // Server order is deliberately scrambled within each artist listing.
        createLidarrAlbumFixture({ id: 21, artistId: 2, title: "B2" }),
        createLidarrAlbumFixture({ id: 20, artistId: 2, title: "B1" }),
        createLidarrAlbumFixture({ id: 12, artistId: 1, title: "A2" }),
        createLidarrAlbumFixture({ id: 10, artistId: 1, title: "A1" }),
      ],
    );

    const result = await executeLidarrAlbums({ all: true, limit: 2, offset: 1 });

    expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(expect.anything(), {
      tier: "local-only",
      retryAttemptsOverride: 0,
    });
    const [, tasks] = mockRunBatch.mock.calls[0]!;
    expect(tasks.map((task) => task.id)).toEqual(["lidarr-albums-2", "lidarr-albums-1"]);
    // Sorted listing is [10, 12, 20, 21]; offset 1 + limit 2 → [12, 20].
    expect(result.albums.map((album) => album.id)).toEqual([12, 20]);
    expect(result.albums.map((album) => album.artistName)).toEqual(["One", "Two"]);
    expect(result.total).toBe(4);
    expect(result.scanned).toEqual({ artists: 2, albums: 4 });
    expect(result.pagination).toEqual({ limit: 2, offset: 1, returned: 2 });
    expect(result.execution.outcome).toBe("succeeded");
  });

  it("returns an empty window with honest accounting when offset is beyond total", async () => {
    const client = libraryClient(
      [{ id: 1, name: "One" }],
      [
        createLidarrAlbumFixture({ id: 10, artistId: 1 }),
        createLidarrAlbumFixture({ id: 20, artistId: 1 }),
      ],
    );
    mockClient.current = client;

    const result = await executeLidarrAlbums({ albumIds: [10, 20], limit: 5, offset: 9 });

    expect(client.listAlbums).toHaveBeenCalledWith({ albumIds: [10, 20] });
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(result.albums).toEqual([]);
    expect(result.total).toBe(2);
    expect(result.scanned).toEqual({ artists: 1, albums: 2 });
    expect(result.pagination).toEqual({ limit: 5, offset: 9, returned: 0 });
  });

  it("aborts with no partial listing when any batch task fails", async () => {
    mockClient.current = libraryClient(
      [{ id: 1, name: "One" }],
      [createLidarrAlbumFixture({ id: 10, artistId: 1 })],
    );
    mockRunBatch.mockResolvedValueOnce({
      lane: "local-only",
      summary: { total: 1, admitted: 1, succeeded: 0, failed: 1, skipped: 0, attempts: 1 },
      results: [
        {
          taskId: "lidarr-albums-1",
          operation: "lidarr albums",
          lane: "local-only",
          outcome: "failed" as never,
          attempts: 1,
          value: [],
        },
      ],
    });

    await expect(executeLidarrAlbums({ all: true, limit: 50, offset: 0 })).rejects.toThrow(
      /album listing did not complete \(1 failed, 0 skipped\)/u,
    );
  });
});
