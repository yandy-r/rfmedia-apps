/**
 * `--tag` pattern parsing and matching (design §3.4–§3.8).
 *
 * The grammar is deliberately narrow: a wildcard occupies a **whole** path element.
 * `*` matches exactly one segment and never crosses `/`; `**` matches zero or more
 * segments and does cross `/`. That restriction is what makes matching a pure
 * segment-array comparison and is why **no third-party glob library is used here** —
 * off-the-shelf glob matchers let `*` cross `/` and carry brace expansion, character
 * classes, and dotfile rules this grammar forbids. Do not add one; the design and the
 * `doneWhen` gate for this file both forbid it.
 *
 * Matching is anchored at both ends and runs against a service's **effective** tag
 * set (the ancestor closure from §3.3), never its declared tags.
 */

import { TAG_MAX_DEPTH, TAG_MAX_SEGMENT_LENGTH } from "../../types/tags.js";
import type { TagPath, TagPattern, TagPatternElement, TagTerm } from "../../types/tags.js";
import { InvalidArgumentError } from "../errors.js";
import { invalidSegmentReason, isValidTagSegment, segmentTooLongReason } from "./tag-path.js";

/** The CLI flag every pattern rejection is attributed to. */
const TAG_ARGUMENT = "--tag";

/** Renders one parsed element back to its authored token, for error guidance. */
function elementToken(element: TagPatternElement): string {
  switch (element.kind) {
    case "deep":
      return "**";
    case "single":
      return "*";
    case "literal":
      return element.value;
  }
}

/** Rejects a pattern with the usage-error flavour (`InvalidArgumentError`, exit 2). */
function rejectPattern(source: string, reason: string, validValues?: string[]): never {
  throw new InvalidArgumentError(TAG_ARGUMENT, source, reason, validValues);
}

