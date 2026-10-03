/**
 * Identity folding and duplicate grouping primitives for the Lidarr library
 * health audit.
 *
 * This module is the only novel algorithm in the audit: everything else
 * composes already-existing selection and projection helpers. It is
 * deliberately free of I/O, client, and adapter imports — pure string
 * normalization plus O(n) hash bucketing over already-retrieved projections —
 * so the duplicate-identity check stays trivially unit-testable through its
 * consumers.
 */

import { normalizeForMatch } from "../fuzzy-match.js";

/**
 * Combining marks left behind by NFKD decomposition.
 *
 * `normalizeForMatch` lowercases, maps ellipsis/dash/quote/nbsp characters,
 * strips ASCII punctuation, and collapses whitespace — but it does NOT
 * decompose precomposed letters, so "Björk" and "Bjork" would not collide
 * without this step.
 */
const COMBINING_MARK_PATTERN = /\p{M}/gu;

/**
 * Leading English article on an already-folded (lowercased, whitespace
 * collapsed) name. Only a genuine article *prefix* is stripped: a name that is
 * nothing but an article keeps its word rather than folding to the empty key.
 */
const LEADING_ARTICLE_PATTERN = /^(?:the|a|an)\s+/u;

/** Runs of two or more path separators. */
const DUPLICATE_SEPARATOR_PATTERN = /\/{2,}/gu;

/** Trailing path separators. */
const TRAILING_SEPARATOR_PATTERN = /\/+$/u;

/**
 * Folds an artist name to a duplicate-candidate key.
 *
 * Three ordered steps: NFKD decomposition with combining-mark removal (so
 * "Björk" and "Bjork" collide), then casefold / unicode-character mapping /
 * punctuation stripping / whitespace collapse delegated to `normalizeForMatch`
 * (`../fuzzy-match.js`), then a leading-article strip (so "The Beatles" and
 * "Beatles" collide).
 *
 * Decomposing FIRST is load-bearing. `normalizeForMatch` strips ASCII
 * punctuation, so any compatibility character that decomposes INTO stripped
 * punctuation has to be decomposed before that strip runs: folding "Ｍｅ ＆
 * Ｙｏｕ" after the strip leaves "me & you" while "Me & You" folds to "me you",
 * and the two never bucket together. Decomposing first also stops uppercase
 * from leaking through compatibility forms with no lowercase mapping ("℡").
 *
 * Exact post-fold equality only. `findBestMatch`/`compareSimilarity` are
 * deliberately unused: `findBestMatch` emits a `logDebug` per pairwise
 * comparison, which would flood an audit over a full library, and a threshold
 * matcher has no tiebreak key to bucket on.
 *
 * @param name - Raw `LidarrArtist.artistName`.
 * @returns The fold key; `""` when nothing survives folding (a name made only
 *   of punctuation, or blank).
 */
export function foldArtistName(name: string): string {
  const decomposed = name.normalize("NFKD").replace(COMBINING_MARK_PATTERN, "");

  // `normalizeForMatch` already collapsed whitespace and trimmed, and the
  // article pattern consumes its own trailing separator, so no further trim can
  // change the key.
  return normalizeForMatch(decomposed).replace(LEADING_ARTICLE_PATTERN, "");
}

/**
 * Normalizes an artist path for collision detection: duplicate separators
 * collapsed and trailing separators removed.
 *
 * Comparison stays CASE-SENSITIVE — these containers run on Linux with
 * case-sensitive bind mounts, so folding case would fabricate duplicate
 * findings from two genuinely distinct directories.
 *
 * A path that is nothing but separators normalizes to the root `"/"` rather
 * than to the empty key, because the root is a real (if pathological) shared
 * location, whereas the empty key means "no path to compare".
 *
 * @param path - Raw `LidarrArtist.path`.
 * @returns The normalized key; `""` when the path is blank or whitespace-only.
 */
export function normalizeArtistPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    return "";
  }

  const collapsed = trimmed.replace(DUPLICATE_SEPARATOR_PATTERN, "/");
  if (collapsed.length <= 1) {
    return collapsed;
  }

  return collapsed.replace(TRAILING_SEPARATOR_PATTERN, "");
}

/** A set of items that collapsed onto one identity key. */
export interface LidarrAuditDuplicateGroup<T> {
  /** The shared key the members collapsed onto. Never `""`. */
  readonly key: string;
  /** Always length >= 2. */
  readonly members: readonly T[];
}

/**
 * Groups items by a derived key in O(n), returning only collisions.
 *
 * Insertion-ordered `Map` bucketing gives deterministic output: groups appear
 * in the order their first member appeared in `items`, and members keep their
 * input order within a group.
 *
 * @param items - Items to group; the input array is not mutated.
 * @param keyOf - Key deriver. Returning `undefined` or `""` EXCLUDES the item,
 *   so an absent optional field (`path`, `foreignAlbumId`) can never act as a
 *   match key and fabricate a duplicate.
 * @returns Frozen groups of two or more members, ordered by first appearance.
 */
export function groupDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
): readonly LidarrAuditDuplicateGroup<T>[] {
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined || key === "") {
      continue;
    }

    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [item]);
      continue;
    }
    bucket.push(item);
  }

  const groups: LidarrAuditDuplicateGroup<T>[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) {
      continue;
    }
    groups.push(Object.freeze({ key, members: Object.freeze(members) }));
  }

  return Object.freeze(groups);
}
