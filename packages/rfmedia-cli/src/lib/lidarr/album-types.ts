/**
 * Pure Lidarr album-type selector vocabulary for the album-monitoring lane.
 *
 * A CLOSED allowlist keeps bulk selection deliberate: unknown or novel type
 * names from newer Lidarr servers can never over-match — they simply match
 * nothing, and the plan's scanned-vs-matched summary exposes vocabulary drift.
 * This module is deliberately free of client imports so selector parsing and
 * matching stay trivially unit-testable.
 */

import { InvalidArgumentError } from "commander";

import type { LidarrAlbum } from "../../types/lidarr.js";

/** Canonical (plural) album-type selector tokens, the closed vocabulary. */
export const LIDARR_ALBUM_TYPE_SELECTORS = [
  "albums",
  "eps",
  "singles",
  "broadcasts",
  "others",
  "compilations",
  "live",
  "remixes",
  "soundtracks",
  "demos",
  "mixtapes",
] as const;

/** One canonical album-type selector token. */
export type LidarrAlbumTypeSelector = (typeof LIDARR_ALBUM_TYPE_SELECTORS)[number];

const CANONICAL_SELECTORS: ReadonlySet<string> = new Set(LIDARR_ALBUM_TYPE_SELECTORS);

/** Accepted singular spellings mapped to their canonical plural token. */
const SINGULAR_ALIASES: Readonly<Record<string, LidarrAlbumTypeSelector>> = Object.freeze({
  album: "albums",
  ep: "eps",
  single: "singles",
  broadcast: "broadcasts",
  other: "others",
  compilation: "compilations",
  remix: "remixes",
  soundtrack: "soundtracks",
  demo: "demos",
  mixtape: "mixtapes",
});

/** Selectors matched against the primary `albumType` name (lowercased). */
const PRIMARY_TYPE_BY_SELECTOR: ReadonlyMap<LidarrAlbumTypeSelector, string> = new Map([
  ["albums", "album"],
  ["eps", "ep"],
  ["singles", "single"],
  ["broadcasts", "broadcast"],
  ["others", "other"],
]);

/** Selectors matched against `secondaryTypes` membership (lowercased). */
const SECONDARY_TYPE_BY_SELECTOR: ReadonlyMap<LidarrAlbumTypeSelector, string> = new Map([
  ["compilations", "compilation"],
  ["live", "live"],
  ["remixes", "remix"],
  ["soundtracks", "soundtrack"],
  ["demos", "demo"],
  ["mixtapes", "mixtape"],
]);

function allowlistHint(): string {
  return `Album type selectors must be one of: ${LIDARR_ALBUM_TYPE_SELECTORS.join(", ")}`;
}

function canonicalizeToken(token: string): LidarrAlbumTypeSelector {
  if (CANONICAL_SELECTORS.has(token)) {
    return token as LidarrAlbumTypeSelector;
  }
  const alias = SINGULAR_ALIASES[token];
  if (alias !== undefined) {
    return alias;
  }
  throw new InvalidArgumentError(`Unknown album type selector '${token}'. ${allowlistHint()}`);
}

/**
 * Parses a comma-separated `--types` value into canonical selector tokens.
 *
 * Tokens are trimmed and lowercased; singular aliases resolve to their plural
 * canonical form. The result is deduped by rejection (duplicates — including
 * an alias colliding with its plural — are errors, never silently merged) and
 * returned canonically sorted for deterministic plan checksums.
 *
 * @param raw - Raw comma-separated CLI value.
 * @returns A frozen, sorted array of canonical selectors.
 * @throws {InvalidArgumentError} On an empty value, an unknown token, or a
 *   duplicate selector after alias resolution.
 */
export function parseAlbumTypeSelectors(raw: string): readonly LidarrAlbumTypeSelector[] {
  const tokens = raw.split(",").map((token) => token.trim().toLowerCase());
  if (tokens.some((token) => token.length === 0)) {
    throw new InvalidArgumentError(`Album type selectors must not be empty. ${allowlistHint()}`);
  }

  const selectors: LidarrAlbumTypeSelector[] = [];
  for (const token of tokens) {
    const selector = canonicalizeToken(token);
    if (selectors.includes(selector)) {
      throw new InvalidArgumentError(
        `Duplicate album type selector '${selector}'. Each selector may appear once`,
      );
    }
    selectors.push(selector);
  }
  return Object.freeze(selectors.sort());
}

/**
 * True when the album matches AT LEAST ONE selector (OR semantics).
 *
 * Primary selectors compare the album's `albumType` name case-insensitively;
 * secondary selectors test `secondaryTypes` membership case-insensitively. An
 * absent `albumType` and an empty `secondaryTypes` list match nothing.
 *
 * @param album - Projected album fields relevant to type matching.
 * @param selectors - Canonical selectors from {@link parseAlbumTypeSelectors}.
 * @returns True when any selector matches the album.
 */
export function matchesAlbumTypeSelectors(
  album: Pick<LidarrAlbum, "albumType" | "secondaryTypes">,
  selectors: readonly LidarrAlbumTypeSelector[],
): boolean {
  const primaryType = album.albumType?.toLowerCase();
  return selectors.some((selector) => {
    const primaryName = PRIMARY_TYPE_BY_SELECTOR.get(selector);
    if (primaryName !== undefined) {
      return primaryType === primaryName;
    }
    const secondaryName = SECONDARY_TYPE_BY_SELECTOR.get(selector);
    return (
      secondaryName !== undefined &&
      album.secondaryTypes.some((type) => type.toLowerCase() === secondaryName)
    );
  });
}
