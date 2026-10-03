/**
 * Pure deterministic artist identity resolution and expansion evidence.
 *
 * This module deliberately owns its name normalization and scoring policy. It
 * does not call the generic fuzzy helpers because those helpers log raw names
 * and select the first winner without an ambiguity margin.
 */

import { distance as levenshteinDistance } from "fastest-levenshtein";

import {
  BRIDGE_ARTIST_MAX_CANDIDATES,
  BRIDGE_ARTIST_MAX_COMPARISONS,
  BRIDGE_ARTIST_MAX_NORMALIZED_BYTES,
  BRIDGE_ARTIST_MAX_RECORDS,
  BRIDGE_ARTIST_MIN_FUZZY_NAME_LENGTH,
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_RUNNER_UP_MARGIN,
  BRIDGE_ARTIST_SCORE_FLOOR,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  type BridgeArtistCandidate,
  type BridgeArtistIdentitySnapshot,
  type BridgeArtistResolutionInput,
  type BridgeArtistResolutionOutcome,
  type BridgeArtistResolutionReason,
  type BridgeExpansionImpact,
  type BridgeExpansionInput,
  type BridgeTargetArtist,
} from "../../types/bridge.js";
import { MEDIA_IDENTITY_MAX_TITLE_BYTES } from "../../types/media-server.js";
import { normalizeBridgeArtistName } from "./artist-name.js";

const ARTIST_MBID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEADING_ARTICLE_PATTERN = /^(?:the|a|an)\s+/u;
const TERMINAL_UNSAFE_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

interface PreparedSource {
  readonly id: string;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly articleVariant: string;
  readonly mbid:
    | { readonly state: "absent" }
    | { readonly state: "valid"; readonly value: string }
    | {
        readonly state: "conflict";
        readonly reason: "malformed-source-mbid" | "conflicting-source-mbids";
      }
    | {
        readonly state: "conflict";
        readonly reason: "duplicate-source-mbid";
        readonly value: string;
      };
}

interface PreparedTarget {
  readonly id: number;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly articleVariant: string;
  readonly artistMbid: string | null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function articleVariant(value: string): string {
  return value.replace(LEADING_ARTICLE_PATTERN, "");
}

function canonicalizeArtistMbid(value: string): string | null {
  return ARTIST_MBID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function requireTargetId(value: unknown, index: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`targetArtists[${index}].id must be a positive safe integer`);
  }
  return value;
}

function requireTargetTitle(value: unknown, index: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    TERMINAL_UNSAFE_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > MEDIA_IDENTITY_MAX_TITLE_BYTES
  ) {
    throw new TypeError(`targetArtists[${index}].artistName must be a bounded terminal-safe title`);
  }
  return value;
}

function prepareSources(input: BridgeArtistResolutionInput): readonly PreparedSource[] {
  const prepared = input.sourceArtists.map((artist): PreparedSource => {
    const normalizedTitle = normalizeBridgeArtistName(artist.title);
    const values = artist.externalIds.map((identity) => identity.value);
    if (values.length === 0) {
      return {
        id: artist.id,
        title: artist.title,
        normalizedTitle,
        articleVariant: articleVariant(normalizedTitle),
        mbid: { state: "absent" },
      };
    }

    const canonical = values.map(canonicalizeArtistMbid);
    if (canonical.some((value) => value === null)) {
      return {
        id: artist.id,
        title: artist.title,
        normalizedTitle,
        articleVariant: articleVariant(normalizedTitle),
        mbid: { state: "conflict", reason: "malformed-source-mbid" },
      };
    }

    const distinct = new Set(canonical);
    const mbid =
      distinct.size > 1
        ? ({ state: "conflict", reason: "conflicting-source-mbids" } as const)
        : values.length > 1
          ? ({
              state: "conflict",
              reason: "duplicate-source-mbid",
              value: canonical[0] as string,
            } as const)
          : ({ state: "valid", value: canonical[0] as string } as const);

    return {
      id: artist.id,
      title: artist.title,
      normalizedTitle,
      articleVariant: articleVariant(normalizedTitle),
      mbid,
    };
  });

  const sourceMbidCounts = new Map<string, number>();
  for (const source of prepared) {
    if (
      source.mbid.state === "valid" ||
      (source.mbid.state === "conflict" && source.mbid.reason === "duplicate-source-mbid")
    ) {
      sourceMbidCounts.set(source.mbid.value, (sourceMbidCounts.get(source.mbid.value) ?? 0) + 1);
    }
  }

  return prepared
    .map((source): PreparedSource => {
      if (source.mbid.state === "valid" && (sourceMbidCounts.get(source.mbid.value) ?? 0) > 1) {
        return {
          ...source,
          mbid: { state: "conflict", reason: "duplicate-source-mbid", value: source.mbid.value },
        };
      }
      return source;
    })
    .sort(
      (left, right) =>
        compareStrings(left.id, right.id) ||
        compareStrings(left.normalizedTitle, right.normalizedTitle) ||
        compareStrings(left.title, right.title),
    );
}

