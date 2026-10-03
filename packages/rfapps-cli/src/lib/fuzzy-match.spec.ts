import { describe, it, expect } from "vitest";
import { computeSimilarity, findClosestMatch, findClosestMatches } from "./fuzzy-match.js";

describe("Fuzzy Match", () => {
  describe("computeSimilarity", () => {
    it("should return 1.0 for exact match", () => {
      expect(computeSimilarity("plex", "plex")).toBe(1.0);
    });

    it("should return 1.0 for case-insensitive exact match", () => {
      expect(computeSimilarity("Plex", "plex")).toBe(1.0);
      expect(computeSimilarity("PLEX", "plex")).toBe(1.0);
      expect(computeSimilarity("pLeX", "PlEx")).toBe(1.0);
    });

    it("should return approximately 0 for completely different strings", () => {
      const score = computeSimilarity("abc", "xyz");
      expect(score).toBeLessThan(0.2);
    });

    it("should return 1.0 for two empty strings", () => {
      expect(computeSimilarity("", "")).toBe(1.0);
    });

    it("should return 0 when one string is empty and the other is not", () => {
      expect(computeSimilarity("", "plex")).toBe(0);
      expect(computeSimilarity("plex", "")).toBe(0);
    });

    it("should return a high score for similar strings", () => {
      const score = computeSimilarity("plx", "plex");
      expect(score).toBeGreaterThan(0.5);
    });

    it("should return a low score for dissimilar strings", () => {
      const score = computeSimilarity("plex", "authentik");
      expect(score).toBeLessThan(0.3);
    });

    it("should produce a symmetric score", () => {
      const scoreAB = computeSimilarity("sonarr", "radarr");
      const scoreBA = computeSimilarity("radarr", "sonarr");
      expect(scoreAB).toBe(scoreBA);
    });

    it("should handle single character strings", () => {
      expect(computeSimilarity("a", "a")).toBe(1.0);
      expect(computeSimilarity("a", "b")).toBe(0);
    });

    it("should handle very long strings", () => {
      const longA = "a".repeat(100);
      const longB = "a".repeat(99) + "b";
      const score = computeSimilarity(longA, longB);
      expect(score).toBeGreaterThan(0.9);
    });
  });

  describe("findClosestMatch", () => {
    const candidates = ["plex", "traefik", "sonarr", "radarr", "prowlarr", "bazarr"];

    it("should return the best match above default threshold", () => {
      const result = findClosestMatch("plx", candidates);
      expect(result).toBe("plex");
    });

    it("should return exact match as first choice", () => {
      const result = findClosestMatch("plex", candidates);
      expect(result).toBe("plex");
    });

    it("should return undefined when no match is above threshold", () => {
      const result = findClosestMatch("zzzzz", candidates);
      expect(result).toBeUndefined();
    });

    it("should return undefined for empty candidates array", () => {
      const result = findClosestMatch("plex", []);
      expect(result).toBeUndefined();
    });

    it("should respect custom minScore", () => {
      // "plx" vs "plex" has a moderate score; a very high threshold should reject it
      const result = findClosestMatch("plx", candidates, 0.99);
      expect(result).toBeUndefined();
    });

    it("should find match with a lower custom minScore", () => {
      // With a very low threshold, even weak matches qualify
      const result = findClosestMatch("plx", candidates, 0.1);
      expect(result).toBe("plex");
    });

    it("should be case-insensitive", () => {
      const result = findClosestMatch("PLEX", candidates);
      expect(result).toBe("plex");
    });

    it("should handle single-char input", () => {
      const result = findClosestMatch("p", ["plex", "traefik"]);
      // Single character "p" vs "plex" (4 chars): distance 3, score = 1 - 3/4 = 0.25
      // Below default 0.4 threshold, so undefined
      expect(result).toBeUndefined();
    });

    it("should return a match for single-char input with low threshold", () => {
      const result = findClosestMatch("p", ["plex", "traefik"], 0.1);
      expect(result).toBe("plex");
    });

    it("should pick the highest-scoring candidate when multiple are similar", () => {
      // "sonar" is closest to "sonarr"
      const result = findClosestMatch("sonar", candidates);
      expect(result).toBe("sonarr");
    });
  });

  describe("findClosestMatches", () => {
    const candidates = ["sonarr", "radarr", "bazarr", "prowlarr", "traefik", "plex"];

    it("should return multiple matches sorted by score descending", () => {
      // "sonar" should match "sonarr" best, and other *arr services may also match
      const results = findClosestMatches("sonar", candidates);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toBe("sonarr");
    });

    it("should respect maxResults", () => {
      const results = findClosestMatches("arr", candidates, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should return empty array when nothing matches", () => {
      const results = findClosestMatches("zzzzzzz", candidates);
      expect(results).toEqual([]);
    });

    it("should return empty array for empty candidates", () => {
      const results = findClosestMatches("plex", []);
      expect(results).toEqual([]);
    });

    it("should respect custom minScore", () => {
      // With a very high threshold, only exact or near-exact matches qualify
      const results = findClosestMatches("plex", candidates, 3, 0.99);
      // Only exact match "plex" would score 1.0
      expect(results).toEqual(["plex"]);
    });

    it("should return results sorted by score descending", () => {
      const results = findClosestMatches("radarr", candidates, 5, 0.3);
      // "radarr" should be first (exact match), other *arr names may follow
      expect(results[0]).toBe("radarr");

      // Verify descending order by computing scores
      for (let i = 1; i < results.length; i++) {
        const prevScore = computeSimilarity("radarr", results[i - 1]!);
        const currScore = computeSimilarity("radarr", results[i]!);
        expect(prevScore).toBeGreaterThanOrEqual(currScore);
      }
    });

    it("should default maxResults to 3", () => {
      // Use a low threshold to get many matches
      const results = findClosestMatches("arr", candidates, undefined, 0.1);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("should return all qualifying matches when fewer than maxResults", () => {
      // Only "plex" should match "plex" with high threshold
      const results = findClosestMatches("plex", candidates, 5, 0.9);
      expect(results).toEqual(["plex"]);
    });
  });

  describe("Edge cases", () => {
    it("should handle candidates with mixed casing", () => {
      const result = findClosestMatch("plex", ["Plex", "TRAEFIK", "Sonarr"]);
      expect(result).toBe("Plex");
    });

    it("should handle query with special characters", () => {
      const result = findClosestMatch("plex-ts", ["plex-ts", "plex", "jellyfin-ts"]);
      expect(result).toBe("plex-ts");
    });

    it("should handle very long strings without errors", () => {
      const longQuery = "a".repeat(200);
      const longCandidates = ["a".repeat(200), "b".repeat(200), "c".repeat(200)];
      const result = findClosestMatch(longQuery, longCandidates);
      expect(result).toBe("a".repeat(200));
    });

    it("should handle single candidate array", () => {
      const result = findClosestMatch("plex", ["plex"]);
      expect(result).toBe("plex");
    });

    it("should handle single candidate with no match", () => {
      const result = findClosestMatch("zzzzz", ["plex"]);
      expect(result).toBeUndefined();
    });

    it("should handle numeric-like strings", () => {
      const result = findClosestMatch("8080", ["8080", "8081", "3000"]);
      expect(result).toBe("8080");
    });

    it("should handle strings with hyphens (common in service names)", () => {
      const candidates = ["media-stack", "arr-stack", "core-stack"];
      const result = findClosestMatch("media-stck", candidates);
      expect(result).toBe("media-stack");
    });
  });
});
