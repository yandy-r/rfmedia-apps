/**
 * Diagnostics for an empty `--tag` selection: segment-aware suggestions and stale-mapping blame.
 *
 * The shared `findClosestMatch()` in `../fuzzy-match.js` compares whole strings, which makes it
 * useless for tag paths: `computeSimilarity("networking", "infrastructure/core/networking")` is
 * ~0.34, below that helper's `minScore = 0.4` default, so a typo'd or partial tag gets no
 * suggestion at all. Lowering the shared default is not an option -- `fuzzy-match.spec.ts` pins it
 * and service-name suggestions depend on it -- so tag suggestions get their own scorer here, which
 * additionally compares the pattern's last literal segment against each segment of every known tag.
 *
 * {@link diagnoseEmptyTagSelection} is the single source of both `TagSelectorEmptyError` diagnostic
 * fields, shared by the resolver (`lib/interactive-selection.ts`) and `status` (`actions/status.ts`)
 * so identical syntax cannot produce divergent explanations across commands.
 */

import type { TagIndex, TagPath, TagPattern, TagTerm } from "../../types/tags.js";
import { computeSimilarity } from "../fuzzy-match.js";
import { applyTagAxis } from "../selector.js";
import { tagMatches } from "./tag-pattern.js";

/**
 * Minimum score a candidate must exceed to be offered as a suggestion. Deliberately stricter than
 * `findClosestMatch`'s shared 0.4 default: per-segment scoring inflates scores (a short segment
 * matches a short segment easily), so reusing 0.4 here would suggest unrelated tags.
 */
const TAG_SUGGESTION_THRESHOLD = 0.5;

/**
 * A segment is comparable as a literal only when it is non-empty and carries no wildcard. Under the
 * pattern grammar a wildcard occupies a whole element (`*`, `**`), so any segment containing `*` is
 * a wildcard element or malformed -- either way it is not a literal and carries no naming signal.
 */
function isLiteralSegment(segment: string): boolean {
  return segment.length > 0 && !segment.includes("*");
}

/**
 * Extracts the last literal segment of a tag pattern body, skipping wildcard elements.
 * Returns undefined when the pattern is entirely wildcards.
 */
function lastLiteralSegment(patternBody: string): string | undefined {
  const segments = patternBody.split("/");

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];

    if (segment !== undefined && isLiteralSegment(segment)) {
      return segment;
    }
  }

  return undefined;
}

/**
 * Scores one known tag: the best similarity of any of its segments against the pattern's last
 * literal segment, or the whole-path similarity, whichever is higher. The per-segment arm is what
 * rescues `networking` -> `infrastructure/core/networking`; the whole-path arm keeps a fully
 * spelled-out near-miss (`infrastructure/core/netwroking`) scoring well.
 */
function scoreTag(lastLiteral: string, patternBody: string, tag: TagPath): number {
  let best = computeSimilarity(patternBody, tag);

  for (const segment of tag.split("/")) {
    const score = computeSimilarity(lastLiteral, segment);

    if (score > best) {
      best = score;
    }
  }

  return best;
}

/**
 * Finds the known tag closest to an unmatched `--tag` pattern, for "did you mean" output.
 *
 * A leading `!` is stripped before scoring -- negation is syntax, not part of the tag name.
 * Ties keep the first candidate in `knownTags` order, which is sorted.
 *
 * @param pattern - The raw pattern that matched nothing (may be negated and may contain wildcards)
 * @param knownTags - Every effective tag in the index
 * @returns The best-scoring tag strictly above 0.5, or undefined when nothing is close enough
 *
 * @example
 * findClosestTag("networking", ["infrastructure/core/networking" as TagPath])
 * // Returns: "infrastructure/core/networking" (the shared findClosestMatch returns undefined)
 */
export function findClosestTag(pattern: string, knownTags: readonly TagPath[]): string | undefined {
  const patternBody = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  const lastLiteral = lastLiteralSegment(patternBody);

  if (lastLiteral === undefined) {
    return undefined;
  }

  let bestTag: string | undefined;
  let bestScore = TAG_SUGGESTION_THRESHOLD;

  for (const tag of knownTags) {
    const score = scoreTag(lastLiteral, patternBody, tag);

    if (score > bestScore) {
      bestScore = score;
      bestTag = tag;
    }
  }

  return bestTag;
}

