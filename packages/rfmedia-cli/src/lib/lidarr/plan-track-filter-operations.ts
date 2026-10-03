/** Strict plan contract for the non-deferable `track-file-filter` operation. */

import { createHash } from "node:crypto";

import { LidarrPlanValidationError } from "../errors.js";
import {
  LIDARR_PLAN_MAX_BATCH,
  LIDARR_PLAN_MAX_ENTRIES,
  LIDARR_PLAN_VERSION_V2,
  type LidarrCascadePolicy,
  type LidarrPlanRiskSummary,
  type LidarrTrackFileDeleteCandidateV2,
  type LidarrTrackFileFilterOperationV2,
  type LidarrTrackFileFilterPlanEntryV2,
  type LidarrTrackFileFilterPlanEntryV3,
  type LidarrTrackFileFilterPlanV2,
  type LidarrTrackFileFilterPlanV3,
  type LidarrTrackFilterPlanSelectionV2,
  type LidarrTrackFilterPlanSummaryV2,
  type LidarrTrackFilterWarningV2,
} from "../../types/lidarr-plan.js";
import {
  canonicalizeLidarrPlanOrigin,
  computeLidarrPlanChecksum,
  createLidarrPlanEnvelope,
  sealLidarrMutationPlanV3,
  type LidarrPlanBuildDependencies,
} from "./plan-engine.js";

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

type UnknownRecord = Record<string, unknown>;

function validationError(message: string): LidarrPlanValidationError {
  return new LidarrPlanValidationError(message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) throw validationError(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw validationError(`${path}.${key} is not supported`);
  }
}

function positiveInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw validationError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw validationError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function safeString(value: unknown, path: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim() === "") ||
    value.length > 4_096 ||
    CONTROL_PATTERN.test(value)
  ) {
    throw validationError(`${path} must be bounded terminal-safe text`);
  }
  return value;
}

function sortedUniqueIds(value: unknown, path: string, allowEmpty = false): readonly number[] {
  if (!Array.isArray(value) || value.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`${path} must be a bounded array`);
  }
  const ids = value.map((id, index) => positiveInteger(id, `${path}[${index}]`));
  if ((!allowEmpty && ids.length === 0) || new Set(ids).size !== ids.length) {
    throw validationError(`${path} must contain unique IDs`);
  }
  if (ids.some((id, index) => index > 0 && id <= (ids[index - 1] as number))) {
    throw validationError(`${path} must be sorted`);
  }
  return Object.freeze(ids);
}

function minStars(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.5 ||
    value > 5 ||
    !Number.isInteger(value * 2)
  ) {
    throw validationError(`${path} must be a half-star increment from 0.5 to 5`);
  }
  return value;
}

/** Canonical destructive risk shown in every track-filter review. */
export const LIDARR_TRACK_FILTER_RISK = Object.freeze({
  level: "high",
  destructive: true,
  cascade: Object.freeze([
    "Lidarr deletes the exact managed trackfiles from disk.",
    "The endpoint provides no trash or recovery guarantee.",
    "Uncertain, unmapped, unreadable, and unrated files remain unchanged.",
  ]),
}) satisfies LidarrPlanRiskSummary;

export function requireLidarrTrackFilterOperation(
  value: unknown,
): LidarrTrackFileFilterOperationV2 {
  const operation = record(value, "plan.operation");
  exactKeys(operation, "plan.operation", ["kind", "explicitKeepTrackIds"], ["minStars"]);
  if (operation["kind"] !== "track-file-filter") {
    throw validationError("plan.operation.kind must be track-file-filter");
  }
  const explicitKeepTrackIds = sortedUniqueIds(
    operation["explicitKeepTrackIds"],
    "plan.operation.explicitKeepTrackIds",
    true,
  );
  const threshold =
    operation["minStars"] === undefined
      ? undefined
      : minStars(operation["minStars"], "plan.operation.minStars");
  if (explicitKeepTrackIds.length === 0 && threshold === undefined) {
    throw validationError("track-file-filter requires explicit IDs or minStars");
  }
  return Object.freeze({
    kind: "track-file-filter",
    explicitKeepTrackIds,
    ...(threshold === undefined ? {} : { minStars: threshold }),
  });
}

export function requireLidarrTrackFilterSelection(
  value: unknown,
): LidarrTrackFilterPlanSelectionV2 {
  const selection = record(value, "plan.selection");
  exactKeys(selection, "plan.selection", ["kind", "albumId"]);
  if (selection["kind"] !== "album-track-filter") {
    throw validationError("plan.selection.kind must be album-track-filter");
  }
  return Object.freeze({
    kind: "album-track-filter",
    albumId: positiveInteger(selection["albumId"], "plan.selection.albumId"),
  });
}

