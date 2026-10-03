import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FilterGroup, FilterRule, SmartFilter, SmartFilterRule } from "../types/filters.js";
import type { NormalizedRating, RatingSource } from "../types/index.js";
import type { ExtendedMetadata } from "./metadata.js";
import {
  countSmartFilterRules,
  evaluateSmartFilter,
  evaluateSmartFilterRule,
  evaluateSmartFilterVerbose,
  extractNormalizedRating,
  formatFilterRule,
  normalizedToPlex,
  plexToNormalized,
  readRating,
  readRatingAndFormat,
} from "./ratings.js";

vi.mock("music-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  return {
    ...actual,
    parseFile: vi.fn(),
  };
});

const mockedParseFile = vi.mocked(parseFile);

function ratingMetadata(
  commonRating: IAudioMetadata["common"]["rating"] = undefined,
  native: IAudioMetadata["native"] = {},
): Pick<IAudioMetadata, "common" | "native"> {
  return {
    common: { rating: commonRating } as IAudioMetadata["common"],
    native,
  };
}

function metadata(
  overrides: Partial<{
    rating: number | null;
    genre: string[];
    artist: string;
    artists: string[];
    year: number;
    bpm: number;
    album: string;
  }> = {},
): ExtendedMetadata {
  return {
    rating:
      overrides.rating !== undefined && overrides.rating !== null
        ? { value: overrides.rating, source: "Vorbis" }
        : null,
    format: {
      duration: 180,
      bitrate: 320_000,
      codec: "FLAC",
      trackInfo: [],
      tagTypes: ["vorbis"],
    },
    common: {
      genre: overrides.genre,
      year: overrides.year,
      bpm: overrides.bpm,
      artist: overrides.artist,
      artists: overrides.artists,
      album: overrides.album,
    },
  };
}

function rule(
  field: FilterRule["field"],
  operator: FilterRule["operator"],
  value: string | number,
): FilterRule {
  return { type: "rule", field, operator, value };
}

function group(match: "all" | "any", rules: SmartFilterRule[]): FilterGroup {
  return { type: "group", match, rules };
}

function filter(match: "all" | "any", rules: SmartFilterRule[]): SmartFilter {
  return { match, rules };
}

