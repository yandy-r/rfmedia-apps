/**
 * Pure validation and projection for Plex-Lidarr identity cache boundaries.
 *
 * This module deliberately owns no database access. Cache persistence imports
 * these projectors so live values and decoded JSON cross the same strict
 * unknown-to-domain boundary.
 */

import {
  BRIDGE_ARTIST_MAX_CANDIDATES,
  BRIDGE_ARTIST_MAX_NORMALIZED_BYTES,
  BRIDGE_ARTIST_MAX_RECORDS,
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  BridgeIdentityCacheError,
  type BridgeArtistCandidate,
  type BridgeArtistIdentitySnapshot,
  type BridgeArtistResolutionOutcome,
  type BridgeIdentityCacheErrorCode,
  type BridgeIdentityCacheErrorOptions,
  type BridgeIdentityCompleteness,
  type BridgeIdentityCompatibleScopeSelector,
  type BridgeIdentityProvenance,
  type BridgeIdentityScope,
  type BridgeResolvedArtistTarget,
  type BridgeTargetArtist,
} from "../../types/bridge.js";
import {
  MEDIA_IDENTITY_MAX_ID_BYTES,
  MEDIA_IDENTITY_MAX_TITLE_BYTES,
} from "../../types/media-server.js";

const MAX_ORIGIN_BYTES = 2_048;
const MAX_TIMESTAMP_BYTES = 64;
const TERMINAL_UNSAFE_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const CANONICAL_MUSICBRAINZ_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type CacheOperation = BridgeIdentityCacheErrorOptions["operation"];
type UnknownRecord = Record<string, unknown>;

export function cacheError(
  operation: CacheOperation,
  code: BridgeIdentityCacheErrorCode,
  message: string,
  cause?: unknown,
): BridgeIdentityCacheError {
  return new BridgeIdentityCacheError(message, {
    code,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalid(operation: CacheOperation, message: string): never {
  throw cacheError(operation, "invalid-snapshot", message);
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function boundedString(
  value: unknown,
  maximumBytes: number,
  operation: CacheOperation,
  message: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    TERMINAL_UNSAFE_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return invalid(operation, message);
  }
  return value;
}

function boundedScopeString(
  value: unknown,
  maximumBytes: number,
  operation: CacheOperation,
  message: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    TERMINAL_UNSAFE_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw cacheError(operation, "invalid-scope", message);
  }
  return value;
}

function canonicalOrigin(value: unknown, operation: CacheOperation): string {
  const origin = boundedScopeString(
    value,
    MAX_ORIGIN_BYTES,
    operation,
    "Bridge identity scope contains an invalid origin.",
  );
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw cacheError(
      operation,
      "invalid-scope",
      "Bridge identity scope contains an invalid origin.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== origin
  ) {
    throw cacheError(
      operation,
      "invalid-scope",
      "Bridge identity scope contains a non-canonical origin.",
    );
  }
  return origin;
}

export function projectScope(value: unknown, operation: CacheOperation): BridgeIdentityScope {
  if (!isRecord(value)) {
    throw cacheError(operation, "invalid-scope", "Bridge identity scope is invalid.");
  }
  if (value["entityKind"] !== "artist") {
    throw cacheError(operation, "invalid-scope", "Bridge identity scope kind is invalid.");
  }
  return Object.freeze({
    plexOrigin: canonicalOrigin(value["plexOrigin"], operation),
    plexInstanceId: boundedScopeString(
      value["plexInstanceId"],
      MEDIA_IDENTITY_MAX_ID_BYTES,
      operation,
      "Bridge identity scope contains an invalid instance identifier.",
    ),
    plexLibraryId: boundedScopeString(
      value["plexLibraryId"],
      MEDIA_IDENTITY_MAX_ID_BYTES,
      operation,
      "Bridge identity scope contains an invalid library identifier.",
    ),
    lidarrOrigin: canonicalOrigin(value["lidarrOrigin"], operation),
    entityKind: "artist",
  });
}

export function projectCompatibleScopeSelector(
  value: unknown,
  operation: CacheOperation,
): BridgeIdentityCompatibleScopeSelector {
  if (!isRecord(value) || value["entityKind"] !== "artist") {
    throw cacheError(operation, "invalid-scope", "Bridge identity scope selector is invalid.");
  }
  const plexLibraryId =
    value["plexLibraryId"] === undefined
      ? undefined
      : boundedScopeString(
          value["plexLibraryId"],
          MEDIA_IDENTITY_MAX_ID_BYTES,
          operation,
          "Bridge identity scope selector contains an invalid library identifier.",
        );
  return Object.freeze({
    plexOrigin: canonicalOrigin(value["plexOrigin"], operation),
    lidarrOrigin: canonicalOrigin(value["lidarrOrigin"], operation),
    entityKind: "artist",
    ...(plexLibraryId === undefined ? {} : { plexLibraryId }),
  });
}

function safeInteger(
  value: unknown,
  operation: CacheOperation,
  message: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(operation, message);
  }
  return value;
}

export function canonicalTimestamp(value: unknown, operation: CacheOperation): string {
  const timestamp = boundedString(
    value,
    MAX_TIMESTAMP_BYTES,
    operation,
    "Bridge identity snapshot contains an invalid timestamp.",
  );
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    return invalid(operation, "Bridge identity snapshot contains a non-canonical timestamp.");
  }
  return timestamp;
}

