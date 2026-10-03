/**
 * Pure Lidarr search normalization, cache identity, ranking, and paging.
 *
 * This module owns no transport, cache, logging, or command concerns. Callers
 * validate and shape the complete projection here before performing any
 * query-keyed cache operation or rendering a local page.
 */

import { createHash } from "node:crypto";

import type {
  LidarrSearchCandidate,
  LidarrSearchCandidateInput,
  LidarrSearchMode,
} from "../../types/lidarr.js";
import { LidarrValidationError } from "./errors.js";

const SEARCH_OPERATION = "lidarr search lookup";
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const EXACT_ID_PREFIX_PATTERN = /^(?:lidarr|lidarrid|mbid):/iu;
const EXACT_ID_PATTERN =
  /^(?:lidarr|lidarrid|mbid):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const MAX_TERM_CODE_POINTS = 256;
const MAX_TERM_UTF8_BYTES = 1_024;
const MAX_CANDIDATES = 1_000;

/** Default local page size for Lidarr search results. */
export const LIDARR_SEARCH_DEFAULT_LIMIT = 50;
/** Maximum local page size accepted by Lidarr search. */
export const LIDARR_SEARCH_MAX_LIMIT = 200;

/** Optional local page controls for a complete ranked result set. */
export interface LidarrSearchPageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/** Validated local page controls safe to use before any client or cache I/O. */
export interface ResolvedLidarrSearchPageOptions {
  readonly limit: number;
  readonly offset: number;
}

/** Immutable local page projected from a complete ranked result set. */
export interface LidarrSearchPage {
  readonly results: readonly LidarrSearchCandidate[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly returned: number;
  readonly hasMore: boolean;
}

function validationError(message: string): LidarrValidationError {
  return new LidarrValidationError(SEARCH_OPERATION, message);
}

/**
 * Normalizes and validates one user-supplied Lidarr search term.
 *
 * Exact prefixed MusicBrainz identifiers are canonicalized to
 * `lidarr:<lowercase-uuid>`; ordinary text retains its normalized case and
 * internal whitespace.
 *
 * @param term - Raw positional search term.
 * @returns The outer-trimmed, NFC-normalized, optionally canonicalized term.
 * @throws {LidarrValidationError} When the term is empty, unsafe, oversized,
 *   or uses a recognized exact-id prefix with a malformed UUID.
 */
export function normalizeLidarrSearchTerm(term: string): string {
  if (typeof term !== "string") {
    throw validationError("Lidarr search term must be a string");
  }
  if (TERMINAL_CONTROL_PATTERN.test(term)) {
    throw validationError("Lidarr search term must not contain control characters");
  }

  const normalized = term.trim().normalize("NFC");
  const codePointLength = [...normalized].length;
  if (codePointLength < 1 || codePointLength > MAX_TERM_CODE_POINTS) {
    throw validationError(
      `Lidarr search term must contain 1-${MAX_TERM_CODE_POINTS} Unicode code points`,
    );
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_TERM_UTF8_BYTES) {
    throw validationError(`Lidarr search term must not exceed ${MAX_TERM_UTF8_BYTES} UTF-8 bytes`);
  }

  if (EXACT_ID_PREFIX_PATTERN.test(normalized)) {
    const match = EXACT_ID_PATTERN.exec(normalized);
    if (match === null) {
      throw validationError("Prefixed Lidarr search term must contain exactly one valid UUID");
    }
    const identifier = match[1];
    if (identifier === undefined) {
      throw validationError("Prefixed Lidarr search term must contain exactly one valid UUID");
    }
    return `lidarr:${identifier.toLowerCase()}`;
  }

  return normalized;
}

/**
 * Builds a versioned, privacy-preserving cache discriminator.
 *
 * The normalized term is represented only by its SHA-256 digest; paging is
 * intentionally absent so one complete ranked projection backs every page.
 *
 * @param mode - Selected combined or typed lookup mode.
 * @param term - Raw or already-normalized search term.
 * @returns `v1:<mode>:<sha256(normalized-term)>`.
 */
export function createLidarrSearchDiscriminator(mode: LidarrSearchMode, term: string): string {
  if (mode !== "search" && mode !== "artist" && mode !== "album") {
    throw validationError("Lidarr search mode must be search, artist, or album");
  }
  const normalizedTerm = normalizeLidarrSearchTerm(term);
  const digest = createHash("sha256").update(normalizedTerm, "utf8").digest("hex");
  return `v1:${mode}:${digest}`;
}

/**
 * Deduplicates and ranks a complete Lidarr search projection.
 *
 * The first `(kind, foreignId)` occurrence wins. Rank is assigned after
 * deduplication and before any local page is selected.
 *
 * @param candidates - Complete validated, unranked projection.
 * @returns A fresh frozen array of fresh frozen ranked candidates.
 * @throws {LidarrValidationError} When more than 1,000 records are supplied.
 */
export function rankLidarrSearchCandidates(
  candidates: readonly LidarrSearchCandidateInput[],
): readonly LidarrSearchCandidate[] {
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) {
    throw validationError(`Lidarr search results must contain at most ${MAX_CANDIDATES} records`);
  }