/** Whether a parsed pattern denotes at least one tag the index actually knows. */
function patternIsKnown(pattern: TagPattern, knownTags: readonly TagPath[]): boolean {
  return knownTags.some((tag) => tagMatches(pattern, tag));
}

/**
 * The first pattern, in operator-typed order, that the index does not know.
 *
 * `findClosestTag` documents a precondition its callers cannot see: the pattern must be one
 * **that matched nothing**. Calling it on `axis.terms[0]` unconditionally violates that —
 * `computeSimilarity("media", "media") === 1.0`, far above the 0.5 threshold, so
 * `--tag media` narrowed to an empty intersection by `-s alpha` suggested `'media'`, the tag
 * the operator had just typed correctly. With several terms it was worse: the genuinely
 * misspelled one could never be reported because only the first was ever scored.
 */
function firstUnknownPattern(
  terms: readonly TagTerm[],
  knownTags: readonly TagPath[],
): TagPattern | undefined {
  for (const term of terms) {
    for (const pattern of [...term.include, ...term.exclude]) {
      if (!patternIsKnown(pattern, knownTags)) {
        return pattern;
      }
    }
  }

  return undefined;
}

/**
 * The `tags.mapping` services the patterns genuinely select but `compose.yml` does not declare.
 *
 * `TagIndex.effective` covers stale mapping entries as well as the compose universe precisely so
 * this is computable, and re-running `applyTagAxis` over `unresolvedServices` keeps the
 * include/exclude and cross-term AND semantics identical to the real selection rather than
 * re-deriving them here.
 */
function matchedUnresolvedServices(terms: readonly TagTerm[], index: TagIndex): readonly string[] {
  const stale = applyTagAxis(
    terms.map((term) => term.source),
    index,
    index.unresolvedServices,
  );

  return stale.kind === "present" ? [...stale.matched] : [];
}

/** The two diagnostic fields of `TagSelectorEmptyError` that have to be derived. */
export interface EmptyTagSelectionDiagnosis {
  /** Segment-aware "did you mean", or undefined when every pattern is already known. */
  readonly suggestion: string | undefined;
  /** Stale `tags.mapping` entries that are the *actual* explanation, or empty. */
  readonly staleServices: readonly string[];
}

/**
 * Explains why a `--tag` selection came out empty (design §9.5).
 *
 * `staleServices` is populated only when the stale-mapping story is true: the patterns must have
 * matched **nothing in the compose universe** and must genuinely select one of the unresolved
 * entries. `TagIndex.unresolvedServices` is the *global* set of mapping services absent from
 * compose.yml and is disjoint from `matched` by construction, so passing it through unfiltered
 * made the formatter assert "'tags.mapping' assigns this tag to services that are absent" about
 * entries carrying entirely unrelated tags — while suppressing the fuzzy suggestion and the
 * `tag list` hint that were the real diagnosis. A non-empty `matched` means the tag axis found
 * services and some *other* axis emptied the intersection (`-s traefik --tag "media/**"`), which
 * is the generic branch's job to explain.
 *
 * @param terms - The parsed `--tag` occurrences, in the order the operator typed them
 * @param matched - What the tag axis selected from the compose universe (before intersection)
 * @param index - The tag index, read for `allTags`, `effective` and `unresolvedServices`
 * @returns The suggestion and stale-service fields to hand to `TagSelectorEmptyError`
 */
export function diagnoseEmptyTagSelection(
  terms: readonly TagTerm[],
  matched: ReadonlySet<string>,
  index: TagIndex,
): EmptyTagSelectionDiagnosis {
  const blameStaleMapping = matched.size === 0 && index.unresolvedServices.length > 0;

  return {
    suggestion: suggestUnmatchedTag(terms, index.allTags),
    staleServices: blameStaleMapping ? matchedUnresolvedServices(terms, index) : [],
  };
}

/**
 * The "did you mean" for the first pattern the index does not know, if any.
 *
 * @param terms - The parsed `--tag` occurrences, in the order the operator typed them
 * @param knownTags - Every effective tag in the index
 * @returns The closest known tag, or undefined when nothing is unknown or nothing is close
 */
export function suggestUnmatchedTag(
  terms: readonly TagTerm[],
  knownTags: readonly TagPath[],
): string | undefined {
  const unknown = firstUnknownPattern(terms, knownTags);

  return unknown === undefined ? undefined : findClosestTag(unknown.source, knownTags);
}
