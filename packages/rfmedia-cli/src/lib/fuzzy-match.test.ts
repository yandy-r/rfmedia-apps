import { describe, expect, it } from "vitest";
import { findClosestMatch } from "./fuzzy-match.js";

describe("findClosestMatch", () => {
  it("returns undefined when candidate list is empty", () => {
    expect(findClosestMatch("plex", [])).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    const result = findClosestMatch("BRITNEY", ["Shakira", "britney spears", "Taylor Swift"]);
    expect(result).toBe("britney spears");
  });

  it("respects minimum score threshold", () => {
    const result = findClosestMatch("zzzzz", ["liked", "favorites"], 0.6);
    expect(result).toBeUndefined();
  });

  it("returns deterministic winner for equal scores by preserving first best candidate", () => {
    const result = findClosestMatch("abc", ["abd", "abf"], 0.1);
    expect(result).toBe("abd");
  });
});
