import { describe, expect, expectTypeOf, it } from "vitest";
import { MEDIA_FILTER_MAX_DEPTH, isMediaFilterGroup, isMediaFilterRule } from "./media-filters.js";
import type {
  MediaFilter,
  MediaFilterGroup,
  MediaFilterNode,
  MediaFilterRule,
  MediaFiltersConfigOptions,
} from "./media-filters.js";

function createRule(
  field: MediaFilterRule["field"],
  operator: MediaFilterRule["operator"],
  value: string | number,
): MediaFilterRule {
  return { type: "rule", field, operator, value };
}

function createGroup(match: MediaFilterGroup["match"], rules: MediaFilterNode[]): MediaFilterGroup {
  return { type: "group", match, rules };
}

describe("generic media filter contract", () => {
  it("keeps the established recursion-depth constraint", () => {
    expect(MEDIA_FILTER_MAX_DEPTH).toBe(20);
  });

  it("represents recursive groups and media query defaults", () => {
    const filter = {
      match: "all",
      library: "Music",
      type: "track",
      limit: 100,
      rules: [
        createRule("artistRating", ">=", 4),
        createGroup("any", [
          createRule("genre", "contains", "Rock"),
          createRule("mood", "not_contains", "Somber"),
        ]),
      ],
    } satisfies MediaFilter;
    const config = { favorites: filter } satisfies MediaFiltersConfigOptions;

    expect(config.favorites).toBe(filter);
    expectTypeOf(filter.type).toEqualTypeOf<"track">();
  });
});

describe("isMediaFilterRule", () => {
  it.each([
    ["rating", createRule("artistRating", ">=", 4)],
    ["genre", createRule("genre", "contains", "Rock")],
    ["year", createRule("year", "==", 2020)],
    ["text", createRule("artist", "contains", "Beatles")],
    ["play count", createRule("minPlays", ">=", 10)],
  ])("accepts a %s rule", (_description, rule) => {
    expect(isMediaFilterRule(rule)).toBe(true);
  });

  it("rejects empty, populated, and nested groups", () => {
    const inner = createGroup("any", [createRule("genre", "contains", "Rock")]);
    const groups = [
      createGroup("all", []),
      createGroup("all", [createRule("title", "==", "Song")]),
      createGroup("all", [inner]),
    ];

    expect(groups.every((group) => !isMediaFilterRule(group))).toBe(true);
  });
});

describe("isMediaFilterGroup", () => {
  it("accepts empty, populated, any-match, and nested groups", () => {
    const inner = createGroup("any", [createRule("genre", "contains", "Rock")]);
    const groups = [
      createGroup("all", []),
      createGroup("all", [createRule("title", "==", "Song")]),
      inner,
      createGroup("all", [inner]),
    ];

    expect(groups.every(isMediaFilterGroup)).toBe(true);
  });

  it.each([
    ["rating", createRule("artistRating", ">=", 4)],
    ["genre", createRule("genre", "contains", "Rock")],
    ["year", createRule("year", "==", 2020)],
    ["text", createRule("artist", "contains", "Beatles")],
    ["play count", createRule("minPlays", ">=", 10)],
  ])("rejects a %s rule", (_description, rule) => {
    expect(isMediaFilterGroup(rule)).toBe(false);
  });
});