function prepareTargets(input: BridgeArtistResolutionInput): {
  readonly targets: readonly PreparedTarget[];
  readonly malformed: boolean;
  readonly duplicateMbids: ReadonlySet<string>;
  readonly byMbid: ReadonlyMap<string, readonly PreparedTarget[]>;
} {
  let malformed = false;
  const targetIds = new Set<number>();
  const byMbid = new Map<string, PreparedTarget[]>();
  const targets = input.targetArtists
    .map((artist, index): PreparedTarget => {
      const id = requireTargetId(artist.id, index);
      if (targetIds.has(id)) {
        throw new RangeError("target artist IDs must be unique");
      }
      targetIds.add(id);

      const title = requireTargetTitle(artist.artistName, index);
      const normalizedTitle = normalizeBridgeArtistName(title);
      const rawMbid = artist.foreignArtistId.trim();
      const artistMbid = rawMbid === "" ? null : canonicalizeArtistMbid(rawMbid);
      if (rawMbid !== "" && artistMbid === null) {
        malformed = true;
      }

      const target = {
        id,
        title,
        normalizedTitle,
        articleVariant: articleVariant(normalizedTitle),
        artistMbid,
      };
      if (artistMbid !== null) {
        const bucket = byMbid.get(artistMbid);
        if (bucket === undefined) {
          byMbid.set(artistMbid, [target]);
        } else {
          bucket.push(target);
        }
      }
      return target;
    })
    .sort(
      (left, right) =>
        left.id - right.id ||
        compareStrings(left.normalizedTitle, right.normalizedTitle) ||
        compareStrings(left.title, right.title),
    );

  const duplicateMbids = new Set<string>();
  for (const [mbid, bucket] of byMbid) {
    if (bucket.length > 1) {
      duplicateMbids.add(mbid);
    }
  }

  return { targets, malformed, duplicateMbids, byMbid };
}

function projectTargetArtists(targets: readonly PreparedTarget[]): readonly BridgeTargetArtist[] {
  return Object.freeze(
    targets.map((target) =>
      Object.freeze({
        lidarrId: target.id,
        title: target.title,
        artistMbid: target.artistMbid,
      }),
    ),
  );
}

function assertResolutionBounds(
  input: BridgeArtistResolutionInput,
  sources: readonly PreparedSource[],
  targetData: ReturnType<typeof prepareTargets>,
): void {
  if (
    input.sourceArtists.length > BRIDGE_ARTIST_MAX_RECORDS ||
    input.targetArtists.length > BRIDGE_ARTIST_MAX_RECORDS
  ) {
    throw new RangeError(`artist resolution accepts at most ${BRIDGE_ARTIST_MAX_RECORDS} records`);
  }

  const normalizedBytes = [...sources, ...targetData.targets].reduce(
    (total, artist) => total + Buffer.byteLength(artist.normalizedTitle, "utf8"),
    0,
  );
  if (
    !Number.isSafeInteger(normalizedBytes) ||
    normalizedBytes > BRIDGE_ARTIST_MAX_NORMALIZED_BYTES
  ) {
    throw new RangeError("artist resolution normalized-name budget exceeded");
  }

  const comparableSources = sources.filter(
    (source) =>
      (source.mbid.state === "absent" && source.normalizedTitle !== "") ||
      (source.mbid.state === "valid" && !targetData.byMbid.has(source.mbid.value)),
  ).length;
  const comparisons = comparableSources * targetData.targets.length;
  if (!Number.isSafeInteger(comparisons) || comparisons > BRIDGE_ARTIST_MAX_COMPARISONS) {
    throw new RangeError("artist resolution comparison budget exceeded");
  }
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left === "" || right === "") return 0;
  const maximumLength = Math.max(left.length, right.length);
  return 1 - levenshteinDistance(left, right) / maximumLength;
}

