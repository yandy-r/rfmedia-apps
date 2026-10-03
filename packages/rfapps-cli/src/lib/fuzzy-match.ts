/**
 * Fuzzy string matching utilities for rfapps CLI.
 *
 * Provides case-insensitive similarity comparison using Levenshtein distance
 * for matching service names, group names, and profile names with "did you mean"
 * suggestions.
 */

import { distance } from "fastest-levenshtein";

/**
 * Computes a similarity score between two strings using Levenshtein distance.
 * Both strings are normalized to lowercase before comparison.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score from 0 (completely different) to 1 (exact match)
 */
export function computeSimilarity(a: string, b: string): number {
  const normA = a.toLowerCase();
  const normB = b.toLowerCase();

  if (normA.length === 0 && normB.length === 0) {
    return 1;
  }

  if (normA.length === 0 || normB.length === 0) {
    return 0;
  }

  const dist = distance(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);

  return 1 - dist / maxLen;
}

/**
 * Finds the single closest match from a list of candidates.
 *
 * @param query - The string to match against candidates
 * @param candidates - Array of candidate strings to compare against
 * @param minScore - Minimum similarity threshold (0-1, default: 0.4)
 * @returns The best matching candidate above the threshold, or undefined if none match
 *
 * @example
 * findClosestMatch("plx", ["plex", "traefik", "sonarr"])
 * // Returns: "plex" (score ~0.75)
 *
 * findClosestMatch("zzzzz", ["plex", "traefik", "sonarr"])
 * // Returns: undefined (no match above threshold)
 */
export function findClosestMatch(
  query: string,
  candidates: string[],
  minScore = 0.4,
): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  let bestCandidate: string | undefined;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = computeSimilarity(query, candidate);

    if (score >= minScore && score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

/**
 * Finds the closest matches from a list of candidates, sorted by score descending.
 *
 * @param query - The string to match against candidates
 * @param candidates - Array of candidate strings to compare against
 * @param maxResults - Maximum number of results to return (default: 3)
 * @param minScore - Minimum similarity threshold (0-1, default: 0.4)
 * @returns Array of matching candidates sorted by score descending, up to maxResults
 *
 * @example
 * findClosestMatches("plx", ["plex", "prowlarr", "traefik", "sonarr"])
 * // Returns: ["plex"] (only "plex" is above threshold)
 */
export function findClosestMatches(
  query: string,
  candidates: string[],
  maxResults = 3,
  minScore = 0.4,
): string[] {
  if (candidates.length === 0) {
    return [];
  }

  const scored: { candidate: string; score: number }[] = [];

  for (const candidate of candidates) {
    const score = computeSimilarity(query, candidate);

    if (score >= minScore) {
      scored.push({ candidate, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map((s) => s.candidate);
}