function requireCandidate(value: unknown, index: number): LidarrTrackFileDeleteCandidateV2 {
  const path = `plan.entries[0].before.deleteCandidates[${index}]`;
  const candidate = record(value, path);
  exactKeys(
    candidate,
    path,
    ["trackId", "trackTitle", "trackFileId", "path", "size"],
    ["mediumNumber", "absoluteTrackNumber", "rating"],
  );
  const rating =
    candidate["rating"] === undefined
      ? undefined
      : typeof candidate["rating"] === "number" &&
          Number.isFinite(candidate["rating"]) &&
          candidate["rating"] > 0 &&
          candidate["rating"] <= 1
        ? candidate["rating"]
        : (() => {
            throw validationError(`${path}.rating must be normalized to (0, 1]`);
          })();
  return Object.freeze({
    trackId: positiveInteger(candidate["trackId"], `${path}.trackId`),
    trackTitle: safeString(candidate["trackTitle"], `${path}.trackTitle`),
    trackFileId: positiveInteger(candidate["trackFileId"], `${path}.trackFileId`),
    path: safeString(candidate["path"], `${path}.path`),
    size: nonNegativeInteger(candidate["size"], `${path}.size`),
    ...(candidate["mediumNumber"] === undefined
      ? {}
      : {
          mediumNumber: nonNegativeInteger(candidate["mediumNumber"], `${path}.mediumNumber`),
        }),
    ...(candidate["absoluteTrackNumber"] === undefined
      ? {}
      : {
          absoluteTrackNumber: nonNegativeInteger(
            candidate["absoluteTrackNumber"],
            `${path}.absoluteTrackNumber`,
          ),
        }),
    ...(rating === undefined ? {} : { rating }),
  });
}

function requireWarning(value: unknown, index: number): LidarrTrackFilterWarningV2 {
  const path = `plan.entries[0].warnings[${index}]`;
  const warning = record(value, path);
  exactKeys(warning, path, ["code", "message"], ["trackId", "trackFileId", "path"]);
  const code = warning["code"];
  if (
    code !== "missing-file" &&
    code !== "unmapped-file" &&
    code !== "ambiguous-file" &&
    code !== "cross-album-file" &&
    code !== "unrated-or-unreadable"
  ) {
    throw validationError(`${path}.code is invalid`);
  }
  return Object.freeze({
    code,
    ...(warning["trackId"] === undefined
      ? {}
      : { trackId: positiveInteger(warning["trackId"], `${path}.trackId`) }),
    ...(warning["trackFileId"] === undefined
      ? {}
      : {
          trackFileId: positiveInteger(warning["trackFileId"], `${path}.trackFileId`),
        }),
    ...(warning["path"] === undefined ? {} : { path: safeString(warning["path"], `${path}.path`) }),
    message: safeString(warning["message"], `${path}.message`),
  });
}