function canonicalMbid(value: unknown, operation: CacheOperation): string {
  if (typeof value !== "string" || !CANONICAL_MUSICBRAINZ_ID_PATTERN.test(value)) {
    return invalid(operation, "Bridge identity snapshot contains an invalid artist identifier.");
  }
  return value;
}

function projectCandidate(
  value: unknown,
  expectedRank: number,
  operation: CacheOperation,
): BridgeArtistCandidate {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot contains an invalid candidate.");
  }
  if (value["method"] !== "normalized-name" && value["method"] !== "fuzzy-name") {
    return invalid(operation, "Bridge identity snapshot contains an invalid candidate method.");
  }
  const score = value["score"];
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    return invalid(operation, "Bridge identity snapshot contains an invalid candidate score.");
  }
  const artistMbid =
    value["artistMbid"] === null ? null : canonicalMbid(value["artistMbid"], operation);
  return Object.freeze({
    rank: safeInteger(
      value["rank"],
      operation,
      "Bridge identity snapshot contains an invalid candidate rank.",
      expectedRank,
      expectedRank,
    ),
    lidarrId: safeInteger(
      value["lidarrId"],
      operation,
      "Bridge identity snapshot contains an invalid Lidarr identifier.",
      1,
    ),
    artistMbid,
    title: boundedString(
      value["title"],
      MEDIA_IDENTITY_MAX_TITLE_BYTES,
      operation,
      "Bridge identity snapshot contains an invalid candidate title.",
    ),
    normalizedTitle: boundedString(
      value["normalizedTitle"],
      BRIDGE_ARTIST_MAX_NORMALIZED_BYTES,
      operation,
      "Bridge identity snapshot contains invalid ordering evidence.",
      true,
    ),
    method: value["method"],
    score,
  });
}

function projectCandidates(
  value: unknown,
  operation: CacheOperation,
): readonly BridgeArtistCandidate[] {
  if (!Array.isArray(value) || value.length > BRIDGE_ARTIST_MAX_CANDIDATES) {
    return invalid(operation, "Bridge identity snapshot contains an invalid candidate list.");
  }
  const candidates = value.map((candidate, index) =>
    projectCandidate(candidate, index + 1, operation),
  );
  if (new Set(candidates.map((candidate) => candidate.lidarrId)).size !== candidates.length) {
    return invalid(operation, "Bridge identity snapshot contains duplicate candidates.");
  }
  return Object.freeze(candidates);
}

function projectResolvedTarget(
  value: unknown,
  operation: CacheOperation,
): BridgeResolvedArtistTarget {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot contains an invalid resolved target.");
  }
  return Object.freeze({
    lidarrId: safeInteger(
      value["lidarrId"],
      operation,
      "Bridge identity snapshot contains an invalid Lidarr identifier.",
      1,
    ),
    artistMbid: canonicalMbid(value["artistMbid"], operation),
    title: boundedString(
      value["title"],
      MEDIA_IDENTITY_MAX_TITLE_BYTES,
      operation,
      "Bridge identity snapshot contains an invalid target title.",
    ),
  });
}

