import { describe, expect, it } from "vitest";
import type {
  MediaFilter,
  MediaFilterGroup,
  MediaFilterNode,
  MediaFilterRule,
} from "../types/media-filters.js";
import { isMediaFilterGroup } from "../types/media-filters.js";
import type { MediaAlbum, MediaArtist, MediaItem, MediaTrack } from "../types/media-server.js";
import {
  evaluateMediaFilter,
  evaluateMediaFilterGroup,
  evaluateMediaFilterNode,
  evaluateMediaFilterRule,
  evaluateMediaFilterWithAppliedRules,
  getMediaFieldValue,
  planMediaFilterQueries,
} from "./media-filter-evaluator.js";

function rule(
  field: MediaFilterRule["field"],
  operator: MediaFilterRule["operator"],
  value: string | number,
): MediaFilterRule {
  return { type: "rule", field, operator, value };
}

function group(match: MediaFilterGroup["match"], rules: MediaFilterNode[]): MediaFilterGroup {
  return { type: "group", match, rules };
}

function filter(match: MediaFilter["match"], rules: MediaFilterNode[]): MediaFilter {
  return { match, rules };
}

function track(overrides: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id: "track-1",
    kind: "track",
    title: "Come Together",
    rating: 0.8,
    year: 1969,
    genres: ["Rock", "Pop Rock"],
    moods: ["Energetic"],
    artist: "The Beatles",
    album: "Abbey Road",
    playCount: 10,
    durationMs: 259_000,
    filePath: "/music/Beatles/Abbey Road/01.flac",
    ...overrides,
  };
}

function album(overrides: Partial<MediaAlbum> = {}): MediaAlbum {
  return {
    id: "album-1",
    kind: "album",
    title: "Abbey Road",
    rating: 0.6,
    year: 1969,
    genres: ["Rock"],
    styles: ["Pop Rock", "British Psychedelia"],
    moods: ["Warm"],
    artist: "The Beatles",
    trackCount: 17,
    ...overrides,
  };
}

function artist(overrides: Partial<MediaArtist> = {}): MediaArtist {
  return {
    id: "artist-1",
    kind: "artist",
    title: "The Beatles",
    rating: 1,
    genres: ["Rock"],
    styles: ["British Invasion"],
    moods: ["Energetic"],
    albumCount: 13,
    ...overrides,
  };
}

describe("getMediaFieldValue", () => {
  it("reads the complete supported field projection", () => {
    const cases = [
      ["track artist", track(), "artist", "The Beatles"],
      ["album artist", album(), "artist", "The Beatles"],
      ["artist title", artist(), "artist", "The Beatles"],
      ["track album", track(), "album", "Abbey Road"],
      ["album title", album(), "album", "Abbey Road"],
      ["title", track(), "title", "Come Together"],
      ["year", album(), "year", 1969],
      ["minimum year", track(), "minYear", 1969],
      ["maximum year", track(), "maxYear", 1969],
      ["play count", track(), "minPlays", 10],
      ["genres", track(), "genre", "Rock, Pop Rock"],
      ["styles", album(), "style", "Pop Rock, British Psychedelia"],
      ["moods", artist(), "mood", "Energetic"],
    ] as const;

    for (const [description, item, field, expected] of cases) {
      expect(getMediaFieldValue(item, field), description).toBe(expected);
    }
  });

  it("returns undefined for every unsupported or absent field projection", () => {
    const cases = [
      [album(), "minPlays"],
      [artist(), "year"],
      [track(), "style"],
      [artist(), "album"],
      [track({ genres: [] }), "genre"],
      [track({ rating: null }), "trackRating"],
    ] as const;

    for (const [item, field] of cases) {
      expect(getMediaFieldValue(item, field), `${item.kind}.${field}`).toBeUndefined();
    }
  });

  it("uses one normalized rating projection for every entity rating field", () => {
    for (const field of ["artistRating", "albumRating", "trackRating"] as const) {
      expect(getMediaFieldValue(track({ rating: 0.5 }), field), field).toBe(0.5);
    }
  });
});