export function requireLidarrTrackFilterEntry(
  value: unknown,
  operation: LidarrTrackFileFilterOperationV2,
  selection: LidarrTrackFilterPlanSelectionV2,
): LidarrTrackFileFilterPlanEntryV2 {
  const path = "plan.entries[0]";
  const entry = record(value, path);
  exactKeys(entry, path, [
    "id",
    "albumId",
    "albumTitle",
    "artistId",
    "artistName",
    "before",
    "after",
    "keptTrackIds",
    "warnings",
    "idempotencyKey",
  ]);
  const albumId = positiveInteger(entry["albumId"], `${path}.albumId`);
  if (
    albumId !== selection.albumId ||
    safeString(entry["id"], `${path}.id`) !== `album:${albumId}:track-file-filter`
  ) {
    throw validationError(`${path} identity is inconsistent with selection`);
  }
  const before = record(entry["before"], `${path}.before`);
  exactKeys(before, `${path}.before`, ["deleteCandidates"]);
  if (!Array.isArray(before["deleteCandidates"]) || before["deleteCandidates"].length === 0) {
    throw validationError(`${path}.before.deleteCandidates must not be empty`);
  }
  const deleteCandidates = before["deleteCandidates"].map(requireCandidate);
  const trackIds = deleteCandidates.map((candidate) => candidate.trackId);
  const trackFileIds = deleteCandidates.map((candidate) => candidate.trackFileId);
  if (
    new Set(trackIds).size !== trackIds.length ||
    new Set(trackFileIds).size !== trackFileIds.length ||
    deleteCandidates.some((candidate, index) => {
      const previous = deleteCandidates[index - 1];
      return (
        previous !== undefined &&
        (candidate.mediumNumber ?? 0) * 1_000_000 +
          (candidate.absoluteTrackNumber ?? candidate.trackId) <=
          (previous.mediumNumber ?? 0) * 1_000_000 +
            (previous.absoluteTrackNumber ?? previous.trackId)
      );
    })
  ) {
    throw validationError(`${path}.before.deleteCandidates must be unique and sorted`);
  }
  const after = record(entry["after"], `${path}.after`);
  exactKeys(after, `${path}.after`, ["deletedTrackFileIds"]);
  const deletedTrackFileIds = sortedUniqueIds(
    after["deletedTrackFileIds"],
    `${path}.after.deletedTrackFileIds`,
  );
  if (
    deletedTrackFileIds.length !== trackFileIds.length ||
    [...trackFileIds]
      .sort((left, right) => left - right)
      .some((id, index) => id !== deletedTrackFileIds[index])
  ) {
    throw validationError(`${path}.after does not match delete candidates`);
  }
  const keptTrackIds = sortedUniqueIds(entry["keptTrackIds"], `${path}.keptTrackIds`);
  if (operation.explicitKeepTrackIds.some((id) => !keptTrackIds.includes(id))) {
    throw validationError(`${path}.keptTrackIds omits an explicit keep ID`);
  }
  if (!Array.isArray(entry["warnings"]) || entry["warnings"].length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`${path}.warnings must be a bounded array`);
  }
  const warnings = entry["warnings"].map(requireWarning);
  const idempotencyKey = safeString(entry["idempotencyKey"], `${path}.idempotencyKey`);
  if (!SHA256_PATTERN.test(idempotencyKey)) {
    throw validationError(`${path}.idempotencyKey is invalid`);
  }
  return Object.freeze({
    id: entry["id"] as string,
    albumId,
    albumTitle: safeString(entry["albumTitle"], `${path}.albumTitle`),
    artistId: positiveInteger(entry["artistId"], `${path}.artistId`),
    artistName: safeString(entry["artistName"], `${path}.artistName`),
    before: Object.freeze({ deleteCandidates: Object.freeze(deleteCandidates) }),
    after: Object.freeze({ deletedTrackFileIds }),
    keptTrackIds,
    warnings: Object.freeze(warnings),
    idempotencyKey,
  });
}

export function summarizeLidarrTrackFilterEntry(
  entry: LidarrTrackFileFilterPlanEntryV2,
): LidarrTrackFilterPlanSummaryV2 {
  return Object.freeze({
    kind: "track-file-filter",
    tracks: entry.keptTrackIds.length + entry.before.deleteCandidates.length,
    kept: entry.keptTrackIds.length,
    deleteCandidates: entry.before.deleteCandidates.length,
    warnings: entry.warnings.length,
    totalDeleteBytes: entry.before.deleteCandidates.reduce(
      (total, candidate) => total + candidate.size,
      0,
    ),
  });
}

export function assertLidarrTrackFilterSummary(
  value: unknown,
  entry: LidarrTrackFileFilterPlanEntryV2,
): void {
  const summary = record(value, "plan.summary");
  exactKeys(summary, "plan.summary", [
    "kind",
    "tracks",
    "kept",
    "deleteCandidates",
    "warnings",
    "totalDeleteBytes",
  ]);
  const expected = summarizeLidarrTrackFilterEntry(entry);
  for (const key of [
    "tracks",
    "kept",
    "deleteCandidates",
    "warnings",
    "totalDeleteBytes",
  ] as const) {
    if (nonNegativeInteger(summary[key], `plan.summary.${key}`) !== expected[key]) {
      throw validationError("plan.summary counts are inconsistent");
    }
  }
  if (summary["kind"] !== "track-file-filter") {
    throw validationError("plan.summary.kind is inconsistent");
  }
}