function projectTargetArtist(value: unknown, operation: CacheOperation): BridgeTargetArtist {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot contains an invalid target artist.");
  }
  return Object.freeze({
    lidarrId: safeInteger(
      value["lidarrId"],
      operation,
      "Bridge identity snapshot contains an invalid Lidarr identifier.",
      1,
    ),
    title: boundedString(
      value["title"],
      MEDIA_IDENTITY_MAX_TITLE_BYTES,
      operation,
      "Bridge identity snapshot contains an invalid target title.",
    ),
    artistMbid: value["artistMbid"] === null ? null : canonicalMbid(value["artistMbid"], operation),
  });
}

function projectTargetArtists(
  value: unknown,
  operation: CacheOperation,
): readonly BridgeTargetArtist[] {
  if (!Array.isArray(value) || value.length > BRIDGE_ARTIST_MAX_RECORDS) {
    return invalid(operation, "Bridge identity snapshot contains an invalid target catalog.");
  }
  const targetArtists = value.map((artist) => projectTargetArtist(artist, operation));
  for (let index = 1; index < targetArtists.length; index += 1) {
    if (targetArtists[index - 1]!.lidarrId >= targetArtists[index]!.lidarrId) {
      return invalid(
        operation,
        "Bridge identity snapshot target catalog is not uniquely and deterministically ordered.",
      );
    }
  }
  return Object.freeze(targetArtists);
}

function projectOutcome(value: unknown, operation: CacheOperation): BridgeArtistResolutionOutcome {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot contains an invalid outcome.");
  }
  const plexId = boundedString(
    value["plexId"],
    MEDIA_IDENTITY_MAX_ID_BYTES,
    operation,
    "Bridge identity snapshot contains an invalid Plex identifier.",
  );
  const title = boundedString(
    value["title"],
    MEDIA_IDENTITY_MAX_TITLE_BYTES,
    operation,
    "Bridge identity snapshot contains an invalid artist title.",
  );
  const candidates = projectCandidates(value["candidates"], operation);

  switch (value["state"]) {
    case "resolved": {
      if (value["reason"] !== "unique-exact-mbid" || value["method"] !== "exact-mbid") {
        return invalid(operation, "Bridge identity snapshot contains an invalid resolved outcome.");
      }
      const sourceMbid = canonicalMbid(value["sourceMbid"], operation);
      const target = projectResolvedTarget(value["target"], operation);
      if (sourceMbid !== target.artistMbid || candidates.length !== 0) {
        return invalid(
          operation,
          "Bridge identity snapshot contains conflicting resolved evidence.",
        );
      }
      return Object.freeze({
        plexId,
        title,
        candidates,
        state: "resolved",
        reason: "unique-exact-mbid",
        method: "exact-mbid",
        sourceMbid,
        target,
      });
    }
    case "suggested": {
      const reason = value["reason"];
      const method = value["method"];
      if (
        !(
          (reason === "unique-normalized-name" && method === "normalized-name") ||
          (reason === "unique-fuzzy-name" && method === "fuzzy-name")
        ) ||
        candidates.length === 0 ||
        candidates[0]?.method !== method
      ) {
        return invalid(
          operation,
          "Bridge identity snapshot contains an invalid suggested outcome.",
        );
      }
      const margin = value["runnerUpMargin"];
      if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > 1) {
        return invalid(
          operation,
          "Bridge identity snapshot contains an invalid suggestion margin.",
        );
      }
      const target = projectCandidate(value["target"], 1, operation);
      if (JSON.stringify(target) !== JSON.stringify(candidates[0])) {
        return invalid(
          operation,
          "Bridge identity snapshot contains a mismatched suggestion target.",
        );
      }
      return Object.freeze({
        plexId,
        title,
        candidates,
        state: "suggested",
        reason,
        method,
        target: candidates[0],
        runnerUpMargin: margin,
      });
    }
    case "ambiguous": {
      const reason = value["reason"];
      const method = value["method"];
      if (
        !(
          (reason === "normalized-name-collision" &&
            (method === "normalized-name" || method === "none")) ||
          (reason === "insufficient-margin" &&
            (method === "normalized-name" || method === "fuzzy-name"))
        )
      ) {
        return invalid(
          operation,
          "Bridge identity snapshot contains an invalid ambiguous outcome.",
        );
      }
      return Object.freeze({ plexId, title, candidates, state: "ambiguous", reason, method });
    }
    case "unmatched": {
      const reason = value["reason"];
      const method = value["method"];
      if (
        !(
          (reason === "insufficient-score" && method === "fuzzy-name") ||
          ((reason === "no-candidate" || reason === "missing-source-mbid") && method === "none")
        )
      ) {
        return invalid(
          operation,
          "Bridge identity snapshot contains an invalid unmatched outcome.",
        );
      }
      return Object.freeze({ plexId, title, candidates, state: "unmatched", reason, method });
    }
    case "conflict": {
      const reason = value["reason"];
      if (
        value["method"] !== "none" ||
        ![
          "malformed-source-mbid",
          "conflicting-source-mbids",
          "duplicate-source-mbid",
          "malformed-target-mbid",
          "duplicate-target-mbid",
          "contradictory-mbid",
        ].includes(String(reason))
      ) {
        return invalid(operation, "Bridge identity snapshot contains an invalid conflict outcome.");
      }
      if (reason === "duplicate-source-mbid") {
        return Object.freeze({
          plexId,
          title,
          candidates,
          state: "conflict",
          reason,
          method: "none",
          sourceMbid: canonicalMbid(value["sourceMbid"], operation),
        });
      }
      return Object.freeze({
        plexId,
        title,
        candidates,
        state: "conflict",
        reason: reason as Exclude<
          Extract<BridgeArtistResolutionOutcome, { state: "conflict" }>["reason"],
          "duplicate-source-mbid"
        >,
        method: "none",
      });
    }
    case "unavailable": {
      const reason = value["reason"];
      if (
        value["method"] !== "none" ||
        ![
          "missing-compatible-snapshot",
          "stale-snapshot",
          "incompatible-snapshot",
          "invalid-response",
        ].includes(String(reason))
      ) {
        return invalid(
          operation,
          "Bridge identity snapshot contains an invalid unavailable outcome.",
        );
      }
      return Object.freeze({
        plexId,
        title,
        candidates,
        state: "unavailable",
        reason: reason as Extract<
          BridgeArtistResolutionOutcome,
          { state: "unavailable" }
        >["reason"],
        method: "none",
      });
    }
    default:
      return invalid(operation, "Bridge identity snapshot contains an unknown outcome state.");
  }
}

