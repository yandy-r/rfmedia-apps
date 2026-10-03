/**
 * Pure Lidarr artist selection, resource resolution, and tag-set algebra.
 *
 * This module deliberately accepts complete domain snapshots and performs no
 * I/O. Mutation planning must not inherit paging or stale-cache behavior from
 * the `lidarr list` action.
 */

import type {
  LidarrArtist,
  LidarrProfile,
  LidarrRootFolder,
  LidarrTag,
  LidarrTagMutationMode,
} from "../../types/lidarr.js";
import { LIDARR_PLAN_DEFAULT_MAX_BATCH, LIDARR_PLAN_MAX_BATCH } from "../../types/lidarr-plan.js";

const MAX_RESOURCE_ERROR_CHOICES = 10;
const POSITIVE_DECIMAL_PATTERN = /^\d+$/u;

/** Raw, action-facing selection input. */
export interface LidarrArtistSelectionInput {
  /** Exact artist IDs. Exclusive with filters and `all`. */
  readonly ids?: readonly number[];
  /** Explicitly select the complete artist snapshot. */
  readonly all?: boolean;
  /** Select monitored artists. */
  readonly monitored?: boolean;
  /** Select unmonitored artists. */
  readonly unmonitored?: boolean;
  /** Select artists assigned this quality-profile ID. */
  readonly qualityProfileId?: number;
  /** Select artists assigned this metadata-profile ID. */
  readonly metadataProfileId?: number;
  /** Select artists carrying every one of these tag IDs. */
  readonly tagIds?: readonly number[];
  /** Maximum selected cohort size. Defaults to 25 and cannot exceed 1,000. */
  readonly maxBatch?: number;
}

/** Exact normalized tag-set transition and its deltas. */
export interface LidarrTagSetChange {
  /** Normalized tag IDs before the operation. */
  readonly before: readonly number[];
  /** Normalized desired tag IDs after the operation. */
  readonly after: readonly number[];
  /** Tag IDs present only after the operation. */
  readonly added: readonly number[];
  /** Tag IDs present only before the operation. */
  readonly removed: readonly number[];
  /** Tag IDs present both before and after the operation. */
  readonly retained: readonly number[];
}

interface NamedResource {
  readonly id: number;
  readonly displayName: string;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function normalizeCaseInsensitiveName(value: string): string {
  return value.trim().toLowerCase();
}

function formatResourceChoices(resources: readonly NamedResource[]): string {
  const sorted = [...resources].sort((left, right) => left.id - right.id);
  const choices = sorted
    .slice(0, MAX_RESOURCE_ERROR_CHOICES)
    .map((resource) => `${resource.displayName} (${resource.id})`)
    .join(", ");
  const suffix = sorted.length > MAX_RESOURCE_ERROR_CHOICES ? ", ..." : "";
  return choices.length === 0 ? "none" : `${choices}${suffix}`;
}

function resolveResourceReference<T>(
  reference: string,
  resources: readonly T[],
  kind: string,
  project: (resource: T) => NamedResource,
): T {
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${kind} reference must not be empty`);
  }

  const namedResources = resources.map((resource) => ({
    resource,
    projected: project(resource),
  }));
  const forceName = trimmed.slice(0, 5).toLowerCase() === "name:";
  const referenceValue = forceName ? trimmed.slice(5).trim() : trimmed;
  if (referenceValue.length === 0) {
    throw new TypeError(`${kind} name reference must not be empty`);
  }

  let matches: typeof namedResources;
  if (!forceName && POSITIVE_DECIMAL_PATTERN.test(referenceValue)) {
    const id = Number(referenceValue);
    requirePositiveSafeInteger(id, `${kind} ID`);
    matches = namedResources.filter(({ projected }) => projected.id === id);
  } else {
    const normalizedName = normalizeCaseInsensitiveName(referenceValue);
    matches = namedResources.filter(
      ({ projected }) => normalizeCaseInsensitiveName(projected.displayName) === normalizedName,
    );
  }

  if (matches.length === 1) {
    const match = matches[0];
    if (match !== undefined) {
      return match.resource;
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ${kind} reference "${trimmed}". Matches: ${formatResourceChoices(
        matches.map(({ projected }) => projected),
      )}`,
    );
  }

  throw new Error(
    `Unknown ${kind} reference "${trimmed}". Available choices: ${formatResourceChoices(
      namedResources.map(({ projected }) => projected),
    )}`,
  );
}

function validateSelectionInput(input: LidarrArtistSelectionInput): number {
  const hasIds = input.ids !== undefined;
  const hasFilters =
    input.monitored === true ||
    input.unmonitored === true ||
    input.qualityProfileId !== undefined ||
    input.metadataProfileId !== undefined ||
    (input.tagIds !== undefined && input.tagIds.length > 0);
  const hasAll = input.all === true;
  const modeCount = Number(hasIds) + Number(hasFilters) + Number(hasAll);

  if (modeCount !== 1) {
    throw new Error("Exactly one artist selection mode is required: ids, filters, or all");
  }
  if (input.monitored === true && input.unmonitored === true) {
    throw new Error("Monitored and unmonitored artist filters are mutually exclusive");
  }

  const maxBatch = input.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH;
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > LIDARR_PLAN_MAX_BATCH) {
    throw new TypeError(
      `maxBatch must be a positive safe integer no greater than ${LIDARR_PLAN_MAX_BATCH}`,
    );
  }
  return maxBatch;
}

