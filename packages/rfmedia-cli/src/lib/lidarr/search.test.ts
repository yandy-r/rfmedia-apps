import { describe, expect, it } from "vitest";

import type { LidarrSearchCandidateInput } from "../../types/lidarr.js";
import { LidarrValidationError } from "./errors.js";
import {
  createLidarrSearchDiscriminator,
  LIDARR_SEARCH_DEFAULT_LIMIT,
  normalizeLidarrSearchTerm,
  pageLidarrSearchCandidates,
  rankLidarrSearchCandidates,
  resolveLidarrSearchPageOptions,
  shapeLidarrSearchCandidates,
} from "./search.js";

const ARTIST_ID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const ALBUM_ID = "2f176e00-9f5f-4a34-8e4b-57d0419b0d72";

function artist(
  foreignId: string,
  name: string,
  extras: Partial<LidarrSearchCandidateInput> = {},
): LidarrSearchCandidateInput {
  return { kind: "artist", foreignId, name, ...extras } as LidarrSearchCandidateInput;
}

function album(
  foreignId: string,
  name: string,
  extras: Partial<LidarrSearchCandidateInput> = {},
): LidarrSearchCandidateInput {
  return { kind: "album", foreignId, name, ...extras } as LidarrSearchCandidateInput;
}

describe("normalizeLidarrSearchTerm", () => {
  it("outer-trims, NFC-normalizes, and preserves ordinary case and internal whitespace", () => {
    expect(normalizeLidarrSearchTerm("  Cafe\u0301  del  Mar  ")).toBe("Café  del  Mar");
  });

  it.each([
    ["lidarr", ` LIDARR:${ARTIST_ID.toUpperCase()} `],
    ["lidarrid", `lidarrid:${ARTIST_ID}`],
    ["mbid", `MbId:${ARTIST_ID}`],
  ])("canonicalizes an exact %s prefix", (_name, term) => {
    expect(normalizeLidarrSearchTerm(term)).toBe(`lidarr:${ARTIST_ID}`);
  });

  it.each([
    "",
    "   ",
    "lidarr:",
    "lidarr:not-a-uuid",
    `mbid: ${ARTIST_ID}`,
    `lidarr:${ARTIST_ID}:extra`,
  ])("rejects an empty or malformed exact term: %j", (term) => {
    expect(() => normalizeLidarrSearchTerm(term)).toThrow(LidarrValidationError);
  });

  it.each(["line\nbreak", "\ttabbed", "escape\u001b", "c1\u0085", "bidi\u202e"])(
    "rejects C0, C1, and bidi controls: %j",
    (term) => {
      expect(() => normalizeLidarrSearchTerm(term)).toThrow("control characters");
    },
  );

  it("accepts exactly 256 Unicode code points, including a 1,024-byte term", () => {
    const term = "😀".repeat(256);

    expect(normalizeLidarrSearchTerm(term)).toBe(term);
  });

  it("rejects 257 Unicode code points", () => {
    expect(() => normalizeLidarrSearchTerm("😀".repeat(257))).toThrow("1-256");
  });
});

describe("createLidarrSearchDiscriminator", () => {
  it("is deterministic across canonically equivalent normalized terms", () => {
    expect(createLidarrSearchDiscriminator("search", " Café ")).toBe(
      createLidarrSearchDiscriminator("search", "Cafe\u0301"),
    );
  });

  it("contains the version and mode but excludes cleartext terms", () => {
    const term = "private listening history";
    const discriminator = createLidarrSearchDiscriminator("artist", term);

    expect(discriminator).toMatch(/^v1:artist:[0-9a-f]{64}$/u);
    expect(discriminator).not.toContain(term);
  });

  it("isolates modes and normalized terms", () => {
    const search = createLidarrSearchDiscriminator("search", "Björk");

    expect(createLidarrSearchDiscriminator("artist", "Björk")).not.toBe(search);
    expect(createLidarrSearchDiscriminator("search", "björk")).not.toBe(search);
  });

  it("hashes the canonical exact identifier", () => {
    expect(createLidarrSearchDiscriminator("album", `MBID:${ALBUM_ID.toUpperCase()}`)).toBe(
      createLidarrSearchDiscriminator("album", `lidarr:${ALBUM_ID}`),
    );
  });
});