describe("evaluateMediaFilterRule", () => {
  it("implements the complete normalized-rating comparison contract", () => {
    const cases = [
      [0.2, ">=", 1, true],
      [0.2, "<=", 1, true],
      [0.5, "==", 2.5, true],
      [1, "==", 5, true],
      [0, "!=", 1, true],
      [0.79, ">=", 4, false],
    ] as const;

    for (const [rating, operator, value, expected] of cases) {
      expect(
        evaluateMediaFilterRule(rule("trackRating", operator, value), track({ rating })),
        `${rating} ${operator} ${value}`,
      ).toBe(expected);
    }
  });

  it("implements text operators and rejects incompatible field/operator pairs", () => {
    const cases: ReadonlyArray<readonly [MediaFilterRule, boolean]> = [
      [rule("artist", "contains", "beatles"), true],
      [rule("artist", "==", "THE BEATLES"), true],
      [rule("artist", "!=", "Rolling Stones"), true],
      [rule("artist", "not_contains", "stones"), true],
      [rule("artist", "contains", "stones"), false],
      [rule("artist", ">=", "Beatles"), false],
      [rule("year", "contains", 1969), false],
    ];

    for (const [candidate, expected] of cases) {
      expect(evaluateMediaFilterRule(candidate, track()), JSON.stringify(candidate)).toBe(expected);
    }
  });

  it("implements numeric operators", () => {
    const cases: ReadonlyArray<readonly [MediaFilterRule, boolean]> = [
      [rule("year", ">=", 1960), true],
      [rule("maxYear", "<=", 1970), true],
      [rule("minPlays", "==", 10), true],
      [rule("minPlays", "!=", 10), false],
    ];

    for (const [candidate, expected] of cases) {
      expect(evaluateMediaFilterRule(candidate, track()), JSON.stringify(candidate)).toBe(expected);
    }
  });

  it("uses established missing-field semantics", () => {
    const item = artist();

    expect(evaluateMediaFilterRule(rule("year", ">=", 2000), item)).toBe(false);
    expect(evaluateMediaFilterRule(rule("year", "!=", 2000), item)).toBe(true);
    expect(evaluateMediaFilterRule(rule("album", "contains", "Road"), item)).toBe(false);
    expect(evaluateMediaFilterRule(rule("album", "not_contains", "Road"), item)).toBe(true);
  });

  it("rejects every invalid star-rating boundary class", () => {
    for (const value of [0, 5.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateMediaFilterRule(rule("trackRating", ">=", value), track())).toThrow(
        /1 and 5/,
      );
    }
  });

  it("rejects every invalid normalized-rating boundary class", () => {
    for (const rating of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        evaluateMediaFilterRule(rule("trackRating", ">=", 1), track({ rating })),
      ).toThrow(/0 and 1/);
    }
  });
});

describe("recursive evaluation", () => {
  it("evaluates mixed nested all/any groups", () => {
    const candidate = filter("all", [
      rule("trackRating", ">=", 4),
      group("any", [
        rule("artist", "contains", "Stones"),
        group("all", [rule("year", ">=", 1960), rule("album", "contains", "Abbey")]),
      ]),
    ]);

    expect(evaluateMediaFilter(candidate, track())).toBe(true);
  });

  it("preserves empty-group boolean identities", () => {
    expect(evaluateMediaFilterGroup(group("all", []), track())).toBe(true);
    expect(evaluateMediaFilterGroup(group("any", []), track())).toBe(false);
  });

  it("dispatches leaf and group nodes", () => {
    expect(evaluateMediaFilterNode(rule("title", "contains", "Together"), track())).toBe(true);
    expect(
      evaluateMediaFilterNode(group("any", [rule("title", "contains", "Together")]), track()),
    ).toBe(true);
  });

  it("short-circuits all and any groups", () => {
    const itemWithExplodingTitle: MediaTrack = {
      ...track({ rating: 0.2 }),
      get title(): string {
        throw new Error("title should not be read");
      },
    };

    expect(
      evaluateMediaFilterGroup(
        group("all", [rule("trackRating", ">=", 5), rule("title", "contains", "x")]),
        itemWithExplodingTitle,
      ),
    ).toBe(false);
    expect(
      evaluateMediaFilterGroup(
        group("any", [rule("trackRating", ">=", 1), rule("title", "contains", "x")]),
        itemWithExplodingTitle,
      ),
    ).toBe(true);
  });

  it("accepts the maximum group depth and rejects deeper filters", () => {
    let accepted: MediaFilterNode = rule("trackRating", ">=", 1);
    for (let depth = 0; depth < 20; depth += 1) {
      accepted = group("all", [accepted]);
    }

    if (!isMediaFilterGroup(accepted)) {
      throw new Error("Expected nested filter fixture to be a group");
    }
    expect(evaluateMediaFilterGroup(accepted, track())).toBe(true);
    expect(() => evaluateMediaFilterGroup(group("all", [accepted]), track())).toThrow(/depth/i);
  });
});