function selectByIds(
  artists: readonly LidarrArtist[],
  requestedIds: readonly number[],
): readonly LidarrArtist[] {
  if (requestedIds.length === 0) {
    throw new Error("Artist ID selection requires at least one ID");
  }

  const seen = new Set<number>();
  for (const id of requestedIds) {
    requirePositiveSafeInteger(id, "Artist ID");
    if (seen.has(id)) {
      throw new Error(`Duplicate artist ID: ${id}`);
    }
    seen.add(id);
  }

  const artistById = new Map(artists.map((artist) => [artist.id, artist]));
  const unknownIds = requestedIds.filter((id) => !artistById.has(id)).sort((a, b) => a - b);
  if (unknownIds.length > 0) {
    throw new Error(`Unknown artist IDs: ${unknownIds.join(", ")}`);
  }

  return requestedIds
    .map((id) => artistById.get(id))
    .filter((artist): artist is LidarrArtist => artist !== undefined);
}

function matchesFilters(
  artist: LidarrArtist,
  input: LidarrArtistSelectionInput,
  normalizedTagIds: readonly number[],
): boolean {
  if (input.monitored === true && !artist.monitored) {
    return false;
  }
  if (input.unmonitored === true && artist.monitored) {
    return false;
  }
  if (input.qualityProfileId !== undefined && artist.qualityProfileId !== input.qualityProfileId) {
    return false;
  }
  if (
    input.metadataProfileId !== undefined &&
    artist.metadataProfileId !== input.metadataProfileId
  ) {
    return false;
  }

  const artistTagIds = new Set(artist.tags);
  return normalizedTagIds.every((tagId) => artistTagIds.has(tagId));
}

/**
 * Resolves one profile reference from a complete bounded profile snapshot.
 *
 * Positive decimal text resolves by ID. `name:` forces name interpretation;
 * all other text uses trimmed, case-insensitive exact name matching.
 *
 * @param reference - User-supplied profile reference.
 * @param profiles - Complete fresh profile snapshot.
 * @returns The exactly resolved profile.
 * @throws {Error} When the reference is empty, invalid, unknown, or ambiguous.
 */
export function resolveLidarrProfileReference(
  reference: string,
  profiles: readonly LidarrProfile[],
): LidarrProfile {
  const profile = resolveResourceReference(reference, profiles, "profile", (candidate) => ({
    id: candidate.id,
    displayName: candidate.name,
  }));
  return Object.freeze({ id: profile.id, name: profile.name });
}

/**
 * Resolves one root-folder reference from a complete fresh snapshot.
 *
 * Positive decimal text resolves by ID. `path:` forces path interpretation;
 * every path match is trimmed and otherwise exact, including case.
 *
 * @param reference - User-supplied root-folder ID or exact path.
 * @param rootFolders - Complete fresh root-folder snapshot.
 * @returns The exactly resolved root folder.
 * @throws {Error} When the reference is empty, invalid, unknown, or ambiguous.
 */