export function trackFilterIdempotencyKey(
  origin: string,
  operation: LidarrTrackFileFilterOperationV2,
  entry: Pick<LidarrTrackFileFilterPlanEntryV2, "albumId" | "before">,
): string {
  const canonical = JSON.stringify({
    origin,
    operation: operation.kind,
    albumId: entry.albumId,
    explicitKeepTrackIds: operation.explicitKeepTrackIds,
    minStars: operation.minStars ?? null,
    deleteCandidates: entry.before.deleteCandidates.map(({ trackId, trackFileId, path, size }) => ({
      trackId,
      trackFileId,
      path,
      size,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function canonicalizeLidarrTrackFilterPlanEntry(
  entry: LidarrTrackFileFilterPlanEntryV2,
): LidarrTrackFileFilterPlanEntryV2 {
  return {
    ...entry,
    before: {
      deleteCandidates: entry.before.deleteCandidates.map((candidate) => ({ ...candidate })),
    },
    after: { deletedTrackFileIds: [...entry.after.deletedTrackFileIds] },
    keptTrackIds: [...entry.keptTrackIds],
    warnings: entry.warnings.map((warning) => ({ ...warning })),
  };
}

export interface BuildLidarrTrackFilterPlanInput {
  readonly origin: string;
  readonly albumId: number;
  readonly operation: LidarrTrackFileFilterOperationV2;
  readonly maxBatch: number;
  readonly entry: Omit<LidarrTrackFileFilterPlanEntryV2, "idempotencyKey">;
}

/** V3 track-filter input with reviewed monitoring evidence and resolved cascade policy. */
export interface BuildLidarrTrackFilterPlanV3Input extends BuildLidarrTrackFilterPlanInput {
  readonly albumMonitored: boolean;
  readonly cascadePolicy: LidarrCascadePolicy;
}

/** Builds and checksum-seals one exact, single-album trackfile deletion plan. */
export function buildLidarrTrackFilterPlanV2(
  input: BuildLidarrTrackFilterPlanInput,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrTrackFileFilterPlanV2 {
  const origin = canonicalizeLidarrPlanOrigin(input.origin);
  const operation = requireLidarrTrackFilterOperation(input.operation);
  const selection = requireLidarrTrackFilterSelection({
    kind: "album-track-filter",
    albumId: input.albumId,
  });
  const maxBatch = positiveInteger(input.maxBatch, "maxBatch", LIDARR_PLAN_MAX_BATCH);
  const candidateCount = input.entry.before.deleteCandidates.length;
  if (candidateCount === 0 || candidateCount > maxBatch) {
    throw validationError(`delete candidates exceed maxBatch (${candidateCount} > ${maxBatch})`);
  }
  const source = {
    ...input.entry,
    idempotencyKey: trackFilterIdempotencyKey(origin, operation, input.entry),
  };
  const entry = requireLidarrTrackFilterEntry(source, operation, selection);
  const envelope = createLidarrPlanEnvelope(dependencies);
  const summary = summarizeLidarrTrackFilterEntry(entry);
  const planWithoutSeal = {
    version: "rfmedia.lidarr-plan.v2" as const,
    ...envelope,
    command: "lidarr" as const,
    target: { origin },
    selection,
    operation,
    maxBatch,
    entries: [entry] as const,
    review: { requested: candidateCount, changed: candidateCount, unchanged: 0 },
    summary,
    risk: LIDARR_TRACK_FILTER_RISK,
    payloadChecksum: "",
  };
  const plan = Object.freeze({
    ...planWithoutSeal,
    payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
  }) as LidarrTrackFileFilterPlanV2;
  assertLidarrTrackFilterPlanShape(plan);
  return plan;
}

/**
 * Builds the unchanged v2 facts, seals the reviewed album monitoring state,
 * and delegates v3 analysis and checksum creation to the shared artifact boundary.
 */
export function buildLidarrTrackFilterPlanV3(
  input: BuildLidarrTrackFilterPlanV3Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrTrackFileFilterPlanV3 {
  const { albumMonitored, cascadePolicy, ...legacyInput } = input;
  const legacy = buildLidarrTrackFilterPlanV2(legacyInput, dependencies);
  const [legacyEntry] = legacy.entries;
  const entry = Object.freeze({
    ...legacyEntry,
    before: Object.freeze({
      albumMonitored,
      deleteCandidates: legacyEntry.before.deleteCandidates,
    }),
  }) satisfies LidarrTrackFileFilterPlanEntryV3;
  const {
    version: _version,
    entries: _entries,
    payloadChecksum: _payloadChecksum,
    ...legacySeed
  } = legacy;

  return sealLidarrMutationPlanV3(
    {
      ...legacySeed,
      entries: Object.freeze([entry]),
    },
    cascadePolicy,
  );
}

/** Module-local structural checks used by both builder and shared plan reader. */
export function assertLidarrTrackFilterPlanShape(plan: LidarrTrackFileFilterPlanV2): void {
  if (plan.entries.length !== 1) throw validationError("track-file-filter requires one entry");
  const operation = requireLidarrTrackFilterOperation(plan.operation);
  const selection = requireLidarrTrackFilterSelection(plan.selection);
  const entry = requireLidarrTrackFilterEntry(plan.entries[0], operation, selection);
  if (entry.before.deleteCandidates.length > plan.maxBatch) {
    throw validationError("delete candidates exceed plan.maxBatch");
  }
  assertLidarrTrackFilterSummary(plan.summary, entry);
  if (JSON.stringify(plan.risk) !== JSON.stringify(LIDARR_TRACK_FILTER_RISK)) {
    throw validationError("plan.risk is inconsistent with track-file-filter");
  }
  if (entry.idempotencyKey !== trackFilterIdempotencyKey(plan.target.origin, operation, entry)) {
    throw validationError("plan entry idempotency key is inconsistent");
  }
}
