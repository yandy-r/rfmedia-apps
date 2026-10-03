import { describe, expect, it } from "vitest";

import type { MediaPage, MediaTrack } from "../types/media-server.js";
import { advancePaginationOffset, type PaginationPageMetadata } from "./pagination.js";

describe("advancePaginationOffset", () => {
  it("keeps the current offset when the response has no more pages", () => {
    expect(advancePaginationOffset({ offset: 100, returned: 50, hasMore: false }, "tracks")).toBe(
      100,
    );
    expect(advancePaginationOffset({ offset: 0, returned: 0, hasMore: false }, "albums")).toBe(0);
  });

  it("advances consecutive pages by the server-returned count", () => {
    expect(advancePaginationOffset({ offset: 0, returned: 500, hasMore: true }, "tracks")).toBe(
      500,
    );
    expect(advancePaginationOffset({ offset: 500, returned: 500, hasMore: true }, "tracks")).toBe(
      1000,
    );
  });

  it("advances a short page by its actual returned count", () => {
    expect(advancePaginationOffset({ offset: 500, returned: 7, hasMore: true }, "tracks")).toBe(
      507,
    );
  });

  it("does not require total metadata to make progress", () => {
    const metadata: PaginationPageMetadata = {
      offset: 10,
      returned: 10,
      hasMore: true,
    };

    expect(advancePaginationOffset(metadata, "albums")).toBe(20);
  });

  it("uses the pre-residual returned count when filtering empties the visible items", () => {
    const filteredPage: MediaPage<MediaTrack> = {
      items: [],
      total: 100,
      offset: 0,
      returned: 25,
      hasMore: true,
    };

    expect(advancePaginationOffset(filteredPage, "tracks")).toBe(25);
  });

  it("rejects a stalled page that claims more results", () => {
    expect(() =>
      advancePaginationOffset({ offset: 0, returned: 0, hasMore: true }, "tracks"),
    ).toThrow(
      "Pagination stalled while querying tracks: server reported more results but returned an empty page",
    );
    expect(() =>
      advancePaginationOffset({ offset: 500, returned: 0, hasMore: true }, "artists"),
    ).toThrow(
      "Pagination stalled while querying artists: server reported more results but returned an empty page",
    );
  });
});
