/**
 * Tag path normalization, validation, ancestry, and ordering (design §3.1–§3.3).
 *
 * This module is the **sole minting site** for the nominal `TagPath` type. Every
 * tag that reaches the index, the matcher, or the inference engine passes through
 * `normalizeTag()` first, so downstream code may assume a tag is lowercase,
 * slash-separated, free of leading/trailing slashes and empty segments, and within
 * the depth/length limits. Never cast a raw string to `TagPath` elsewhere.
 *
 * Normalization is idempotent: `normalizeTag(normalizeTag(x)) === normalizeTag(x)`.
 */

import { TAG_MAX_DEPTH, TAG_MAX_LENGTH, TAG_MAX_SEGMENT_LENGTH } from "../../types/tags.js";
import type { TagPath } from "../../types/tags.js";
import { ConfigValidationError, InvalidArgumentError } from "../errors.js";

/**
 * Where a tag literal came from, which decides the error flavour thrown on
 * rejection (design §3.2 "Throw sites").
 *
 * - `cli` — a `--tag` literal typed by an operator. Throws {@link InvalidArgumentError}
 *   so the usage-error exit path (exit 2) and the `Invalid value '…' for --tag: …`
 *   rendering apply.
 * - `config` — a `tags.mapping` entry. Throws {@link ConfigValidationError} naming the
 *   config file, so a malformed mapping fails fast at the config boundary rather than
 *   silently mis-targeting containers.
 */
export type TagInputOrigin =
  | { readonly kind: "cli"; readonly argument?: string }
  | { readonly kind: "config"; readonly source: string; readonly field?: string };

const DEFAULT_ORIGIN: TagInputOrigin = { kind: "cli" };

/** The segment charset from design §3.1: starts and ends alphanumeric. */
export const TAG_SEGMENT_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

/**
 * Tests one already-lowercased path segment against the design §3.1 charset.
 *
 * Shared with `tag-pattern.ts` so a literal pattern element and a declared tag
 * segment can never disagree about what a legal segment is.
 *
 * @param segment - A single path segment (no slashes)
 * @returns true when the segment matches the §3.1 grammar
 */
export function isValidTagSegment(segment: string): boolean {
  return TAG_SEGMENT_PATTERN.test(segment);
}

/**
 * Builds the shared "bad charset" rejection reason.
 *
 * Exported so the CLI throw site, the config throw site, and the pattern parser
 * all produce byte-identical guidance.
 *
 * @param segment - The offending segment
 * @returns A human-readable reason naming the legal charset
 */
export function invalidSegmentReason(segment: string): string {
  return (
    `segment '${segment}' must start and end with a lowercase alphanumeric ` +
    `character and may otherwise contain only 'a-z', '0-9', '.', '_' and '-'`
  );
}

/**
 * Builds the shared "segment too long" rejection reason.
 *
 * @param segment - The offending segment
 * @returns A human-readable reason naming the limit
 */
export function segmentTooLongReason(segment: string): string {
  return `segment '${segment}' exceeds the maximum segment length of ${TAG_MAX_SEGMENT_LENGTH} characters`;
}

/**
 * Brands a string that this module has already proven valid.
 *
 * Kept private: `tag-path.ts` is the only module permitted to mint a `TagPath`,
 * and only `normalizeTag` (full validation) and `tagAncestors` (prefixes of an
 * already-valid path) may call it.
 */
function brandTagPath(value: string): TagPath {
  return value as TagPath;
}

/** Routes a rejection to the error class the caller's origin demands (§3.2). */
function rejectTag(input: string, reason: string, origin: TagInputOrigin): never {
  if (origin.kind === "config") {
    throw new ConfigValidationError(
      origin.field ?? "tags.mapping",
      origin.source,
      `tag '${input}' is invalid: ${reason}`,
    );
  }

  throw new InvalidArgumentError(origin.argument ?? "--tag", input, reason);
}