describe("evaluateMediaFilterWithAppliedRules", () => {
  it("skips matching top-level rules already enforced by the provider", () => {
    const applied = rule("genre", "contains", "Rock");
    const candidate = filter("all", [applied, rule("trackRating", ">=", 4)]);
    const item = track({ genres: undefined, rating: 0.8 });

    expect(evaluateMediaFilter(candidate, item)).toBe(false);
    expect(evaluateMediaFilterWithAppliedRules(candidate, item, [applied])).toBe(true);
  });

  it("only skips an exact field/operator/value match", () => {
    const candidate = filter("all", [rule("trackRating", ">=", 4)]);

    expect(
      evaluateMediaFilterWithAppliedRules(candidate, track({ rating: 0.6 }), [
        rule("trackRating", ">=", 3),
      ]),
    ).toBe(false);
  });

  it("skips an applied rule wrapped in singleton groups", () => {
    const applied = rule("genre", "contains", "Rock");
    const candidate = filter("all", [group("all", [group("any", [applied])])]);

    expect(
      evaluateMediaFilterWithAppliedRules(candidate, track({ genres: undefined }), [applied]),
    ).toBe(true);
  });

  it("evaluates top-level any filters without unsafe global skipping", () => {
    const applied = rule("genre", "contains", "Rock");
    const candidate = filter("any", [applied, rule("trackRating", ">=", 5)]);

    expect(
      evaluateMediaFilterWithAppliedRules(candidate, track({ genres: undefined, rating: 0.2 }), [
        applied,
      ]),
    ).toBe(false);
  });
});

describe("planMediaFilterQueries", () => {
  const supportsTextEquality = (candidate: MediaFilterRule): boolean =>
    ["artist", "album", "title", "style", "mood"].includes(candidate.field) &&
    (candidate.operator === "==" || candidate.operator === "contains");

  it("returns provider-neutral base rules and one empty variant for flat filters", () => {
    const artistRule = rule("artist", "contains", "Beatles");
    const ratingRule = rule("trackRating", ">=", 4);
    const plan = planMediaFilterQueries(
      filter("all", [artistRule, ratingRule]),
      supportsTextEquality,
    );

    expect(plan.baseRules).toEqual([artistRule]);
    expect(plan.queryVariants).toEqual([[]]);
    expect(plan.requiresResidualEvaluation).toBe(true);
  });

  it("unwraps supported singleton groups into base rules", () => {
    const titleRule = rule("title", "==", "Come Together");
    const plan = planMediaFilterQueries(
      filter("all", [group("all", [group("any", [titleRule])])]),
      supportsTextEquality,
    );

    expect(plan.baseRules).toEqual([titleRule]);
    expect(plan.requiresResidualEvaluation).toBe(false);
  });

  it("represents one supported OR group as query variants without protocol encoding", () => {
    const artistA = rule("artist", "contains", "Beatles");
    const artistB = rule("artist", "contains", "Stones");
    const base = rule("title", "not_contains", "Demo");
    const plan = planMediaFilterQueries(
      filter("all", [base, group("any", [artistA, artistB])]),
      supportsTextEquality,
    );

    expect(plan.baseRules).toEqual([]);
    expect(plan.queryVariants).toEqual([[artistA], [artistB]]);
    expect(plan.requiresResidualEvaluation).toBe(true);
  });

  it("keeps supported base conjuncts separate from variant branches", () => {
    const base = rule("title", "==", "Come Together");
    const artistA = rule("artist", "contains", "Beatles");
    const artistB = rule("artist", "contains", "Stones");
    const plan = planMediaFilterQueries(
      filter("all", [base, group("any", [artistA, artistB])]),
      supportsTextEquality,
    );

    expect(plan.baseRules).toEqual([base]);
    expect(plan.queryVariants).toEqual([[artistA], [artistB]]);
  });

  it("does not expand unsupported, nested, multiple, or top-level OR groups", () => {
    const supported = rule("artist", "contains", "Beatles");
    const unsupported = rule("trackRating", ">=", 4);
    const cases: MediaFilter[] = [
      filter("all", [group("any", [supported, unsupported])]),
      filter("all", [group("any", [supported, group("all", [supported])])]),
      filter("all", [group("any", [supported, supported]), group("any", [supported, supported])]),
      filter("any", [supported, supported]),
    ];

    for (const candidate of cases) {
      const plan = planMediaFilterQueries(candidate, supportsTextEquality);
      expect(plan.queryVariants).toEqual([[]]);
      expect(plan.requiresResidualEvaluation).toBe(true);
    }
  });

  it("marks a fully applied flat filter as not requiring residual evaluation", () => {
    const candidate = filter("all", [
      rule("artist", "contains", "Beatles"),
      rule("title", "==", "Come Together"),
    ]);
    const plan = planMediaFilterQueries(candidate, supportsTextEquality);

    expect(plan.baseRules).toHaveLength(2);
    expect(plan.requiresResidualEvaluation).toBe(false);
  });

  it("accepts the entity union without provider-specific types", () => {
    const items: readonly MediaItem[] = [track(), album(), artist()];
    const candidate = filter("any", [rule("title", "contains", "Beatles")]);

    expect(items.filter((item) => evaluateMediaFilter(candidate, item))).toHaveLength(1);
  });
});