  const identities = new Set<string>();
  const ranked: LidarrSearchCandidate[] = [];
  for (const candidate of candidates) {
    const identity = `${candidate.kind}\u0000${candidate.foreignId}`;
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    ranked.push(Object.freeze({ ...candidate, rank: ranked.length + 1 }));
  }
  return Object.freeze(ranked);
}

/**
 * Resolves and validates local paging before any search-side I/O.
 *
 * @param options - Optional raw local page controls.
 * @returns Frozen effective limit and offset.
 * @throws {LidarrValidationError} For unsafe or out-of-range values.
 */
export function resolveLidarrSearchPageOptions(
  options: LidarrSearchPageOptions = {},
): ResolvedLidarrSearchPageOptions {
  const limit = options.limit ?? LIDARR_SEARCH_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIDARR_SEARCH_MAX_LIMIT) {
    throw validationError(
      `Lidarr search limit must be a safe integer from 1 to ${LIDARR_SEARCH_MAX_LIMIT}`,
    );
  }

  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw validationError("Lidarr search offset must be a non-negative safe integer");
  }
  return Object.freeze({ limit, offset });
}

/**
 * Selects an immutable local page from a complete ranked result set.
 *
 * @param candidates - Complete deduplicated result set with one-based ranks.
 * @param options - Optional safe local limit and offset.
 * @returns Frozen results and page metadata.
 * @throws {LidarrValidationError} For unsafe page options or oversized input.
 */
export function pageLidarrSearchCandidates(
  candidates: readonly LidarrSearchCandidate[],
  options: LidarrSearchPageOptions = {},
): LidarrSearchPage {
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) {
    throw validationError(`Lidarr search results must contain at most ${MAX_CANDIDATES} records`);
  }
  const { limit, offset } = resolveLidarrSearchPageOptions(options);
  const total = candidates.length;

  // Avoid unsafe offset + limit arithmetic when a valid but very large offset
  // is already known to be beyond this bounded local result set.
  const end = offset >= total ? total : Math.min(total, offset + limit);
  const results =
    offset >= total
      ? Object.freeze([] as LidarrSearchCandidate[])
      : Object.freeze(
          candidates.slice(offset, end).map((candidate) => Object.freeze({ ...candidate })),
        );

  return Object.freeze({
    results,
    total,
    limit,
    offset,
    returned: results.length,
    hasMore: end < total,
  });
}

/**
 * Applies first-win ranking and local paging in one pure operation.
 *
 * @param candidates - Complete validated, unranked projection.
 * @param options - Optional safe local limit and offset.
 * @returns Frozen local page with ranks assigned before slicing.
 */
export function shapeLidarrSearchCandidates(
  candidates: readonly LidarrSearchCandidateInput[],
  options: LidarrSearchPageOptions = {},
): LidarrSearchPage {
  return pageLidarrSearchCandidates(rankLidarrSearchCandidates(candidates), options);
}