/** Strips at most one leading and at most one trailing `/`, mirroring `normalizeTag`. */
function stripOuterSlashes(value: string): string {
  let result = value;

  if (result.startsWith("/")) {
    result = result.slice(1);
  }

  if (result.endsWith("/")) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Rejects trailing `/*` with a corrective message (design §3.7).
 *
 * Under ancestor closure `X/*` would mean "the X subtree, *excluding* services whose
 * only X-tag is the depth-1 `X`" — a strict subset of `X` with a non-obvious exclusion
 * rule that inverts every filesystem-glob intuition. Single-segment wildcards in any
 * interior position stay fully supported; only the trailing position is a trap.
 */
function rejectTrailingSingleWildcard(
  source: string,
  elements: readonly TagPatternElement[],
): void {
  const last = elements[elements.length - 1];

  if (elements.length < 2 || last === undefined || last.kind !== "single") {
    return;
  }

  const prefix = elements.slice(0, -1).map(elementToken).join("/");

  rejectPattern(
    source,
    `trailing '/*' is not supported; use '${prefix}' to select the whole subtree, ` +
      `or '${prefix}/**' for the same thing, written explicitly`,
    [prefix, `${prefix}/**`],
  );
}

/** Classifies one already-lowercased pattern element, rejecting partial wildcards. */
function parseElement(source: string, raw: string): TagPatternElement {
  if (raw === "**") {
    return { kind: "deep" };
  }

  if (raw === "*") {
    return { kind: "single" };
  }

  if (raw.includes("*") || raw.includes("?")) {
    rejectPattern(
      source,
      `wildcards must occupy a whole path element: '${raw}' mixes a wildcard with ` +
        `literal characters. Use '*' for exactly one segment or '**' for any depth`,
    );
  }

  if (!isValidTagSegment(raw)) {
    rejectPattern(source, invalidSegmentReason(raw));
  }

  if (raw.length > TAG_MAX_SEGMENT_LENGTH) {
    rejectPattern(source, segmentTooLongReason(raw));
  }

  return { kind: "literal", value: raw };
}

/**
 * Parses one `--tag` pattern (design §3.4).
 *
 * Patterns are case-insensitive and are canonicalized the same way tags are: trimmed,
 * lowercased, and stripped of at most one leading and one trailing slash. A leading
 * `!` negates the whole pattern; `parseTagPattern` records that on
 * {@link TagPattern.negated} and leaves the exclusion arithmetic to the caller
 * (§3.8), so `tagMatches` always answers "does the pattern body match".
 *
 * @param source - One authored pattern, e.g. `"!media/**"`
 * @returns The parsed pattern, preserving the authored `source` for error messages
 * @throws InvalidArgumentError for an empty pattern, an empty element (`a//b`), a
 *   partial-segment wildcard (`net*`, `a**b`, `infra?tructure`), a trailing `/*`,
 *   an over-deep pattern, or a literal element outside the §3.1 charset
 *
 * @example
 * parseTagPattern("MEDIA/Streaming") // elements: [literal media, literal streaming]
 * parseTagPattern("infrastructure/*") // throws: trailing '/*' is not supported
 */
export function parseTagPattern(source: string): TagPattern {
  const trimmed = source.trim();

  if (trimmed.length === 0) {
    rejectPattern(source, "tag pattern must not be empty");
  }

  const negated = trimmed.startsWith("!");
  const body = stripOuterSlashes((negated ? trimmed.slice(1).trim() : trimmed).toLowerCase());

  if (body.length === 0) {
    rejectPattern(
      source,
      negated ? "'!' must be followed by a tag pattern" : "tag pattern must not be empty",
    );
  }

  const rawElements = body.split("/");

  for (const raw of rawElements) {
    if (raw.length === 0) {
      rejectPattern(
        source,
        "tag pattern contains an empty path element (a doubled '/' has no canonical reading)",
      );
    }
  }

  if (rawElements.length > TAG_MAX_DEPTH) {
    rejectPattern(
      source,
      `tag pattern exceeds the maximum depth of ${TAG_MAX_DEPTH} elements (got ${rawElements.length})`,
    );
  }

  const elements = rawElements.map((raw) => parseElement(source, raw));

  rejectTrailingSingleWildcard(source, elements);

  return { source: trimmed, negated, elements };
}

/**
 * Parses one `--tag` flag occurrence into its include and exclude patterns.
 *
 * Comma-separated patterns within a single flag are **OR**ed together (§3.6); the
 * **AND** across separate `--tag` flags is applied by the selector, not here.
 *
 * @param source - The raw flag value, e.g. `"media/**,!media/streaming"`
 * @returns The term with positive patterns in `include` and `!`-prefixed ones in `exclude`
 * @throws InvalidArgumentError when the value is empty or contains an empty
 *   comma-delimited slot, or when any individual pattern is malformed
 *
 * @example
 * parseTagTerm("media/**,hardware/**") // include: 2 patterns, exclude: []
 */
export function parseTagTerm(source: string): TagTerm {
  if (source.trim().length === 0) {
    rejectPattern(source, "tag pattern must not be empty");
  }

  const include: TagPattern[] = [];
  const exclude: TagPattern[] = [];

  for (const part of source.split(",")) {
    if (part.trim().length === 0) {
      rejectPattern(source, "tag pattern list contains an empty entry");
    }

    const pattern = parseTagPattern(part);

    if (pattern.negated) {
      exclude.push(pattern);
    } else {
      include.push(pattern);
    }
  }

  return { source, include, exclude };
}

/**
 * Tests whether a pattern matches one tag path (design §3.5).
 *
 * Anchored at both ends via the backward dynamic program
 * `M[i][j] = "P[i..] matches T[j..]"`. `|P|` and `|T|` are both bounded by
 * `TAG_MAX_DEPTH`, so this is at most 81 cells — no backtracking pathology and no
 * memoization needed. Negation is intentionally ignored: `tagMatches` answers
 * "does the pattern body match", and §3.8 decides what that means for selection.
 *
 * @param pattern - A parsed pattern
 * @param tag - A normalized tag path
 * @returns true when the pattern consumes the entire tag path
 */
export function tagMatches(pattern: TagPattern, tag: TagPath): boolean {
  const target = tag.split("/");
  const elements = pattern.elements;
  const targetLength = target.length;

  // `next` holds row i+1; `current` holds row i. Row |P| is the base case:
  // it matches only when the tag is fully consumed.
  let next: boolean[] = new Array<boolean>(targetLength + 1).fill(false);
  next[targetLength] = true;

  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];

    if (element === undefined) {
      return false;
    }

    const current = new Array<boolean>(targetLength + 1).fill(false);

    // j descends because the `**` case reads current[j + 1] (same row).
    for (let j = targetLength; j >= 0; j -= 1) {
      const consumed = j < targetLength;
      let matched = false;

      if (element.kind === "deep") {
        matched = (next[j] ?? false) || (consumed && (current[j + 1] ?? false));
      } else if (element.kind === "single") {
        matched = consumed && (next[j + 1] ?? false);
      } else {
        matched = consumed && target[j] === element.value && (next[j + 1] ?? false);
      }

      current[j] = matched;
    }

    next = current;
  }

  return next[0] ?? false;
}

/**
 * Tests whether a pattern matches any tag in a service's **effective** tag set.
 *
 * Matching against the ancestor-closed set (§3.3) is what makes bare
 * `--tag infrastructure` select a service declared as
 * `infrastructure/core/networking`. An untagged service has an empty effective set
 * and therefore matches nothing — including `**`.
 *
 * @param pattern - A parsed pattern
 * @param effective - The service's ancestor-closed effective tag set
 * @returns true when at least one effective tag matches
 */
export function serviceMatches(pattern: TagPattern, effective: ReadonlySet<TagPath>): boolean {
  for (const tag of effective) {
    if (tagMatches(pattern, tag)) {
      return true;
    }
  }

  return false;
}