/** Strips at most one leading and at most one trailing `/` (§3.2 step 3). */
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
 * Normalizes and validates an authored tag literal into a canonical `TagPath`.
 *
 * Implements design §3.2 in order: trim, lowercase, strip at most one leading and
 * one trailing slash, reject empty segments, validate the §3.1 charset, then
 * validate depth and length limits.
 *
 * `a//b` is rejected rather than collapsed: a doubled slash has no defensible
 * canonical reading. Case folding and single-slash stripping are canonicalization,
 * not error hiding — `Media/Streaming/` and `media/streaming` denote one concept and
 * silently maintaining two parallel hierarchies is the worse outcome.
 *
 * @param input - The authored tag, e.g. `"Media/Streaming/"`
 * @param origin - Selects the error flavour; defaults to the CLI `--tag` flavour
 * @returns The canonical lowercase tag path
 * @throws InvalidArgumentError when `origin.kind` is `"cli"` and the tag is malformed
 * @throws ConfigValidationError when `origin.kind` is `"config"` and the tag is malformed
 *
 * @example
 * normalizeTag("  Media/Streaming/ ")            // "media/streaming"
 * normalizeTag("plex", { kind: "config", source: "/etc/rfapps.config.yaml" })
 */
export function normalizeTag(input: string, origin: TagInputOrigin = DEFAULT_ORIGIN): TagPath {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    rejectTag(input, "tag must not be empty", origin);
  }

  const lowercased = trimmed.toLowerCase();
  const stripped = stripOuterSlashes(lowercased);

  if (stripped.length === 0) {
    rejectTag(input, "tag must not be empty", origin);
  }

  const segments = stripped.split("/");

  for (const segment of segments) {
    if (segment.length === 0) {
      rejectTag(
        input,
        "tag contains an empty path segment (a doubled '/' has no canonical reading)",
        origin,
      );
    }
  }

  for (const segment of segments) {
    if (!isValidTagSegment(segment)) {
      rejectTag(input, invalidSegmentReason(segment), origin);
    }
  }

  if (segments.length > TAG_MAX_DEPTH) {
    rejectTag(
      input,
      `tag exceeds the maximum depth of ${TAG_MAX_DEPTH} segments (got ${segments.length})`,
      origin,
    );
  }

  for (const segment of segments) {
    if (segment.length > TAG_MAX_SEGMENT_LENGTH) {
      rejectTag(input, segmentTooLongReason(segment), origin);
    }
  }

  const canonical = segments.join("/");

  if (canonical.length > TAG_MAX_LENGTH) {
    rejectTag(
      input,
      `tag exceeds the maximum length of ${TAG_MAX_LENGTH} characters (got ${canonical.length})`,
      origin,
    );
  }

  return brandTagPath(canonical);
}

/**
 * Returns the tag itself plus every proper prefix, shallowest first (design §3.3).
 *
 * This is the ancestor-closure rule that makes hierarchy mean anything: a service
 * tagged `a/b/c` implicitly carries `a/b` and `a`, so `--tag a` selects it. The
 * closure collapses all prefix logic into set membership, which is why the matcher
 * needs no special cases.
 *
 * @param tag - An already-normalized tag path
 * @returns `["a", "a/b", "a/b/c"]` for `"a/b/c"`; `["a"]` for `"a"`
 *
 * @example
 * tagAncestors(normalizeTag("a/b/c")) // ["a", "a/b", "a/b/c"]
 */
export function tagAncestors(tag: TagPath): readonly TagPath[] {
  const segments = tag.split("/");
  const ancestors: TagPath[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    ancestors.push(brandTagPath(segments.slice(0, index + 1).join("/")));
  }

  return ancestors;
}

/**
 * Orders two tag paths hierarchically: segment by segment, parent before child.
 *
 * A plain string comparison is wrong here because `-` and `.` sort below `/`, which
 * would interleave `a-b` between `a` and `a/b` and break depth-first tree rendering.
 *
 * @param a - First tag path
 * @param b - Second tag path
 * @returns Negative when `a` sorts first, positive when `b` sorts first, 0 when equal
 */
export function compareTags(a: TagPath, b: TagPath): number {
  const left = a.split("/");
  const right = b.split("/");
  const shared = Math.min(left.length, right.length);

  for (let index = 0; index < shared; index += 1) {
    const leftSegment = left[index] ?? "";
    const rightSegment = right[index] ?? "";

    if (leftSegment < rightSegment) {
      return -1;
    }

    if (leftSegment > rightSegment) {
      return 1;
    }
  }

  return left.length - right.length;
}