describe("native-first rating extraction", () => {
  beforeEach(() => {
    mockedParseFile.mockReset();
  });

  it("prefers the native Vorbis value over a mis-scaled common projection", () => {
    const result = extractNormalizedRating(
      ratingMetadata([{ rating: 0.008 }], {
        vorbis: [{ id: "rating", value: "0.80" }],
      }),
      "/music/song.flac",
    );

    expect(result).toEqual({ value: 0.8, source: "Vorbis" });
  });

  it("normalizes native Vorbis normalized, star, and percentage scale boundaries", () => {
    const cases = [
      ["0.80", 0.8],
      ["1", 1],
      ["2.5", 0.5],
      ["5", 1],
      ["80", 0.8],
      ["100", 1],
    ] as const;

    for (const [value, expected] of cases) {
      expect(
        extractNormalizedRating(
          ratingMetadata(undefined, {
            vorbis: [{ id: "RATING", value }],
          }),
          "/music/song.opus",
        ),
        value,
      ).toEqual({ value: expected, source: "Vorbis" });
    }
  });

  it("keeps invalid, zero, and absent native Vorbis ratings unrated", () => {
    const cases = [
      ["negative", [{ id: "RATING", value: "-0.1" }]],
      ["above percentage scale", [{ id: "RATING", value: "101" }]],
      ["not numeric", [{ id: "RATING", value: "not-a-rating" }]],
      ["zero", [{ id: "RATING", value: "0" }]],
      ["absent", [{ id: "TITLE", value: "Song" }]],
    ] as const;

    for (const [name, vorbis] of cases) {
      expect(
        extractNormalizedRating(ratingMetadata(undefined, { vorbis: [...vorbis] }), "song.ogg"),
        name,
      ).toBeNull();
    }
  });

  it("selects preferred POPM identities across both ID3 families and retains provenance", () => {
    const cases: ReadonlyArray<readonly [string, IAudioMetadata["native"], NormalizedRating]> = [
      [
        "preferred ID3v2.4 identity",
        {
          "ID3v2.3": [
            {
              id: "POPM",
              value: { email: "other@example.com", rating: 255, counter: 1 },
            },
          ],
          "ID3v2.4": [{ id: "POPM", value: { email: "MusicBee", rating: 128, counter: 42 } }],
        },
        { value: 128 / 255, source: "POPM", email: "MusicBee", counter: 42 },
      ],
      [
        "preferred email ordering across families",
        {
          "ID3v2.3": [
            {
              id: "POPM",
              value: {
                email: "Windows Media Player 9 Series",
                rating: 196,
                counter: 7,
              },
            },
          ],
          "ID3v2.4": [{ id: "POPM", value: { email: "MediaMonkey", rating: 255, counter: 99 } }],
        },
        {
          value: 196 / 255,
          source: "POPM",
          email: "Windows Media Player 9 Series",
          counter: 7,
        },
      ],
    ];

    for (const [name, native, expected] of cases) {
      expect(extractNormalizedRating(ratingMetadata(undefined, native), "song.mp3"), name).toEqual(
        expected,
      );
    }
  });

  it("uses the compatible common projection only when no usable native rating exists", () => {
    const cases: ReadonlyArray<readonly [string, string, IAudioMetadata["native"], RatingSource]> =
      [
        ["MP3 without POPM", "song.mp3", {}, "POPM"],
        [
          "FLAC without RATING",
          "song.flac",
          { vorbis: [{ id: "TITLE", value: "Song" }] },
          "Vorbis",
        ],
        [
          "Ogg with invalid RATING",
          "song.ogg",
          { vorbis: [{ id: "RATING", value: "invalid" }] },
          "Vorbis",
        ],
        ["other readable format", "song.wav", {}, "unknown"],
      ];

    for (const [name, filePath, native, source] of cases) {
      expect(
        extractNormalizedRating(
          ratingMetadata([{ source: "player", rating: 0.6 }], native),
          filePath,
        ),
        name,
      ).toEqual({ value: 0.6, source, email: "player" });
    }

    expect(extractNormalizedRating(ratingMetadata([{ rating: 0.6 }]), "song.m4a")).toBeNull();
  });

  it("routes both file readers through the same extractor without loading covers", async () => {
    const parsed: IAudioMetadata = {
      ...ratingMetadata([{ rating: 0.008 }], {
        vorbis: [{ id: "RATING", value: "0.80" }],
      }),
      format: { container: "FLAC", trackInfo: [], tagTypes: ["vorbis"] },
      quality: { warnings: [] },
    };
    mockedParseFile.mockResolvedValue(parsed);

    await expect(readRating("/music/song.flac")).resolves.toEqual({
      value: 0.8,
      source: "Vorbis",
    });
    await expect(readRatingAndFormat("/music/song.flac")).resolves.toEqual({
      rating: { value: 0.8, source: "Vorbis" },
      format: parsed.format,
    });
    expect(mockedParseFile).toHaveBeenNthCalledWith(1, "/music/song.flac", {
      skipCovers: true,
    });
    expect(mockedParseFile).toHaveBeenNthCalledWith(2, "/music/song.flac", {
      skipCovers: true,
    });
  });
});