function scoreTarget(source: PreparedSource, target: PreparedTarget): number {
  return Math.max(
    similarity(source.normalizedTitle, target.normalizedTitle),
    similarity(source.normalizedTitle, target.articleVariant),
    similarity(source.articleVariant, target.normalizedTitle),
    similarity(source.articleVariant, target.articleVariant),
  );
}

function meetsBoundary(value: number, boundary: number): boolean {
  return value > boundary || Math.abs(value - boundary) <= Number.EPSILON;
}

function rankCandidates(
  source: PreparedSource,
  targets: readonly PreparedTarget[],
): readonly BridgeArtistCandidate[] {
  const ranked = targets
    .map((target) => {
      const score = scoreTarget(source, target);
      return {
        id: target.id,
        title: target.title,
        normalizedTitle: target.normalizedTitle,
        artistMbid: target.artistMbid,
        method: score === 1 ? ("normalized-name" as const) : ("fuzzy-name" as const),
        score,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareStrings(left.normalizedTitle, right.normalizedTitle) ||
        left.id - right.id ||
        compareStrings(left.title, right.title),
    );

  return Object.freeze(
    ranked.slice(0, BRIDGE_ARTIST_MAX_CANDIDATES).map((candidate, index) =>
      Object.freeze({
        rank: index + 1,
        lidarrId: candidate.id,
        artistMbid: candidate.artistMbid,
        title: candidate.title,
        normalizedTitle: candidate.normalizedTitle,
        method: candidate.method,
        score: candidate.score,
      }),
    ),
  );
}

function conflictOutcome(
  source: PreparedSource,
  reason: Extract<
    BridgeArtistResolutionReason,
    | "malformed-source-mbid"
    | "conflicting-source-mbids"
    | "malformed-target-mbid"
    | "duplicate-target-mbid"
    | "contradictory-mbid"
  >,
): BridgeArtistResolutionOutcome {
  return Object.freeze({
    state: "conflict",
    plexId: source.id,
    title: source.title,
    reason,
    method: "none",
    candidates: Object.freeze([]),
  });
}

function duplicateSourceMbidConflictOutcome(
  source: PreparedSource,
  sourceMbid: string,
): BridgeArtistResolutionOutcome {
  return Object.freeze({
    state: "conflict",
    plexId: source.id,
    title: source.title,
    reason: "duplicate-source-mbid",
    method: "none",
    sourceMbid,
    candidates: Object.freeze([]),
  });
}

function resolveByName(
  source: PreparedSource,
  targets: readonly PreparedTarget[],
): BridgeArtistResolutionOutcome {
  if (source.normalizedTitle === "") {
    return Object.freeze({
      state: "unmatched",
      plexId: source.id,
      title: source.title,
      reason: "missing-source-mbid",
      method: "none",
      candidates: Object.freeze([]),
    });
  }

  const candidates = rankCandidates(source, targets);
  const winner = candidates[0];
  if (winner === undefined) {
    return Object.freeze({
      state: "unmatched",
      plexId: source.id,
      title: source.title,
      reason: "no-candidate",
      method: "none",
      candidates,
    });
  }

  const runnerUpMargin = winner.score - (candidates[1]?.score ?? 0);
  const shortName = Array.from(source.normalizedTitle).length < BRIDGE_ARTIST_MIN_FUZZY_NAME_LENGTH;
  if (
    (shortName && winner.score !== 1) ||
    !meetsBoundary(winner.score, BRIDGE_ARTIST_SCORE_FLOOR)
  ) {
    return Object.freeze({
      state: "unmatched",
      plexId: source.id,
      title: source.title,
      reason: "insufficient-score",
      method: "fuzzy-name",
      candidates,
    });
  }

  if (winner.score === 1 && candidates[1]?.score === 1) {
    return Object.freeze({
      state: "ambiguous",
      plexId: source.id,
      title: source.title,
      reason: "normalized-name-collision",
      method: "normalized-name",
      candidates,
    });
  }

  if (!meetsBoundary(runnerUpMargin, BRIDGE_ARTIST_RUNNER_UP_MARGIN)) {
    return Object.freeze({
      state: "ambiguous",
      plexId: source.id,
      title: source.title,
      reason: "insufficient-margin",
      method: winner.method,
      candidates,
    });
  }

  return Object.freeze({
    state: "suggested",
    plexId: source.id,
    title: source.title,
    reason: winner.method === "normalized-name" ? "unique-normalized-name" : "unique-fuzzy-name",
    method: winner.method,
    candidates,
    target: winner,
    runnerUpMargin,
  });
}

function resolveOne(
  source: PreparedSource,
  targetData: ReturnType<typeof prepareTargets>,
): BridgeArtistResolutionOutcome {
  if (source.mbid.state === "conflict") {
    return source.mbid.reason === "duplicate-source-mbid"
      ? duplicateSourceMbidConflictOutcome(source, source.mbid.value)
      : conflictOutcome(source, source.mbid.reason);
  }
  if (targetData.malformed) {
    return conflictOutcome(source, "malformed-target-mbid");
  }
  if (targetData.duplicateMbids.size > 0) {
    return conflictOutcome(source, "duplicate-target-mbid");
  }
  if (source.mbid.state === "absent") {
    return resolveByName(source, targetData.targets);
  }

  const sourceMbid = source.mbid.value;
  const exactTargets = targetData.byMbid.get(sourceMbid) ?? [];
  const exactTarget = exactTargets[0];
  if (exactTarget !== undefined) {
    return Object.freeze({
      state: "resolved",
      plexId: source.id,
      title: source.title,
      reason: "unique-exact-mbid",
      method: "exact-mbid",
      sourceMbid,
      candidates: Object.freeze([]),
      target: Object.freeze({
        lidarrId: exactTarget.id,
        artistMbid: sourceMbid,
        title: exactTarget.title,
      }),
    });
  }

  const contradictory = targetData.targets.some(
    (target) =>
      target.artistMbid !== null &&
      target.artistMbid !== sourceMbid &&
      scoreTarget(source, target) === 1,
  );
  return contradictory
    ? conflictOutcome(source, "contradictory-mbid")
    : Object.freeze({
        state: "unmatched",
        plexId: source.id,
        title: source.title,
        reason: "no-candidate",
        method: "none",
        candidates: Object.freeze([]),
      });
}

/**
 * Resolves a complete projected artist catalog with exact MBID evidence first.
 *
 * Name-derived matches are advisory suggestions only. Invalid or non-unique
 * authoritative evidence fails closed and never reaches name scoring.
 */
export function resolveArtistIdentities(
  input: BridgeArtistResolutionInput,
): BridgeArtistIdentitySnapshot {
  if (input.sourceComplete !== true) {
    throw new TypeError("artist resolution requires a complete source artist enumeration");
  }
  if (input.targetComplete !== true) {
    throw new TypeError("artist resolution requires a complete target artist enumeration");
  }

  if (
    input.sourceArtists.length > BRIDGE_ARTIST_MAX_RECORDS ||
    input.targetArtists.length > BRIDGE_ARTIST_MAX_RECORDS
  ) {
    throw new RangeError(`artist resolution accepts at most ${BRIDGE_ARTIST_MAX_RECORDS} records`);
  }

  const sources = prepareSources(input);
  const targetData = prepareTargets(input);
  assertResolutionBounds(input, sources, targetData);
  const outcomes = Object.freeze(sources.map((source) => resolveOne(source, targetData)));
  const targetArtists = projectTargetArtists(targetData.targets);
  if (targetArtists.length !== input.targetArtists.length) {
    throw new Error("artist resolution target catalog count mismatch");
  }

  const snapshot = Object.freeze({
    snapshotVersion: BRIDGE_IDENTITY_SNAPSHOT_VERSION,
    resolverVersion: BRIDGE_ARTIST_RESOLVER_VERSION,
    normalizationVersion: BRIDGE_ARTIST_NORMALIZATION_VERSION,
    scoringVersion: BRIDGE_ARTIST_SCORING_VERSION,
    scope: Object.freeze({ ...input.scope }),
    capturedAt: input.capturedAt,
    verifiedAt: input.verifiedAt,
    provenance: Object.freeze({
      source: "live",
      mode: "online",
      freshness: "fresh",
    }),
    completeness: Object.freeze({
      sourceComplete: input.sourceComplete,
      targetComplete: input.targetComplete,
      resolutionsComplete: outcomes.length === input.sourceArtists.length,
      complete:
        input.sourceComplete &&
        input.targetComplete &&
        outcomes.length === input.sourceArtists.length,
      sourceArtistCount: input.sourceArtists.length,
      targetArtistCount: input.targetArtists.length,
      resolutionCount: outcomes.length,
    }),
    outcomes,
    targetArtists,
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES) {
    throw new RangeError("artist resolution snapshot payload budget exceeded");
  }
  return snapshot;
}

function requireOpaqueId(value: string, path: string): string {
  if (value.length === 0) {
    throw new TypeError(`${path} must be a non-empty identifier`);
  }
  return value;
}

function requireTrackCount(value: number | null, path: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${path} must be a non-negative safe integer or null`);
  }
  return value;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    !Number.isSafeInteger(result)
  ) {
    throw new RangeError("bridge expansion arithmetic overflow");
  }
  return result;
}

/**
 * Calculates immutable track-to-album expansion evidence without provider I/O.
 */
export function calculateBridgeExpansionImpact(input: BridgeExpansionInput): BridgeExpansionImpact {
  const sourceTrackIds = new Set(
    input.sourceTrackIds.map((id, index) => requireOpaqueId(id, `sourceTrackIds[${index}]`)),
  );
  const albums = new Map<string, number | null>();

  input.targetAlbums.forEach((album, index) => {
    const id = requireOpaqueId(album.id, `targetAlbums[${index}].id`);
    const trackCount = requireTrackCount(album.trackCount, `targetAlbums[${index}].trackCount`);
    if (!albums.has(id)) {
      albums.set(id, trackCount);
      return;
    }

    const existing = albums.get(id) as number | null;
    if (existing === trackCount || existing === null) {
      return;
    }
    if (trackCount === null) {
      albums.set(id, null);
      return;
    }
    throw new RangeError("duplicate target album has conflicting track counts");
  });

  let knownTargetTrackCount = 0;
  let unknownTargetAlbumCount = 0;
  for (const trackCount of albums.values()) {
    if (trackCount === null) {
      unknownTargetAlbumCount = checkedAdd(unknownTargetAlbumCount, 1);
    } else {
      knownTargetTrackCount = checkedAdd(knownTargetTrackCount, trackCount);
    }
  }

  const sourceTrackCount = sourceTrackIds.size;
  const targetAlbumCount = albums.size;
  const complete =
    unknownTargetAlbumCount === 0 && (sourceTrackCount > 0 || targetAlbumCount === 0);
  const trackExpansionRatio =
    complete && sourceTrackCount > 0 ? knownTargetTrackCount / sourceTrackCount : null;
  if (trackExpansionRatio !== null && !Number.isFinite(trackExpansionRatio)) {
    throw new RangeError("bridge expansion ratio must be finite");
  }

  return Object.freeze({
    sourceTrackCount,
    targetAlbumCount,
    knownTargetTrackCount,
    unknownTargetAlbumCount,
    trackExpansionRatio,
    complete,
    requiresConfirmation: targetAlbumCount > 0,
  });
}