function projectProvenance(value: unknown, operation: CacheOperation): BridgeIdentityProvenance {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot contains invalid provenance.");
  }
  const source = value["source"];
  const mode = value["mode"];
  const freshness = value["freshness"];
  if (
    (source !== "live" && source !== "sqlite-cache") ||
    (mode !== "online" && mode !== "offline") ||
    (freshness !== "fresh" && freshness !== "stale") ||
    (source === "live" && (mode !== "online" || freshness !== "fresh")) ||
    (source === "sqlite-cache" && mode !== "offline")
  ) {
    return invalid(operation, "Bridge identity snapshot contains inconsistent provenance.");
  }
  const ageSeconds =
    value["ageSeconds"] === undefined
      ? undefined
      : safeInteger(
          value["ageSeconds"],
          operation,
          "Bridge identity snapshot contains an invalid evidence age.",
        );
  return Object.freeze({
    source,
    mode,
    freshness,
    ...(ageSeconds === undefined ? {} : { ageSeconds }),
  });
}

function projectCompleteness(
  value: unknown,
  outcomeCount: number,
  operation: CacheOperation,
): BridgeIdentityCompleteness {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot contains invalid completeness evidence.");
  }
  const sourceComplete = value["sourceComplete"];
  const targetComplete = value["targetComplete"];
  const resolutionsComplete = value["resolutionsComplete"];
  const complete = value["complete"];
  if (
    typeof sourceComplete !== "boolean" ||
    typeof targetComplete !== "boolean" ||
    typeof resolutionsComplete !== "boolean" ||
    typeof complete !== "boolean" ||
    complete !== (sourceComplete && targetComplete && resolutionsComplete) ||
    !complete
  ) {
    return invalid(operation, "Bridge identity cache accepts complete snapshots only.");
  }
  const sourceArtistCount = safeInteger(
    value["sourceArtistCount"],
    operation,
    "Bridge identity snapshot contains an invalid source count.",
    0,
    BRIDGE_ARTIST_MAX_RECORDS,
  );
  const targetArtistCount = safeInteger(
    value["targetArtistCount"],
    operation,
    "Bridge identity snapshot contains an invalid target count.",
    0,
    BRIDGE_ARTIST_MAX_RECORDS,
  );
  const resolutionCount = safeInteger(
    value["resolutionCount"],
    operation,
    "Bridge identity snapshot contains an invalid resolution count.",
    0,
    BRIDGE_ARTIST_MAX_RECORDS,
  );
  if (sourceArtistCount !== outcomeCount || resolutionCount !== outcomeCount) {
    return invalid(operation, "Bridge identity snapshot counts do not match its outcomes.");
  }
  return Object.freeze({
    sourceComplete,
    targetComplete,
    resolutionsComplete,
    complete,
    sourceArtistCount,
    targetArtistCount,
    resolutionCount,
  });
}