describe("rankLidarrSearchCandidates", () => {
  it("keeps the first identity, preserves order, and assigns contiguous one-based ranks", () => {
    const firstArtist = artist(ARTIST_ID, "First name", { lidarrId: 7 });
    const candidates = [
      firstArtist,
      album(ARTIST_ID, "Same foreign id, different kind"),
      artist(ARTIST_ID, "Duplicate name"),
      album(ALBUM_ID, "Second album"),
    ];

    const ranked = rankLidarrSearchCandidates(candidates);

    expect(ranked).toEqual([
      { ...firstArtist, rank: 1 },
      { kind: "album", foreignId: ARTIST_ID, name: "Same foreign id, different kind", rank: 2 },
      { kind: "album", foreignId: ALBUM_ID, name: "Second album", rank: 3 },
    ]);
    expect(candidates).toHaveLength(4);
  });

  it("returns fresh immutable candidates and an immutable array", () => {
    const source = artist(ARTIST_ID, "Artist");
    const ranked = rankLidarrSearchCandidates([source]);

    expect(ranked[0]).not.toBe(source);
    expect(Object.isFrozen(ranked)).toBe(true);
    expect(Object.isFrozen(ranked[0])).toBe(true);
  });

  it("accepts 1,000 candidates and rejects 1,001 before shaping", () => {
    const candidates = Array.from({ length: 1_001 }, (_, index) =>
      artist(`id-${index}`, `Artist ${index}`),
    );

    expect(rankLidarrSearchCandidates(candidates.slice(0, 1_000))).toHaveLength(1_000);
    expect(() => rankLidarrSearchCandidates(candidates)).toThrow("at most 1000");
  });
});

describe("pageLidarrSearchCandidates", () => {
  const ranked = rankLidarrSearchCandidates([
    artist(ARTIST_ID, "Artist"),
    album(ALBUM_ID, "Album"),
    artist(ALBUM_ID, "Other artist"),
  ]);

  it("uses default paging metadata", () => {
    expect(pageLidarrSearchCandidates(ranked)).toMatchObject({
      total: 3,
      limit: LIDARR_SEARCH_DEFAULT_LIMIT,
      offset: 0,
      returned: 3,
      hasMore: false,
    });
  });

  it("exposes immutable page validation for callers to run before I/O", () => {
    const options = resolveLidarrSearchPageOptions();

    expect(options).toEqual({ limit: LIDARR_SEARCH_DEFAULT_LIMIT, offset: 0 });
    expect(Object.isFrozen(options)).toBe(true);
  });

  it("preserves pre-slice ranks and reports another page", () => {
    const page = pageLidarrSearchCandidates(ranked, { offset: 1, limit: 1 });

    expect(page.results).toEqual([{ ...ranked[1], rank: 2 }]);
    expect(page).toMatchObject({
      total: 3,
      limit: 1,
      offset: 1,
      returned: 1,
      hasMore: true,
    });
  });

  it("treats empty and offset-past-total pages as successful immutable results", () => {
    const empty = pageLidarrSearchCandidates([], { offset: Number.MAX_SAFE_INTEGER });
    const pastEnd = pageLidarrSearchCandidates(ranked, { offset: Number.MAX_SAFE_INTEGER });

    expect(empty).toMatchObject({ results: [], total: 0, returned: 0, hasMore: false });
    expect(pastEnd).toMatchObject({ results: [], total: 3, returned: 0, hasMore: false });
    expect(Object.isFrozen(pastEnd)).toBe(true);
    expect(Object.isFrozen(pastEnd.results)).toBe(true);
  });

  it.each([
    [{ limit: 0 }, "limit"],
    [{ limit: 201 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ limit: Number.MAX_SAFE_INTEGER + 1 }, "limit"],
    [{ offset: -1 }, "offset"],
    [{ offset: 1.5 }, "offset"],
    [{ offset: Number.MAX_SAFE_INTEGER + 1 }, "offset"],
  ] as const)("rejects unsafe page option %j", (options, expected) => {
    expect(() => pageLidarrSearchCandidates(ranked, options)).toThrow(expected);
  });

  it("returns fresh frozen page candidates", () => {
    const page = pageLidarrSearchCandidates(ranked, { limit: 1 });

    expect(page.results[0]).not.toBe(ranked[0]);
    expect(Object.isFrozen(page.results[0])).toBe(true);
  });
});

describe("shapeLidarrSearchCandidates", () => {
  it("deduplicates and ranks before slicing", () => {
    const page = shapeLidarrSearchCandidates(
      [artist(ARTIST_ID, "Artist"), artist(ARTIST_ID, "Duplicate"), album(ALBUM_ID, "Album")],
      { offset: 1, limit: 1 },
    );

    expect(page).toEqual({
      results: [{ kind: "album", foreignId: ALBUM_ID, name: "Album", rank: 2 }],
      total: 2,
      limit: 1,
      offset: 1,
      returned: 1,
      hasMore: false,
    });
  });
});