export function resolveLidarrRootFolderReference(
  reference: string,
  rootFolders: readonly LidarrRootFolder[],
): LidarrRootFolder {
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    throw new TypeError("root folder reference must not be empty");
  }
  const forcePath = trimmed.slice(0, 5).toLowerCase() === "path:";
  const referenceValue = forcePath ? trimmed.slice(5).trim() : trimmed;
  if (referenceValue.length === 0) {
    throw new TypeError("root folder path reference must not be empty");
  }
  const matches =
    !forcePath && POSITIVE_DECIMAL_PATTERN.test(referenceValue)
      ? rootFolders.filter(
          (rootFolder) =>
            rootFolder.id === requirePositiveSafeInteger(Number(referenceValue), "root folder ID"),
        )
      : rootFolders.filter((rootFolder) => rootFolder.path.trim() === referenceValue);

  if (matches.length === 1 && matches[0] !== undefined) {
    const rootFolder = matches[0];
    return Object.freeze({
      id: rootFolder.id,
      path: rootFolder.path,
      accessible: rootFolder.accessible,
      ...(rootFolder.freeSpace === undefined ? {} : { freeSpace: rootFolder.freeSpace }),
    });
  }
  const choices = formatResourceChoices(
    rootFolders.map((rootFolder) => ({
      id: rootFolder.id,
      displayName: rootFolder.path,
    })),
  );
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous root folder reference "${trimmed}". Matches: ${formatResourceChoices(
        matches.map((rootFolder) => ({
          id: rootFolder.id,
          displayName: rootFolder.path,
        })),
      )}`,
    );
  }
  throw new Error(`Unknown root folder reference "${trimmed}". Available choices: ${choices}`);
}

/**
 * Resolves one tag reference from a complete bounded tag snapshot.
 *
 * Positive decimal text resolves by ID. `name:` forces label interpretation;
 * all other text uses trimmed, case-insensitive exact label matching.
 *
 * @param reference - User-supplied tag reference.
 * @param tags - Complete fresh tag snapshot.
 * @returns The exactly resolved tag.
 * @throws {Error} When the reference is empty, invalid, unknown, or ambiguous.
 */
export function resolveLidarrTagReference(
  reference: string,
  tags: readonly LidarrTag[],
): LidarrTag {
  const tag = resolveResourceReference(reference, tags, "tag", (candidate) => ({
    id: candidate.id,
    displayName: candidate.label,
  }));
  return Object.freeze({ id: tag.id, label: tag.label });
}

/**
 * Selects a complete deterministic artist cohort from a fresh snapshot.
 *
 * Exactly one of IDs, one-or-more filters, or explicit `all` is required.
 * Filter families combine with AND and repeated tag IDs use all-of semantics.
 * The full matched cohort is sorted before zero-match and cap enforcement; it
 * is never paged or truncated.
 *
 * @param artists - Complete fresh artist snapshot.
 * @param input - Selection mode, filters, and optional cap.
 * @returns The complete matching cohort in ascending artist-ID order.
 * @throws {Error} When selection is invalid, IDs are unknown, no artists
 *   match, or the complete cohort exceeds the configured cap.
 */
export function selectLidarrArtists(
  artists: readonly LidarrArtist[],
  input: LidarrArtistSelectionInput,
): readonly LidarrArtist[] {
  const maxBatch = validateSelectionInput(input);
  const normalizedTagIds = normalizeLidarrTagIds(input.tagIds ?? []);

  if (input.qualityProfileId !== undefined) {
    requirePositiveSafeInteger(input.qualityProfileId, "Quality profile ID");
  }
  if (input.metadataProfileId !== undefined) {
    requirePositiveSafeInteger(input.metadataProfileId, "Metadata profile ID");
  }

  let selected: readonly LidarrArtist[];
  if (input.ids !== undefined) {
    selected = selectByIds(artists, input.ids);
  } else if (input.all === true) {
    selected = artists;
  } else {
    selected = artists.filter((artist) => matchesFilters(artist, input, normalizedTagIds));
  }

  const sorted = [...selected].sort((left, right) => left.id - right.id);
  if (sorted.length === 0) {
    throw new Error("Artist selection matched zero artists");
  }
  if (sorted.length > maxBatch) {
    throw new Error(
      `Artist selection matched ${sorted.length} artists, exceeding maxBatch ${maxBatch}`,
    );
  }
  return Object.freeze(sorted);
}

/**
 * Validates and normalizes tag IDs into an ascending unique set.
 *
 * @param tagIds - Tag IDs to normalize.
 * @returns A frozen ascending unique tag-ID array.
 * @throws {TypeError} When an ID is not a positive safe integer.
 */
export function normalizeLidarrTagIds(tagIds: readonly number[]): readonly number[] {
  for (const tagId of tagIds) {
    requirePositiveSafeInteger(tagId, "Tag ID");
  }
  return Object.freeze([...new Set(tagIds)].sort((left, right) => left - right));
}

/**
 * Calculates one normalized tag-set transition and its exact deltas.
 *
 * Add/remove/set require at least one requested tag. Clear requires an empty
 * request. Every returned set is sorted and unique, including no-op results.
 *
 * @param beforeTagIds - Current full artist tag set.
 * @param mode - Requested add, remove, set, or clear operation.
 * @param requestedTagIds - Requested tag IDs for the operation.
 * @returns Normalized before/after sets and added/removed/retained deltas.
 * @throws {Error} When tag values conflict with the selected mode.
 */
export function calculateLidarrTagSetChange(
  beforeTagIds: readonly number[],
  mode: LidarrTagMutationMode,
  requestedTagIds: readonly number[],
): LidarrTagSetChange {
  const before = normalizeLidarrTagIds(beforeTagIds);
  const requested = normalizeLidarrTagIds(requestedTagIds);

  if (mode === "clear" && requested.length > 0) {
    throw new Error("Clear tag mode does not accept tag IDs");
  }
  if (mode !== "clear" && requested.length === 0) {
    throw new Error(`${mode} tag mode requires at least one tag ID`);
  }

  const beforeSet = new Set(before);
  const requestedSet = new Set(requested);
  let after: readonly number[];

  switch (mode) {
    case "add":
      after = normalizeLidarrTagIds([...before, ...requested]);
      break;
    case "remove":
      after = Object.freeze(before.filter((tagId) => !requestedSet.has(tagId)));
      break;
    case "set":
      after = requested;
      break;
    case "clear":
      after = Object.freeze([]);
      break;
  }

  const afterSet = new Set(after);
  return Object.freeze({
    before,
    after,
    added: Object.freeze(after.filter((tagId) => !beforeSet.has(tagId))),
    removed: Object.freeze(before.filter((tagId) => !afterSet.has(tagId))),
    retained: Object.freeze(after.filter((tagId) => beforeSet.has(tagId))),
  });
}