describe("smart filter evaluation", () => {
  it("implements the complete supported leaf-field and operator matrix", () => {
    const cases: ReadonlyArray<readonly [string, ExtendedMetadata, FilterRule, boolean]> = [
      ["rating star threshold passes", metadata({ rating: 0.8 }), rule("rating", ">=", 4), true],
      ["rating star threshold fails", metadata({ rating: 0.6 }), rule("rating", ">=", 4), false],
      ["normalized rating", metadata({ rating: 0.8 }), rule("rating", ">=", 0.8), true],
      ["rating less-than", metadata({ rating: 0.6 }), rule("rating", "<=", 4), true],
      ["rating equality", metadata({ rating: 0.8 }), rule("rating", "==", 4), true],
      ["missing rating", metadata(), rule("rating", ">=", 3), false],
      [
        "genre case-insensitive contains",
        metadata({ genre: ["Rock", "Alternative"] }),
        rule("genre", "contains", "rock"),
        true,
      ],
      [
        "genre partial contains",
        metadata({ genre: ["Alternative Rock", "Indie"] }),
        rule("genre", "contains", "Rock"),
        true,
      ],
      ["genre mismatch", metadata({ genre: ["Pop"] }), rule("genre", "contains", "Rock"), false],
      [
        "genre equality",
        metadata({ genre: ["Rock", "Alternative"] }),
        rule("genre", "==", "rock"),
        true,
      ],
      ["empty genre", metadata({ genre: [] }), rule("genre", "contains", "Rock"), false],
      [
        "single artist",
        metadata({ artist: "The Beatles" }),
        rule("artist", "contains", "Beatles"),
        true,
      ],
      [
        "artist array",
        metadata({ artists: ["John Lennon", "Paul McCartney"] }),
        rule("artist", "contains", "Lennon"),
        true,
      ],
      [
        "artist mismatch",
        metadata({ artist: "The Rolling Stones" }),
        rule("artist", "contains", "Beatles"),
        false,
      ],
      ["year greater-than", metadata({ year: 2020 }), rule("year", ">=", 2015), true],
      ["year less-than", metadata({ year: 1990 }), rule("year", "<=", 2000), true],
      ["year equality", metadata({ year: 2020 }), rule("year", "==", 2020), true],
      ["bpm greater-than", metadata({ bpm: 140 }), rule("bpm", ">=", 120), true],
      ["bpm less-than", metadata({ bpm: 100 }), rule("bpm", "<=", 120), true],
      ["missing date", metadata(), rule("date_added", "within", "30d"), false],
    ];

    for (const [name, candidate, candidateRule, expected] of cases) {
      expect(evaluateSmartFilterRule(candidate, candidateRule), name).toBe(expected);
    }
  });

  it("returns false for every absent metadata field", () => {
    for (const candidateRule of [
      rule("rating", ">=", 3),
      rule("genre", "contains", "Rock"),
      rule("artist", "contains", "Beatles"),
      rule("year", ">=", 2000),
      rule("bpm", ">=", 120),
    ]) {
      expect(evaluateSmartFilterRule(metadata(), candidateRule), candidateRule.field).toBe(false);
    }
  });

  it("rejects incompatible field/operator pairs and invalid numeric values", () => {
    const cases = [
      [metadata({ year: 2020 }), rule("year", "contains", "20")],
      [metadata({ genre: ["Rock"] }), rule("genre", ">=", 1)],
      [metadata({ bpm: 120 }), rule("bpm", "within", "30d")],
      [metadata({ year: 2020 }), rule("year", ">=", "not-a-number")],
    ] as const;

    for (const [candidate, candidateRule] of cases) {
      expect(evaluateSmartFilterRule(candidate, candidateRule), JSON.stringify(candidateRule)).toBe(
        false,
      );
    }
  });

  it("combines all/any groups and nested boolean logic", () => {
    const candidate = metadata({ rating: 0.6, genre: ["Jazz"], year: 1960 });

    expect(
      evaluateSmartFilterRule(
        candidate,
        group("all", [rule("genre", "contains", "Jazz"), rule("year", "<=", 1970)]),
      ),
    ).toBe(true);
    expect(
      evaluateSmartFilterRule(
        candidate,
        group("any", [rule("rating", ">=", 4), rule("genre", "contains", "Jazz")]),
      ),
    ).toBe(true);
    expect(
      evaluateSmartFilter(
        candidate,
        filter("all", [
          rule("year", ">=", 1900),
          group("any", [
            rule("rating", ">=", 4),
            group("all", [rule("genre", "contains", "Jazz"), rule("year", "<=", 1970)]),
          ]),
        ]),
      ),
    ).toBe(true);
  });

  it("short-circuits both all and any groups", () => {
    const candidate = metadata({ rating: 0.2 });
    Object.defineProperty(candidate.common, "genre", {
      get: () => {
        throw new Error("genre must not be read");
      },
    });

    expect(
      evaluateSmartFilterRule(
        candidate,
        group("all", [rule("rating", ">=", 4), rule("genre", "contains", "Rock")]),
      ),
    ).toBe(false);
    expect(
      evaluateSmartFilterRule(
        candidate,
        group("any", [rule("rating", ">=", 0.2), rule("genre", "contains", "Rock")]),
      ),
    ).toBe(true);
  });

  it("accepts the supported nesting boundary and rejects excessive depth", () => {
    let accepted: SmartFilterRule = rule("rating", ">=", 0.5);
    for (let depth = 0; depth < 18; depth += 1) {
      accepted = group("all", [accepted]);
    }

    let rejected: SmartFilterRule = rule("rating", ">=", 0.5);
    for (let depth = 0; depth < 25; depth += 1) {
      rejected = group("all", [rejected]);
    }

    const candidate = metadata({ rating: 0.8 });
    expect(evaluateSmartFilter(candidate, filter("all", [accepted]))).toBe(true);
    expect(() => evaluateSmartFilter(candidate, filter("all", [rejected]))).toThrow(/depth/i);
  });

  it("supports numeric string coercion and same-field range filters", () => {
    expect(
      evaluateSmartFilter(
        metadata({ year: 2010, rating: 0.8 }),
        filter("all", [
          rule("year", ">=", "2000" as unknown as number),
          rule("year", "<=", 2020),
          rule("rating", ">=", 4),
        ]),
      ),
    ).toBe(true);
    expect(
      evaluateSmartFilter(
        metadata({ year: 2025 }),
        filter("all", [rule("year", ">=", 2000), rule("year", "<=", 2020)]),
      ),
    ).toBe(false);
  });
});