export function projectSnapshot(
  value: unknown,
  operation: CacheOperation,
): BridgeArtistIdentitySnapshot {
  if (!isRecord(value)) {
    return invalid(operation, "Bridge identity snapshot must be a plain object.");
  }
  if (
    value["snapshotVersion"] !== BRIDGE_IDENTITY_SNAPSHOT_VERSION ||
    value["resolverVersion"] !== BRIDGE_ARTIST_RESOLVER_VERSION ||
    value["normalizationVersion"] !== BRIDGE_ARTIST_NORMALIZATION_VERSION ||
    value["scoringVersion"] !== BRIDGE_ARTIST_SCORING_VERSION
  ) {
    throw cacheError(
      operation,
      "incompatible-version",
      "Bridge identity snapshot version is incompatible.",
    );
  }
  if (!Array.isArray(value["outcomes"]) || value["outcomes"].length > BRIDGE_ARTIST_MAX_RECORDS) {
    return invalid(operation, "Bridge identity snapshot contains an invalid outcome list.");
  }
  const outcomes = value["outcomes"].map((outcome) => projectOutcome(outcome, operation));
  if (new Set(outcomes.map((outcome) => outcome.plexId)).size !== outcomes.length) {
    return invalid(operation, "Bridge identity snapshot contains duplicate Plex artists.");
  }
  const targetArtists = projectTargetArtists(value["targetArtists"], operation);
  const targetArtistsById = new Map(targetArtists.map((artist) => [artist.lidarrId, artist]));
  for (const outcome of outcomes) {
    const references =
      outcome.state === "resolved" || outcome.state === "suggested"
        ? [...outcome.candidates, outcome.target]
        : outcome.candidates;
    for (const reference of references) {
      const catalogArtist = targetArtistsById.get(reference.lidarrId);
      if (
        catalogArtist === undefined ||
        catalogArtist.title !== reference.title ||
        catalogArtist.artistMbid !== reference.artistMbid
      ) {
        return invalid(
          operation,
          "Bridge identity snapshot outcome references inconsistent target evidence.",
        );
      }
    }
  }
  const capturedAt = canonicalTimestamp(value["capturedAt"], operation);
  const verifiedAt = canonicalTimestamp(value["verifiedAt"], operation);
  if (Date.parse(verifiedAt) > Date.parse(capturedAt)) {
    return invalid(operation, "Bridge identity snapshot verification time is inconsistent.");
  }
  const completeness = projectCompleteness(value["completeness"], outcomes.length, operation);
  if (completeness.targetArtistCount !== targetArtists.length) {
    return invalid(operation, "Bridge identity snapshot target count does not match its catalog.");
  }
  return Object.freeze({
    snapshotVersion: BRIDGE_IDENTITY_SNAPSHOT_VERSION,
    resolverVersion: BRIDGE_ARTIST_RESOLVER_VERSION,
    normalizationVersion: BRIDGE_ARTIST_NORMALIZATION_VERSION,
    scoringVersion: BRIDGE_ARTIST_SCORING_VERSION,
    scope: projectScope(value["scope"], operation),
    capturedAt,
    verifiedAt,
    provenance: projectProvenance(value["provenance"], operation),
    completeness,
    outcomes: Object.freeze(outcomes),
    targetArtists,
  });
}

export function sameScope(left: BridgeIdentityScope, right: BridgeIdentityScope): boolean {
  return (
    left.plexOrigin === right.plexOrigin &&
    left.plexInstanceId === right.plexInstanceId &&
    left.plexLibraryId === right.plexLibraryId &&
    left.lidarrOrigin === right.lidarrOrigin &&
    left.entityKind === right.entityKind
  );
}
