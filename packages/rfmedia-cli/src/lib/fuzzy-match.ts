/**
 * Fuzzy string matching utilities for rfmedia CLI.
 *
 * Provides string normalization and similarity comparison for matching
 * video titles to audio track titles.
 */

import { distance as levenshteinDistance } from "fastest-levenshtein";

import { logDebug } from "./logger.js";

/**
 * Unicode replacements for normalization.
 * Maps special Unicode characters to their ASCII equivalents.
 */
const UNICODE_REPLACEMENTS: [RegExp, string][] = [
  // Ellipsis character to three periods
  [/\u2026/g, "..."],
  // Various dash characters to hyphen
  [/[\u2013\u2014\u2015]/g, "-"],
  // Curly quotes to straight quotes
  [/[\u2018\u2019]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  // Non-breaking space to regular space
  [/\u00A0/g, " "],
];

/**
 * Characters to remove during normalization (punctuation).
 * These are stripped after other normalizations.
 */
const STRIP_PATTERN = /[.,!?;:'"()\[\]{}&@#$%^*+=<>|\\\/~`]/g;

/**
 * Normalizes a string for fuzzy matching.
 * - Converts to lowercase
 * - Replaces Unicode characters with ASCII equivalents
 * - Removes punctuation
 * - Collapses multiple spaces to single space
 * - Trims whitespace
 *
 * @param str - The string to normalize
 * @returns Normalized string for comparison
 *
 * @example
 * normalizeForMatch("Born To Make You Happy")
 * // Returns: "born to make you happy"
 *
 * normalizeForMatch("...Baby One More Time")
 * // Returns: "baby one more time"
 *
 * normalizeForMatch("…Baby One More Time")  // Unicode ellipsis
 * // Returns: "baby one more time"
 */
export function normalizeForMatch(str: string): string {
  let normalized = str.toLowerCase();

  // Apply Unicode replacements
  for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }

  // Remove punctuation (including the ASCII dots we just added)
  normalized = normalized.replace(STRIP_PATTERN, "");

  // Collapse multiple spaces and trim
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Calculates the similarity score between two strings.
 * Uses Levenshtein distance normalized to a 0-1 scale.
 *
 * @param str1 - First string
 * @param str2 - Second string
 * @returns Similarity score from 0 (no match) to 1 (exact match)
 */
export function compareSimilarity(str1: string, str2: string): number {
  // Normalize both strings
  const norm1 = normalizeForMatch(str1);
  const norm2 = normalizeForMatch(str2);

  // Handle empty strings
  if (norm1.length === 0 && norm2.length === 0) {
    return 1;
  }
  if (norm1.length === 0 || norm2.length === 0) {
    return 0;
  }

  // Calculate Levenshtein distance
  const dist = levenshteinDistance(norm1, norm2);

  // Normalize to 0-1 scale (1 = perfect match)
  const maxLen = Math.max(norm1.length, norm2.length);
  const similarity = 1 - dist / maxLen;

  return similarity;
}

/**
 * Finds the closest string match from candidates.
 *
 * @param query - Input value to match
 * @param candidates - Candidate values to compare
 * @param minScore - Minimum similarity threshold (0-1, default: 0.4)
 * @returns Closest candidate above threshold, or undefined when no match qualifies
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
    const score = compareSimilarity(query, candidate);
    if (score >= minScore && score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

/**
 * Result of finding the best match from candidates.
 */
export interface BestMatchResult<T> {
  /** The matched item */
  item: T;
  /** The target string that was matched */
  target: string;
  /** Similarity score (0-1) */
  score: number;
}

/**
 * Finds the best matching item from a list of candidates.
 *
 * @param query - The string to match
 * @param candidates - Array of candidate items
 * @param getTarget - Function to extract the target string from each candidate
 * @param minScore - Minimum score threshold (0-1, default: 0)
 * @returns The best match result, or null if no match meets the threshold
 *
 * @example
 * const tracks = [
 *   { title: "Born to Make You Happy", path: "..." },
 *   { title: "Baby One More Time", path: "..." },
 * ];
 *
 * const result = findBestMatch(
 *   "Born To Make You Happy",
 *   tracks,
 *   (t) => t.title,
 *   0.7
 * );
 * // Returns: { item: { title: "Born to Make You Happy", ... }, target: "Born to Make You Happy", score: 1.0 }
 */
export function findBestMatch<T>(
  query: string,
  candidates: T[],
  getTarget: (item: T) => string,
  minScore = 0,
): BestMatchResult<T> | null {
  if (candidates.length === 0) {
    return null;
  }

  let bestMatch: BestMatchResult<T> | null = null;

  for (const candidate of candidates) {
    const target = getTarget(candidate);
    const score = compareSimilarity(query, target);

    logDebug(`  Comparing "${query}" vs "${target}": ${(score * 100).toFixed(1)}%`);

    if (score >= minScore && (bestMatch === null || score > bestMatch.score)) {
      bestMatch = { item: candidate, target, score };
    }
  }

  return bestMatch;
}

/**
 * Checks if an artist name fuzzy-matches another.
 * Used to match artist directories that may contain UUIDs.
 *
 * @param videoArtist - Artist name from video directory
 * @param libraryArtist - Artist name from library directory (may contain UUID)
 * @param minScore - Minimum score threshold (0-1, default: 0.8)
 * @returns true if artists match above the threshold
 *
 * @example
 * artistsMatch("Britney Spears", "Britney Spears (45a663b5)")
 * // Returns: true
 *
 * artistsMatch("Britney Spears", "Christina Aguilera")
 * // Returns: false
 */
export function artistsMatch(videoArtist: string, libraryArtist: string, minScore = 0.8): boolean {
  // First try exact match (case-insensitive)
  if (videoArtist.toLowerCase() === libraryArtist.toLowerCase()) {
    return true;
  }

  // Try to strip UUID from library artist name (pattern: "Artist Name (uuid)")
  const uuidPattern = /\s*\([a-f0-9-]+\)\s*$/i;
  const libraryArtistClean = libraryArtist.replace(uuidPattern, "");

  if (videoArtist.toLowerCase() === libraryArtistClean.toLowerCase()) {
    return true;
  }

  // Fall back to fuzzy match
  const score = compareSimilarity(videoArtist, libraryArtistClean);
  logDebug(
    `Artist match: "${videoArtist}" vs "${libraryArtist}" (cleaned: "${libraryArtistClean}"): ${(score * 100).toFixed(1)}%`,
  );

  return score >= minScore;
}
