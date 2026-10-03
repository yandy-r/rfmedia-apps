import { describe, expect, it } from "vitest";

import { createLidarrAlbumFixture } from "../../actions/test-helpers/lidarr-fixtures.js";
import {
  countBySelector,
  dedupeAlbums,
  filterLidarrAlbums,
  pageLidarrAlbums,
  sortLidarrAlbumsDeterministic,
} from "./album-selection.js";

describe("filterLidarrAlbums", () => {
  it("ANDs the types, monitored, and hasFiles dimensions", () => {
    const albums = [
      createLidarrAlbumFixture({
        id: 1,
        albumType: "Single",
        monitored: true,
        statistics: { trackFileCount: 3 },
      }),
      createLidarrAlbumFixture({
        id: 2,
        albumType: "Single",
        monitored: false,
        statistics: { trackFileCount: 3 },
      }),
      createLidarrAlbumFixture({
        id: 3,
        albumType: "Single",
        monitored: true,
        statistics: { trackFileCount: 0 },
      }),
      createLidarrAlbumFixture({
        id: 4,
        albumType: "Album",
        monitored: true,
        statistics: { trackFileCount: 3 },
      }),
    ];

    const result = filterLidarrAlbums(albums, {
      types: ["singles"],
      monitored: true,
      hasFiles: true,
    });

    expect(result.map((album) => album.id)).toEqual([1]);
  });

  it("ORs selectors within the types dimension", () => {
    const albums = [
      createLidarrAlbumFixture({ id: 1, albumType: "Single" }),
      createLidarrAlbumFixture({ id: 2, albumType: "Album", secondaryTypes: ["Live"] }),
      createLidarrAlbumFixture({ id: 3, albumType: "Album" }),
    ];

    const result = filterLidarrAlbums(albums, { types: ["singles", "live"] });

    expect(result.map((album) => album.id)).toEqual([1, 2]);
  });

  it("treats an absent statistics block as zero files", () => {
    const scanned = createLidarrAlbumFixture({ id: 1, statistics: { trackFileCount: 1 } });
    const unscanned = createLidarrAlbumFixture({ id: 2 });
    const uncounted = createLidarrAlbumFixture({ id: 3, statistics: {} });

    expect(
      filterLidarrAlbums([scanned, unscanned, uncounted], { hasFiles: true }).map((a) => a.id),
    ).toEqual([1]);
    expect(
      filterLidarrAlbums([scanned, unscanned, uncounted], { hasFiles: false }).map((a) => a.id),
    ).toEqual([2, 3]);
  });

  it("returns a frozen array", () => {
    expect(Object.isFrozen(filterLidarrAlbums([createLidarrAlbumFixture()], {}))).toBe(true);
  });
});

describe("sortLidarrAlbumsDeterministic", () => {
  it("orders by artistId ascending, then album id ascending", () => {
    const albums = [
      createLidarrAlbumFixture({ id: 30, artistId: 2 }),
      createLidarrAlbumFixture({ id: 20, artistId: 1 }),
      createLidarrAlbumFixture({ id: 10, artistId: 2 }),
      createLidarrAlbumFixture({ id: 5, artistId: 1 }),
    ];

    const sorted = sortLidarrAlbumsDeterministic(albums);

    expect(sorted.map((album) => [album.artistId, album.id])).toEqual([
      [1, 5],
      [1, 20],
      [2, 10],
      [2, 30],
    ]);
    // Stable-pagination contract: the input order never leaks through.
    expect(albums.map((album) => album.id)).toEqual([30, 20, 10, 5]);
    expect(Object.isFrozen(sorted)).toBe(true);
  });
});

describe("pageLidarrAlbums", () => {
  const albums = sortLidarrAlbumsDeterministic(
    [1, 2, 3, 4, 5].map((id) => createLidarrAlbumFixture({ id, artistId: 1 })),
  );

  it("windows with limit and offset after the deterministic sort", () => {
    expect(pageLidarrAlbums(albums, { limit: 2, offset: 1 }).map((a) => a.id)).toEqual([2, 3]);
    expect(pageLidarrAlbums(albums, { limit: 2 }).map((a) => a.id)).toEqual([1, 2]);
    expect(pageLidarrAlbums(albums, { offset: 3 }).map((a) => a.id)).toEqual([4, 5]);
    expect(pageLidarrAlbums(albums, {}).map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("yields an empty frozen array when the offset is at or beyond the total", () => {
    const beyond = pageLidarrAlbums(albums, { offset: 5 });
    expect(beyond).toEqual([]);
    expect(Object.isFrozen(beyond)).toBe(true);
    expect(pageLidarrAlbums(albums, { limit: 10, offset: 99 })).toEqual([]);
  });

  it("rejects negative or non-integer windows", () => {
    expect(() => pageLidarrAlbums(albums, { offset: -1 })).toThrow(RangeError);
    expect(() => pageLidarrAlbums(albums, { limit: 1.5 })).toThrow(RangeError);
  });
});

describe("dedupeAlbums", () => {
  it("keeps the first occurrence of each album id", () => {
    const first = createLidarrAlbumFixture({ id: 1, title: "First" });
    const duplicate = createLidarrAlbumFixture({ id: 1, title: "Duplicate" });
    const other = createLidarrAlbumFixture({ id: 2 });

    const result = dedupeAlbums([first, duplicate, other]);

    expect(result.map((album) => album.title)).toEqual(["First", "Album 1"]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("countBySelector", () => {
  it("counts a multi-selector album once per matching selector", () => {
    const albums = [
      createLidarrAlbumFixture({ id: 1, albumType: "Single", secondaryTypes: ["Live"] }),
      createLidarrAlbumFixture({ id: 2, albumType: "Single" }),
    ];

    const counts = countBySelector(albums, ["singles", "live", "demos"]);

    expect(counts).toEqual({ singles: 2, live: 1, demos: 0 });
    expect(Object.isFrozen(counts)).toBe(true);
  });

  it("returns an empty frozen record for no selectors", () => {
    expect(countBySelector([createLidarrAlbumFixture()], [])).toEqual({});
  });
});
