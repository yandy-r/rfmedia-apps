/**
 * Unit tests for metadata filter routing helpers.
 */

import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasExtendedFilters, readReconciliationMetadata } from "./metadata.js";
import type { RatingFilter } from "../types/options.js";
import type { SmartFilter } from "../types/filters.js";

vi.mock("music-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  return {
    ...actual,
    parseFile: vi.fn(),
  };
});

const mockedParseFile = vi.mocked(parseFile);

function createSmartFilter(match: "all" | "any", rules: SmartFilter["rules"]): SmartFilter {
  return { match, rules };
}

function parsedMetadata(common: Partial<IAudioMetadata["common"]>): IAudioMetadata {
  return {
    common: common as IAudioMetadata["common"],
    format: { container: "FLAC", trackInfo: [], tagTypes: ["vorbis"] },
    native: {},
    quality: { warnings: [] },
  };
}

describe("readReconciliationMetadata", () => {
  beforeEach(() => {
    mockedParseFile.mockReset();
  });

  it("projects populated reconciliation fields", async () => {
    mockedParseFile.mockResolvedValue(
      parsedMetadata({
        rating: [{ rating: 0.8 }],
        artist: "Primary Artist",
        genre: ["Rock", "Alternative"],
        year: 1999,
        title: "Ignored Title",
        album: "Ignored Album",
        bpm: 120,
      }),
    );

    await expect(readReconciliationMetadata("/music/track.flac")).resolves.toEqual({
      ok: true,
      metadata: {
        rating: 0.8,
        artist: "Primary Artist",
        genre: "Rock",
        year: 1999,
      },
    });
  });

  it("preserves genuinely missing fields as successful null evidence", async () => {
    mockedParseFile.mockResolvedValue(parsedMetadata({ genre: [] }));

    await expect(readReconciliationMetadata("/music/track.flac")).resolves.toEqual({
      ok: true,
      metadata: {
        rating: null,
        artist: null,
        genre: null,
        year: null,
      },
    });
  });

  it("returns a typed failure when metadata cannot be read", async () => {
    mockedParseFile.mockRejectedValue(new Error("invalid metadata"));

    await expect(readReconciliationMetadata("/music/broken.flac")).resolves.toEqual({
      ok: false,
      error: { code: "read-failed" },
    });
  });
});

describe("hasExtendedFilters", () => {
  it("returns true when smartFilter is defined", () => {
    const filter: RatingFilter = {
      outputFolder: "liked-songs",
      preserveStructure: false,
      smartFilter: createSmartFilter("all", [
        { type: "rule", field: "rating", operator: ">=", value: 4.0 },
      ]),
    };

    expect(hasExtendedFilters(filter)).toBe(true);
  });

  it("returns false when smartFilter is absent", () => {
    const filter: RatingFilter = {
      outputFolder: "liked-songs",
      preserveStructure: false,
      minStars: 3.5,
    };

    expect(hasExtendedFilters(filter)).toBe(false);
  });

  it("returns false for legacy rating-only filters", () => {
    const filter: RatingFilter = {
      outputFolder: "liked-songs",
      preserveStructure: false,
      minRating: 80,
    };

    expect(hasExtendedFilters(filter)).toBe(false);
  });

  it("returns false when smartFilter key exists but is undefined", () => {
    const filter: RatingFilter = {
      outputFolder: "liked-songs",
      preserveStructure: false,
      smartFilter: undefined,
    };

    expect(hasExtendedFilters(filter)).toBe(false);
  });
});