describe("smart filter diagnostics", () => {
  it("returns pass/fail, per-rule values, and the first failing rule", () => {
    const result = evaluateSmartFilterVerbose(
      metadata({ rating: 0.6, genre: ["Rock"] }),
      filter("all", [rule("rating", ">=", 4), rule("genre", "contains", "Rock")]),
    );

    expect(result).toMatchObject({
      passed: false,
      failingRule: { field: "rating" },
      ruleResults: [
        { passed: false, actualValue: 0.6 },
        { passed: true, actualValue: ["Rock"] },
      ],
    });
  });

  it("counts leaf rules across arbitrary nesting", () => {
    const cases: ReadonlyArray<readonly [SmartFilter, number]> = [
      [filter("all", [rule("rating", ">=", 4), rule("genre", "contains", "Rock")]), 2],
      [
        filter("all", [
          rule("rating", ">=", 4),
          group("any", [
            rule("genre", "contains", "Rock"),
            group("all", [rule("year", ">=", 2000), rule("year", "<=", 2020)]),
          ]),
        ]),
        4,
      ],
    ];

    for (const [candidate, expected] of cases) {
      expect(countSmartFilterRules(candidate)).toBe(expected);
    }
  });

  it("formats every rule value type consistently", () => {
    expect(
      [
        rule("rating", ">=", 4),
        rule("genre", "contains", "Rock"),
        rule("date_added", "within", "30d"),
      ].map(formatFilterRule),
    ).toEqual(["rating >= 4", "genre contains Rock", "date_added within 30d"]);
  });
});

describe("Plex rating conversion", () => {
  it("converts normalized ratings using the complete boundary and rounding matrix", () => {
    const cases = [
      [0, 0],
      [-0.1, 0],
      [0.1, 1],
      [0.2, 2],
      [0.5, 5],
      [0.74, 7],
      [0.75, 8],
      [0.8, 8],
      [1, 10],
    ] as const;

    for (const [normalized, plex] of cases) {
      expect(normalizedToPlex(normalized), String(normalized)).toBe(plex);
    }
  });

  it("converts Plex ratings using the complete boundary and passthrough matrix", () => {
    const cases = [
      [0, 0],
      [-1, 0],
      [1, 0.1],
      [2, 0.2],
      [5, 0.5],
      [8, 0.8],
      [10, 1],
      [12, 1.2],
    ] as const;

    for (const [plex, normalized] of cases) {
      expect(plexToNormalized(plex), String(plex)).toBe(normalized);
    }
  });

  it("round-trips every exact Plex-scale normalized rating", () => {
    for (const normalized of [0, 0.1, 0.5, 1]) {
      expect(plexToNormalized(normalizedToPlex(normalized)), String(normalized)).toBe(normalized);
    }
  });
});
