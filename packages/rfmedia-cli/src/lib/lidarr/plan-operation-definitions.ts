/** Typed behavior definitions for allowlisted Lidarr mutation-plan operations. */

import { createHash } from "node:crypto";

import {
  LIDARR_PLAN_MAX_ENTRIES,
  type LidarrArtistAddExtendedOperationV2,
  type LidarrArtistAddExtendedPlanEntryV2,
  type LidarrArtistAddLegacyOperationV2,
  type LidarrArtistAddOperationV2,
  type LidarrArtistAddPlanEntryV2,
  type LidarrArtistDeleteEvidence,
  type LidarrArtistDeleteObservedState,
  type LidarrArtistDeleteOperation,
  type LidarrArtistDeletePlanEntry,
  type LidarrArtistProfileAssignmentOperation,
  type LidarrArtistProfilePlanEntry,
  type LidarrArtistMonitoringOperation,
  type LidarrArtistMonitoringPlanEntry,
  type LidarrArtistTagMutationOperation,
  type LidarrArtistTagMutationPlanEntry,
  type LidarrMutationOperationV2,
  type LidarrMutationPlanEntry,
  type LidarrMutationPlanEntryV2,
  type LidarrPlanOperationSummaryV2,
  type LidarrPlanResourceReference,
  type LidarrPlanRiskSummary,
  type LidarrPlanRootFolderReference,
  type LidarrPlanTagReference,
} from "../../types/lidarr-plan.js";
import type { LidarrArtist, LidarrProfileAssignmentInput } from "../../types/lidarr.js";
import type { LidarrClientApi } from "./client.js";
import type { LidarrIntentExecutor } from "./deferred-queue.js";
import { LIDARR_ALBUM_TYPE_SELECTORS } from "./album-types.js";
import {
  assertNoSensitiveKeys,
  requireBoolean,
  requireExactKeys,
  requirePositiveInteger,
  requireRecord,
  requireString,
  validationError,
  type UnknownRecord,
} from "./plan-validation.js";

type AnyLidarrMutationPlanEntry = LidarrMutationPlanEntry | LidarrMutationPlanEntryV2;

export const LIDARR_ARTIST_MONITORING_OPERATION = "lidarr.artist-monitoring";
export const LIDARR_ARTIST_PROFILE_ASSIGNMENT_OPERATION = "lidarr.artist-profile-assignment";
export const LIDARR_ARTIST_TAG_MUTATION_OPERATION = "lidarr.artist-tag-mutation";

export type LidarrPlanEntryClassification = "ready" | "satisfied" | "drifted";

/** Operation-specific normalized live state used for apply classification. */
export type LidarrPlanLiveState =
  | {
      readonly kind: "artist-monitoring";
      readonly monitored: boolean;
    }
  | {
      readonly kind: "artist-profile-assignment";
      readonly qualityProfileId?: number;
      readonly metadataProfileId?: number;
    }
  | {
      readonly kind: "artist-tag-mutation";
      readonly tagIds: readonly number[];
    }
  | LidarrArtistDeleteObservedState;

/** Structured result of comparing one reviewed entry with current Lidarr state. */
export type LidarrPlanLiveClassification =
  | {
      readonly state: "ready" | "satisfied";
      readonly observed: LidarrPlanLiveState;
    }
  | {
      readonly state: "drifted";
      readonly observed: LidarrPlanLiveState;
      readonly message: string;
    };

/** Stable plan references that apply must resolve before admitting any write. */
export type LidarrPlanReferencedResource =
  | {
      readonly kind: "quality-profile" | "metadata-profile";
      readonly id: number;
      readonly name: string;
    }
  | {
      readonly kind: "tag";
      readonly id: number;
      readonly label: string;
    };

/** References resolved exclusively by the foreign-ID artist-add family. */
export type LidarrArtistAddReferencedResource =
  | LidarrPlanReferencedResource
  | {
      readonly kind: "root-folder";
      readonly id: number;
      readonly path: string;
    };

/** Normalized source state from which an operation definition constructs an entry. */
export type LidarrPlanEntrySource =
  | {
      readonly kind: "artist-monitoring";
      readonly artistId: number;
      readonly artistName: string;
      readonly monitored: boolean;
    }
  | {
      readonly kind: "artist-profile-assignment";
      readonly artistId: number;
      readonly artistName: string;
      readonly qualityProfile?: LidarrPlanResourceReference;
      readonly metadataProfile?: LidarrPlanResourceReference;
    }
  | {
      readonly kind: "artist-tag-mutation";
      readonly artistId: number;
      readonly artistName: string;
      readonly tags: readonly LidarrPlanTagReference[];
    }
  | {
      readonly kind: "artist-delete";
      readonly artistId: number;
      readonly artistName: string;
      readonly path: string;
      readonly albumCount: number;
      readonly trackFileCount: number;
      readonly sizeOnDisk: number;
    };

/** Live input accepted by operation-owned drift and postcondition behavior. */
export type LidarrPlanCurrentState = LidarrArtist | LidarrArtistDeleteObservedState;

/** Common behavior contract for one allowlisted Lidarr plan operation. */
interface LidarrMutationOperationDefinitionBase<TKind extends LidarrMutationOperationV2["kind"]> {
  readonly kind: TKind;
  readonly operation: Extract<LidarrMutationOperationV2, { readonly kind: TKind }>;
  canonicalize(): LidarrMutationOperationV2;
  risk(): LidarrPlanRiskSummary;
  referencedResources(): readonly LidarrPlanReferencedResource[];
  buildEntry(origin: string, source: LidarrPlanEntrySource): LidarrMutationPlanEntryV2;
  hasChange(entry: AnyLidarrMutationPlanEntry): boolean;
  summarize(entries: readonly LidarrMutationPlanEntryV2[]): LidarrPlanOperationSummaryV2;
  payloadFor(entry: AnyLidarrMutationPlanEntry): Readonly<Record<string, unknown>>;
  idempotencyKey(origin: string, entry: AnyLidarrMutationPlanEntry): string;
  classifyLive(
    entry: AnyLidarrMutationPlanEntry,
    current: LidarrPlanCurrentState,
  ): LidarrPlanLiveClassification;
  classify(
    entry: AnyLidarrMutationPlanEntry,
    current: LidarrPlanCurrentState,
  ): LidarrPlanEntryClassification;
  verify(entry: AnyLidarrMutationPlanEntry, current: LidarrPlanCurrentState): boolean;
  execute(
    entry: AnyLidarrMutationPlanEntry,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
}

type LidarrDeferableMutationOperationKind = Exclude<
  LidarrMutationOperationV2["kind"],
  "artist-delete"
>;

interface LidarrDeferredMutationBehavior {
  readonly deferability: {
    readonly kind: "deferable";
    readonly operation: string;
  };
  executeDeferredPayload(
    payload: Readonly<Record<string, unknown>>,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
  matchesDeferredIntent(
    entry: AnyLidarrMutationPlanEntry,
    queuedOperation: string,
    queuedPayload: Readonly<Record<string, unknown>>,
  ): boolean;
}

type LidarrDeferableMutationOperationDefinitionFor<
  TKind extends LidarrDeferableMutationOperationKind,
> = LidarrMutationOperationDefinitionBase<TKind> & LidarrDeferredMutationBehavior;

/** Registry contract distributed by each operation kind allowed to defer. */
export type LidarrDeferableMutationOperationDefinition = {
  [TKind in LidarrDeferableMutationOperationKind]: LidarrDeferableMutationOperationDefinitionFor<TKind>;
}[LidarrDeferableMutationOperationKind];

/** Registry contract for operations that must never enter the deferred-intent subsystem. */
export interface LidarrNonDeferableMutationOperationDefinition extends LidarrMutationOperationDefinitionBase<"artist-delete"> {
  readonly deferability: {
    readonly kind: "non-deferable";
  };
}

/** Exact behavior contract for one allowlisted Lidarr plan operation. */
export type LidarrMutationOperationDefinition =
  | LidarrDeferableMutationOperationDefinition
  | LidarrNonDeferableMutationOperationDefinition;

const ARTIST_MONITORING_RISK = Object.freeze({
  level: "low",
  destructive: false,
  cascade: Object.freeze([
    "Existing files remain unchanged.",
    "Existing download-queue items are not cancelled.",
    "No artist or album search is triggered.",
  ]),
}) satisfies LidarrPlanRiskSummary;

const ARTIST_PROFILE_ASSIGNMENT_RISK = Object.freeze({
  level: "medium",
  destructive: false,
  cascade: Object.freeze([
    "Existing files remain unchanged.",
    "Future acquisition and refresh behavior may change.",
    "No artist or album search is triggered.",
  ]),
}) satisfies LidarrPlanRiskSummary;

const ARTIST_TAG_DELTA_RISK = Object.freeze({
  level: "low",
  destructive: false,
  cascade: Object.freeze([
    "Existing files remain unchanged.",
    "Unrelated tag assignments are preserved.",
    "Tag-scoped automation may change future behavior.",
  ]),
}) satisfies LidarrPlanRiskSummary;

const ARTIST_TAG_REPLACEMENT_RISK = Object.freeze({
  level: "high",
  destructive: true,
  cascade: Object.freeze([
    "Existing files remain unchanged.",
    "Existing tag assignments not in the desired set are removed.",
    "Tag-scoped automation may change future behavior.",
  ]),
}) satisfies LidarrPlanRiskSummary;

const ARTIST_DELETE_RISK = Object.freeze({
  level: "high",
  destructive: true,
  cascade: Object.freeze([
    "The artist and its Lidarr metadata are permanently removed.",
    "Album records are removed as part of the artist deletion cascade.",
    "On-disk files are deleted only when the sealed delete-files mode is enabled.",
  ]),
}) satisfies LidarrPlanRiskSummary;

export const LIDARR_ARTIST_ADD_RISK = Object.freeze({
  level: "medium",
  destructive: false,
  cascade: Object.freeze([
    "The artist is added unmonitored.",
    "New albums are not monitored automatically.",
    "No missing-album search is triggered.",
  ]),
}) satisfies LidarrPlanRiskSummary;

const MAX_ARTIST_ADD_SELECTORS = 64;
const ARTIST_ADD_SELECTOR_ALLOWLIST: ReadonlySet<string> = new Set(LIDARR_ALBUM_TYPE_SELECTORS);
const CANONICAL_MUSICBRAINZ_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function freezeProfileReference(
  reference: LidarrPlanResourceReference,
  path: string,
): LidarrPlanResourceReference {
  return Object.freeze({
    id: requirePositiveInteger(reference.id, `${path}.id`),
    name: requireString(reference.name, `${path}.name`),
  });
}

function freezeRootFolderReference(
  reference: LidarrPlanRootFolderReference,
  path: string,
): LidarrPlanRootFolderReference {
  return Object.freeze({
    id: requirePositiveInteger(reference.id, `${path}.id`),
    path: requireString(reference.path, `${path}.path`),
  });
}

function freezeTagReferences(
  references: readonly LidarrPlanTagReference[],
  path: string,
): readonly LidarrPlanTagReference[] {
  const sorted = references
    .map((reference, index) =>
      Object.freeze({
        id: requirePositiveInteger(reference.id, `${path}[${index}].id`),
        label: requireString(reference.label, `${path}[${index}].label`),
      }),
    )
    .sort((left, right) => left.id - right.id);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.id === sorted[index]?.id) {
      throw validationError(`${path} must contain unique tag ids`);
    }
  }
  return Object.freeze(sorted);
}

function requireSortedPositiveIds(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`${path} must be a bounded array`);
  }
  let previous = 0;
  const ids = value.map((item, index) => {
    const id = requirePositiveInteger(item, `${path}[${index}]`);
    if (id <= previous) throw validationError(`${path} must be sorted and unique`);
    previous = id;
    return id;
  });
  return Object.freeze(ids);
}

function requireMonitoringEntry(
  entry: AnyLidarrMutationPlanEntry,
): LidarrArtistMonitoringPlanEntry {
  if (!isMonitoringEntry(entry)) {
    throw validationError("artist-monitoring definition received an incompatible entry");
  }
  return entry;
}

function isMonitoringEntry(
  entry: AnyLidarrMutationPlanEntry,
): entry is LidarrArtistMonitoringPlanEntry {
  return "monitored" in entry.before && "monitored" in entry.after;
}

function requireProfileEntry(entry: AnyLidarrMutationPlanEntry): LidarrArtistProfilePlanEntry {
  if (!isProfileEntry(entry)) {
    throw validationError("artist-profile-assignment definition received an incompatible entry");
  }
  return entry;
}

function isProfileEntry(entry: AnyLidarrMutationPlanEntry): entry is LidarrArtistProfilePlanEntry {
  return (
    !("monitored" in entry.before) &&
    !("tags" in entry.before) &&
    !("monitored" in entry.after) &&
    !("tags" in entry.after) &&
    !("added" in entry)
  );
}

function requireTagEntry(entry: AnyLidarrMutationPlanEntry): LidarrArtistTagMutationPlanEntry {
  if (!isTagEntry(entry)) {
    throw validationError("artist-tag-mutation definition received an incompatible entry");
  }
  return entry;
}

function isTagEntry(entry: AnyLidarrMutationPlanEntry): entry is LidarrArtistTagMutationPlanEntry {
  return "tags" in entry.before && "tags" in entry.after && "added" in entry;
}

function requireDeleteEntry(entry: AnyLidarrMutationPlanEntry): LidarrArtistDeletePlanEntry {
  if (!isDeleteEntry(entry)) {
    throw validationError("artist-delete definition received an incompatible entry");
  }
  return entry;
}

function isDeleteEntry(entry: AnyLidarrMutationPlanEntry): entry is LidarrArtistDeletePlanEntry {
  return "path" in entry.before && "exists" in entry.after;
}

function deleteEvidence(source: {
  readonly path: unknown;
  readonly albumCount: unknown;
  readonly trackFileCount: unknown;
  readonly sizeOnDisk: unknown;
}): LidarrArtistDeleteEvidence {
  return Object.freeze({
    path: requireString(source.path, "artist-delete evidence.path"),
    albumCount: requireNonNegativeSafeInteger(
      source.albumCount,
      "artist-delete evidence.albumCount",
    ),
    trackFileCount: requireNonNegativeSafeInteger(
      source.trackFileCount,
      "artist-delete evidence.trackFileCount",
    ),
    sizeOnDisk: requireNonNegativeSafeInteger(
      source.sizeOnDisk,
      "artist-delete evidence.sizeOnDisk",
    ),
  });
}

function sameDeleteEvidence(
  left: LidarrArtistDeleteEvidence,
  right: LidarrArtistDeleteEvidence,
): boolean {
  return (
    left.path === right.path &&
    left.albumCount === right.albumCount &&
    left.trackFileCount === right.trackFileCount &&
    left.sizeOnDisk === right.sizeOnDisk
  );
}

function requireCurrentArtist(current: LidarrPlanCurrentState): LidarrArtist {
  if ("foreignArtistId" in current) return current;
  throw validationError("present-artist operation received artist-delete existence state");
}

function requireDeleteObservedState(
  current: LidarrPlanCurrentState,
): LidarrArtistDeleteObservedState {
  if (!("kind" in current) || current.kind !== "artist-delete") {
    throw validationError("artist-delete operation requires an explicit existence state");
  }
  return current;
}

function requireSourceKind<TKind extends LidarrPlanEntrySource["kind"]>(
  source: LidarrPlanEntrySource,
  kind: TKind,
): Extract<LidarrPlanEntrySource, { readonly kind: TKind }> {
  if (source.kind !== kind) {
    throw validationError(`${kind} definition received an incompatible entry source`);
  }
  return source as Extract<LidarrPlanEntrySource, { readonly kind: TKind }>;
}

function validateSourceIdentity(source: Pick<LidarrPlanEntrySource, "artistId" | "artistName">): {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
} {
  const artistId = requirePositiveInteger(source.artistId, "entry source.artistId");
  return {
    id: `artist:${artistId}`,
    artistId,
    artistName: requireString(source.artistName, "entry source.artistName"),
  };
}

function hashIdempotencyMaterial(material: UnknownRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex")}`;
}

/** True only for the exact extended artist-add policy shape. */
export function isLidarrArtistAddExtendedOperation(
  operation: LidarrArtistAddOperationV2,
): operation is LidarrArtistAddExtendedOperationV2 {
  return "postAddUnmonitorSelectors" in operation;
}

/** True only for the exact extended artist-add entry shape. */
export function isLidarrArtistAddExtendedPlanEntry(
  entry: LidarrArtistAddPlanEntryV2,
): entry is LidarrArtistAddExtendedPlanEntryV2 {
  return "postAddUnmonitorSelectors" in entry.after;
}

function canonicalizeArtistAddSelectors(selectors: readonly string[]): readonly string[] {
  if (!Array.isArray(selectors) || selectors.length > MAX_ARTIST_ADD_SELECTORS) {
    throw validationError("artist-add postAddUnmonitorSelectors must be a bounded array");
  }
  return Object.freeze(
    [
      ...new Set(
        selectors.map((selector, index) => {
          const canonical = requireString(
            selector,
            `artist-add postAddUnmonitorSelectors[${index}]`,
          );
          if (!ARTIST_ADD_SELECTOR_ALLOWLIST.has(canonical)) {
            throw validationError(
              `artist-add postAddUnmonitorSelectors[${index}] is not a supported album type selector`,
            );
          }
          return canonical;
        }),
      ),
    ].sort(),
  );
}

function artistAddRisk(monitored: boolean, selectors: readonly string[]): LidarrPlanRiskSummary {
  return Object.freeze({
    level: "medium",
    destructive: false,
    cascade: Object.freeze([
      `The artist is added ${monitored ? "monitored" : "unmonitored"}.`,
      "New albums are not monitored automatically.",
      "No missing-album search is triggered.",
      ...(selectors.length === 0
        ? []
        : [
            `Post-add albums matching these sealed types are unmonitored: ${selectors.join(", ")}.`,
          ]),
    ]),
  });
}

/** Behavior needed to seal artist-add without exposing an executor or deferred intent. */
export interface LidarrArtistAddOperationDefinition {
  readonly kind: "artist-add";
  readonly operation: LidarrArtistAddOperationV2;
  readonly deferability: { readonly kind: "non-deferable" };
  canonicalize(): LidarrArtistAddOperationV2;
  risk(): LidarrPlanRiskSummary;
  referencedResources(): readonly LidarrArtistAddReferencedResource[];
  idempotencyKey(origin: string, entry: LidarrArtistAddPlanEntryV2): string;
}

/**
 * Resolves the non-deferable behavior owner for one artist-add operation.
 *
 * Execution is intentionally absent: apply owns possible-dispatch evidence
 * and exact-MBID reconciliation before it may call the private facade.
 */
export function getLidarrArtistAddOperationDefinition(
  input: LidarrArtistAddOperationV2,
): LidarrArtistAddOperationDefinition {
  const rootFolder = freezeRootFolderReference(input.rootFolder, "artist-add rootFolder");
  const qualityProfile = freezeProfileReference(input.qualityProfile, "artist-add qualityProfile");
  const metadataProfile = freezeProfileReference(
    input.metadataProfile,
    "artist-add metadataProfile",
  );
  if (input.monitorNewItems !== "none" || input.searchForMissingAlbums !== false) {
    throw validationError("artist-add operation policy is invalid");
  }
  const operation: LidarrArtistAddOperationV2 = isLidarrArtistAddExtendedOperation(input)
    ? Object.freeze({
        kind: "artist-add",
        rootFolder,
        qualityProfile,
        metadataProfile,
        monitored: requireBoolean(input.monitored, "artist-add monitored"),
        monitorNewItems: "none",
        searchForMissingAlbums: false,
        postAddUnmonitorSelectors: canonicalizeArtistAddSelectors(input.postAddUnmonitorSelectors),
      })
    : Object.freeze({
        kind: "artist-add",
        rootFolder,
        qualityProfile,
        metadataProfile,
        monitored: false,
        monitorNewItems: "none",
        searchForMissingAlbums: false,
      } satisfies LidarrArtistAddLegacyOperationV2);
  return Object.freeze({
    kind: operation.kind,
    operation,
    deferability: Object.freeze({ kind: "non-deferable" }),
    canonicalize: () =>
      isLidarrArtistAddExtendedOperation(operation)
        ? {
            ...operation,
            rootFolder: { ...operation.rootFolder },
            qualityProfile: { ...operation.qualityProfile },
            metadataProfile: { ...operation.metadataProfile },
            postAddUnmonitorSelectors: [...operation.postAddUnmonitorSelectors],
          }
        : {
            ...operation,
            rootFolder: { ...operation.rootFolder },
            qualityProfile: { ...operation.qualityProfile },
            metadataProfile: { ...operation.metadataProfile },
          },
    risk: () =>
      isLidarrArtistAddExtendedOperation(operation)
        ? artistAddRisk(operation.monitored, operation.postAddUnmonitorSelectors)
        : LIDARR_ARTIST_ADD_RISK,
    referencedResources: () =>
      Object.freeze([
        Object.freeze({ kind: "root-folder" as const, ...rootFolder }),
        Object.freeze({ kind: "quality-profile" as const, ...qualityProfile }),
        Object.freeze({ kind: "metadata-profile" as const, ...metadataProfile }),
      ]),
    idempotencyKey(origin: string, entry: LidarrArtistAddPlanEntryV2) {
      if (!CANONICAL_MUSICBRAINZ_ID_PATTERN.test(entry.foreignArtistId)) {
        throw validationError("artist-add entry foreignArtistId is invalid");
      }
      const material = {
        origin,
        operation: operation.kind,
        foreignArtistId: entry.foreignArtistId,
        rootFolderId: operation.rootFolder.id,
        rootFolderPath: operation.rootFolder.path,
        qualityProfileId: operation.qualityProfile.id,
        metadataProfileId: operation.metadataProfile.id,
        monitored: operation.monitored,
        monitorNewItems: "none",
        searchForMissingAlbums: false,
        ...(isLidarrArtistAddExtendedOperation(operation)
          ? {
              postAddUnmonitorSelectors: operation.postAddUnmonitorSelectors,
            }
          : {}),
      };
      if (
        isLidarrArtistAddExtendedOperation(operation) !== isLidarrArtistAddExtendedPlanEntry(entry)
      ) {
        throw validationError("artist-add operation and entry shapes are inconsistent");
      }
      return hashIdempotencyMaterial(material);
    },
  });
}

function exactPayloadMatch(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return false;
  }
  return expectedKeys.every((key) => {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    return Array.isArray(expectedValue) && Array.isArray(actualValue)
      ? expectedValue.length === actualValue.length &&
          expectedValue.every((item, index) => item === actualValue[index])
      : expectedValue === actualValue;
  });
}

function profileAssignmentPayload(
  artistId: number,
  operation: LidarrArtistProfileAssignmentOperation,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    artistId,
    ...(operation.qualityProfile === undefined
      ? {}
      : { qualityProfileId: operation.qualityProfile.id }),
    ...(operation.metadataProfile === undefined
      ? {}
      : { metadataProfileId: operation.metadataProfile.id }),
  });
}

function createProfileAssignmentInput(
  qualityProfileId: number | undefined,
  metadataProfileId: number | undefined,
): LidarrProfileAssignmentInput {
  if (qualityProfileId !== undefined) {
    return metadataProfileId === undefined
      ? { qualityProfileId }
      : { qualityProfileId, metadataProfileId };
  }
  if (metadataProfileId !== undefined) return { metadataProfileId };
  throw validationError("profile assignment must manage at least one profile");
}

function tagMutationPayload(
  artistId: number,
  operation: LidarrArtistTagMutationOperation,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    artistId,
    mode: operation.mode,
    tagIds: Object.freeze(operation.tags.map((reference) => reference.id)),
  });
}

async function executeDeferredMonitoringPayload(
  payload: Readonly<Record<string, unknown>>,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<void> {
  const record = requireRecord(payload, "deferred artist-monitoring payload");
  requireExactKeys(record, "deferred artist-monitoring payload", ["artistId", "monitored"]);
  assertNoSensitiveKeys(record, "deferred artist-monitoring payload");
  const artistId = requirePositiveInteger(
    record["artistId"],
    "deferred artist-monitoring payload.artistId",
  );
  const monitored = requireBoolean(
    record["monitored"],
    "deferred artist-monitoring payload.monitored",
  );
  await client.setArtistsMonitored([artistId], monitored, signal);
}

async function executeDeferredProfilePayload(
  payload: Readonly<Record<string, unknown>>,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<void> {
  const path = "deferred artist-profile-assignment payload";
  const record = requireRecord(payload, path);
  requireExactKeys(record, path, ["artistId"], ["qualityProfileId", "metadataProfileId"]);
  assertNoSensitiveKeys(record, path);
  const artistId = requirePositiveInteger(record["artistId"], `${path}.artistId`);
  const qualityProfileId =
    record["qualityProfileId"] === undefined
      ? undefined
      : requirePositiveInteger(record["qualityProfileId"], `${path}.qualityProfileId`);
  const metadataProfileId =
    record["metadataProfileId"] === undefined
      ? undefined
      : requirePositiveInteger(record["metadataProfileId"], `${path}.metadataProfileId`);
  if (qualityProfileId === undefined && metadataProfileId === undefined) {
    throw validationError(`${path} must manage at least one profile`);
  }
  await client.setArtistProfiles(
    artistId,
    createProfileAssignmentInput(qualityProfileId, metadataProfileId),
    signal,
  );
}

async function executeDeferredTagPayload(
  payload: Readonly<Record<string, unknown>>,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<void> {
  const path = "deferred artist-tag-mutation payload";
  const record = requireRecord(payload, path);
  requireExactKeys(record, path, ["artistId", "mode", "tagIds"]);
  assertNoSensitiveKeys(record, path);
  const artistId = requirePositiveInteger(record["artistId"], `${path}.artistId`);
  const mode = record["mode"];
  if (mode !== "add" && mode !== "remove" && mode !== "set" && mode !== "clear") {
    throw validationError(`${path}.mode is invalid`);
  }
  const tagIds = requireSortedPositiveIds(record["tagIds"], `${path}.tagIds`);
  if ((mode === "clear" && tagIds.length !== 0) || (mode !== "clear" && tagIds.length === 0)) {
    throw validationError(`${path}.tagIds are inconsistent with mode`);
  }
  await client.updateArtistTags(artistId, { mode, tagIds }, signal);
}

function createMonitoringDefinition(
  input: LidarrArtistMonitoringOperation,
): LidarrDeferableMutationOperationDefinitionFor<"artist-monitoring"> {
  const operation = Object.freeze({
    kind: "artist-monitoring",
    desiredMonitored: requireBoolean(
      input.desiredMonitored,
      "artist-monitoring operation.desiredMonitored",
    ),
  }) satisfies LidarrArtistMonitoringOperation;
  const definition: LidarrDeferableMutationOperationDefinitionFor<"artist-monitoring"> = {
    kind: operation.kind,
    operation,
    deferability: Object.freeze({
      kind: "deferable",
      operation: LIDARR_ARTIST_MONITORING_OPERATION,
    }),
    canonicalize: () => ({ ...operation }),
    risk: () => ARTIST_MONITORING_RISK,
    referencedResources: () => Object.freeze([]),
    buildEntry(origin, source) {
      const monitoringSource = requireSourceKind(source, "artist-monitoring");
      const identity = validateSourceIdentity(monitoringSource);
      const entry: LidarrArtistMonitoringPlanEntry = {
        ...identity,
        before: { monitored: monitoringSource.monitored },
        after: { monitored: operation.desiredMonitored },
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entry,
        idempotencyKey: definition.idempotencyKey(origin, entry),
      });
    },
    hasChange(entry) {
      const monitoringEntry = requireMonitoringEntry(entry);
      return monitoringEntry.before.monitored !== monitoringEntry.after.monitored;
    },
    summarize(entries) {
      const monitoringEntries = entries.map(requireMonitoringEntry);
      return Object.freeze({
        kind: operation.kind,
        monitoredBefore: monitoringEntries.filter((entry) => entry.before.monitored).length,
        monitoredAfter: monitoringEntries.filter((entry) => entry.after.monitored).length,
      });
    },
    payloadFor(entry) {
      const monitoringEntry = requireMonitoringEntry(entry);
      return Object.freeze({
        artistId: monitoringEntry.artistId,
        monitored: operation.desiredMonitored,
      });
    },
    idempotencyKey(origin, entry) {
      return hashIdempotencyMaterial({
        origin,
        operation: operation.kind,
        artistId: entry.artistId,
        desiredMonitored: operation.desiredMonitored,
      });
    },
    classifyLive(entry, current) {
      const monitoringEntry = requireMonitoringEntry(entry);
      const artist = requireCurrentArtist(current);
      const observed = Object.freeze({
        kind: operation.kind,
        monitored: artist.monitored,
      }) satisfies LidarrPlanLiveState;
      if (artist.monitored === operation.desiredMonitored) {
        return { state: "satisfied", observed };
      }
      return artist.monitored === monitoringEntry.before.monitored
        ? { state: "ready", observed }
        : {
            state: "drifted",
            observed,
            message: `Artist ${entry.artistId} monitoring state changed after planning`,
          };
    },
    classify(entry, current) {
      return definition.classifyLive(entry, current).state;
    },
    verify(_entry, current) {
      return requireCurrentArtist(current).monitored === operation.desiredMonitored;
    },
    async execute(entry, client, signal) {
      await client.setArtistsMonitored([entry.artistId], operation.desiredMonitored, signal);
    },
    executeDeferredPayload: executeDeferredMonitoringPayload,
    matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
      return (
        queuedOperation === definition.deferability.operation &&
        exactPayloadMatch(definition.payloadFor(entry), queuedPayload)
      );
    },
  };
  return Object.freeze(definition);
}

function createProfileDefinition(
  input: LidarrArtistProfileAssignmentOperation,
): LidarrDeferableMutationOperationDefinitionFor<"artist-profile-assignment"> {
  const qualityProfile =
    input.qualityProfile === undefined
      ? undefined
      : freezeProfileReference(input.qualityProfile, "profile operation.qualityProfile");
  const metadataProfile =
    input.metadataProfile === undefined
      ? undefined
      : freezeProfileReference(input.metadataProfile, "profile operation.metadataProfile");
  if (qualityProfile === undefined && metadataProfile === undefined) {
    throw validationError("profile operation must manage at least one profile");
  }
  const operation = Object.freeze({
    kind: "artist-profile-assignment",
    ...(qualityProfile === undefined ? {} : { qualityProfile }),
    ...(metadataProfile === undefined ? {} : { metadataProfile }),
  }) satisfies LidarrArtistProfileAssignmentOperation;
  const definition: LidarrDeferableMutationOperationDefinitionFor<"artist-profile-assignment"> = {
    kind: operation.kind,
    operation,
    deferability: Object.freeze({
      kind: "deferable",
      operation: LIDARR_ARTIST_PROFILE_ASSIGNMENT_OPERATION,
    }),
    canonicalize: () => ({ ...operation }),
    risk: () => ARTIST_PROFILE_ASSIGNMENT_RISK,
    referencedResources: () =>
      Object.freeze([
        ...(operation.qualityProfile === undefined
          ? []
          : [
              Object.freeze({
                kind: "quality-profile" as const,
                ...operation.qualityProfile,
              }),
            ]),
        ...(operation.metadataProfile === undefined
          ? []
          : [
              Object.freeze({
                kind: "metadata-profile" as const,
                ...operation.metadataProfile,
              }),
            ]),
      ]),
    buildEntry(origin, source) {
      const profileSource = requireSourceKind(source, "artist-profile-assignment");
      const identity = validateSourceIdentity(profileSource);
      const before = Object.freeze({
        ...(operation.qualityProfile === undefined
          ? {}
          : {
              qualityProfile: freezeProfileReference(
                requireProfileSourceReference(
                  profileSource.qualityProfile,
                  "entry source.qualityProfile",
                ),
                "entry source.qualityProfile",
              ),
            }),
        ...(operation.metadataProfile === undefined
          ? {}
          : {
              metadataProfile: freezeProfileReference(
                requireProfileSourceReference(
                  profileSource.metadataProfile,
                  "entry source.metadataProfile",
                ),
                "entry source.metadataProfile",
              ),
            }),
      });
      const after = Object.freeze({
        ...(operation.qualityProfile === undefined
          ? {}
          : { qualityProfile: operation.qualityProfile }),
        ...(operation.metadataProfile === undefined
          ? {}
          : { metadataProfile: operation.metadataProfile }),
      });
      const entry: LidarrArtistProfilePlanEntry = {
        ...identity,
        before,
        after,
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entry,
        idempotencyKey: definition.idempotencyKey(origin, entry),
      });
    },
    hasChange(entry) {
      const profileEntry = requireProfileEntry(entry);
      return (
        (operation.qualityProfile !== undefined &&
          profileEntry.before.qualityProfile?.id !== operation.qualityProfile.id) ||
        (operation.metadataProfile !== undefined &&
          profileEntry.before.metadataProfile?.id !== operation.metadataProfile.id)
      );
    },
    summarize(entries) {
      const profileEntries = entries.map(requireProfileEntry);
      return Object.freeze({
        kind: operation.kind,
        qualityProfileChanged:
          operation.qualityProfile === undefined
            ? 0
            : profileEntries.filter(
                (entry) =>
                  !sameResourceReference(entry.before.qualityProfile, entry.after.qualityProfile),
              ).length,
        metadataProfileChanged:
          operation.metadataProfile === undefined
            ? 0
            : profileEntries.filter(
                (entry) =>
                  !sameResourceReference(entry.before.metadataProfile, entry.after.metadataProfile),
              ).length,
      });
    },
    payloadFor(entry) {
      requireProfileEntry(entry);
      return profileAssignmentPayload(entry.artistId, operation);
    },
    idempotencyKey(origin, entry) {
      return hashIdempotencyMaterial({
        origin,
        operation: operation.kind,
        ...profileAssignmentPayload(entry.artistId, operation),
      });
    },
    classifyLive(entry, current) {
      const profileEntry = requireProfileEntry(entry);
      const artist = requireCurrentArtist(current);
      const observed = Object.freeze({
        kind: operation.kind,
        ...(operation.qualityProfile === undefined
          ? {}
          : { qualityProfileId: artist.qualityProfileId }),
        ...(operation.metadataProfile === undefined
          ? {}
          : { metadataProfileId: artist.metadataProfileId }),
      }) satisfies LidarrPlanLiveState;
      const qualitySatisfied =
        operation.qualityProfile === undefined ||
        artist.qualityProfileId === operation.qualityProfile.id;
      const metadataSatisfied =
        operation.metadataProfile === undefined ||
        artist.metadataProfileId === operation.metadataProfile.id;
      if (qualitySatisfied && metadataSatisfied) return { state: "satisfied", observed };
      const qualitySafe =
        operation.qualityProfile === undefined ||
        artist.qualityProfileId === profileEntry.before.qualityProfile?.id ||
        qualitySatisfied;
      const metadataSafe =
        operation.metadataProfile === undefined ||
        artist.metadataProfileId === profileEntry.before.metadataProfile?.id ||
        metadataSatisfied;
      return qualitySafe && metadataSafe
        ? { state: "ready", observed }
        : {
            state: "drifted",
            observed,
            message: `Artist ${entry.artistId} managed profile state changed after planning`,
          };
    },
    classify(entry, current) {
      return definition.classifyLive(entry, current).state;
    },
    verify(entry, current) {
      return definition.classifyLive(entry, current).state === "satisfied";
    },
    async execute(entry, client, signal) {
      requireProfileEntry(entry);
      const payload = profileAssignmentPayload(entry.artistId, operation);
      await client.setArtistProfiles(
        entry.artistId,
        createProfileAssignmentInput(
          typeof payload["qualityProfileId"] === "number" ? payload["qualityProfileId"] : undefined,
          typeof payload["metadataProfileId"] === "number"
            ? payload["metadataProfileId"]
            : undefined,
        ),
        signal,
      );
    },
    executeDeferredPayload: executeDeferredProfilePayload,
    matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
      return (
        queuedOperation === definition.deferability.operation &&
        exactPayloadMatch(definition.payloadFor(entry), queuedPayload)
      );
    },
  };
  return Object.freeze(definition);
}

function createTagDefinition(
  input: LidarrArtistTagMutationOperation,
): LidarrDeferableMutationOperationDefinitionFor<"artist-tag-mutation"> {
  if (
    input.mode !== "add" &&
    input.mode !== "remove" &&
    input.mode !== "set" &&
    input.mode !== "clear"
  ) {
    throw validationError("tag operation mode is invalid");
  }
  const tags = freezeTagReferences(input.tags, "tag operation.tags");
  if (
    (input.mode === "clear" && tags.length !== 0) ||
    (input.mode !== "clear" && tags.length === 0)
  ) {
    throw validationError("tag operation tags are inconsistent with mode");
  }
  const operation = Object.freeze({
    kind: "artist-tag-mutation",
    mode: input.mode,
    tags,
  }) satisfies LidarrArtistTagMutationOperation;
  const requestedIds = Object.freeze(operation.tags.map((reference) => reference.id));
  const definition: LidarrDeferableMutationOperationDefinitionFor<"artist-tag-mutation"> = {
    kind: operation.kind,
    operation,
    deferability: Object.freeze({
      kind: "deferable",
      operation: LIDARR_ARTIST_TAG_MUTATION_OPERATION,
    }),
    canonicalize: () => ({ ...operation, tags: [...operation.tags] }),
    risk: () =>
      operation.mode === "set" || operation.mode === "clear"
        ? ARTIST_TAG_REPLACEMENT_RISK
        : ARTIST_TAG_DELTA_RISK,
    referencedResources: () =>
      Object.freeze(
        operation.tags.map((tag) =>
          Object.freeze({ kind: "tag" as const, id: tag.id, label: tag.label }),
        ),
      ),
    buildEntry(origin, source) {
      const tagSource = requireSourceKind(source, "artist-tag-mutation");
      const identity = validateSourceIdentity(tagSource);
      const before = freezeTagReferences(tagSource.tags, "entry source.tags");
      const after = freezeTagReferences(calculateTagAfter(before, operation), "entry after.tags");
      const delta = calculateTagDelta(before, after);
      const entry: LidarrArtistTagMutationPlanEntry = {
        ...identity,
        before: Object.freeze({ tags: before }),
        after: Object.freeze({ tags: after }),
        added: Object.freeze(delta.added),
        removed: Object.freeze(delta.removed),
        retained: Object.freeze(delta.retained),
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entry,
        idempotencyKey: definition.idempotencyKey(origin, entry),
      });
    },
    hasChange(entry) {
      const tagEntry = requireTagEntry(entry);
      return !sameTagIds(
        tagEntry.before.tags.map((reference) => reference.id),
        tagEntry.after.tags.map((reference) => reference.id),
      );
    },
    summarize(entries) {
      const tagEntries = entries.map(requireTagEntry);
      return Object.freeze(
        tagEntries.reduce(
          (summary, entry) => ({
            kind: operation.kind,
            added: summary.added + entry.added.length,
            removed: summary.removed + entry.removed.length,
            retained: summary.retained + entry.retained.length,
          }),
          { kind: operation.kind, added: 0, removed: 0, retained: 0 },
        ),
      );
    },
    payloadFor(entry) {
      requireTagEntry(entry);
      return tagMutationPayload(entry.artistId, operation);
    },
    idempotencyKey(origin, entry) {
      return hashIdempotencyMaterial({
        origin,
        operation: operation.kind,
        ...tagMutationPayload(entry.artistId, operation),
      });
    },
    classifyLive(entry, current) {
      const tagEntry = requireTagEntry(entry);
      const currentIds = Object.freeze([...requireCurrentArtist(current).tags]);
      const observed = Object.freeze({
        kind: operation.kind,
        tagIds: currentIds,
      }) satisfies LidarrPlanLiveState;
      const currentSet = new Set(currentIds);
      if (operation.mode === "add") {
        return requestedIds.every((id) => currentSet.has(id))
          ? { state: "satisfied", observed }
          : { state: "ready", observed };
      }
      if (operation.mode === "remove") {
        return requestedIds.every((id) => !currentSet.has(id))
          ? { state: "satisfied", observed }
          : { state: "ready", observed };
      }
      const beforeIds = tagEntry.before.tags.map((reference) => reference.id);
      const afterIds = tagEntry.after.tags.map((reference) => reference.id);
      if (sameTagIds(currentIds, afterIds)) return { state: "satisfied", observed };
      return sameTagIds(currentIds, beforeIds)
        ? { state: "ready", observed }
        : {
            state: "drifted",
            observed,
            message: `Artist ${entry.artistId} tag set changed after planning`,
          };
    },
    classify(entry, current) {
      return definition.classifyLive(entry, current).state;
    },
    verify(entry, current) {
      return definition.classifyLive(entry, current).state === "satisfied";
    },
    async execute(entry, client, signal) {
      requireTagEntry(entry);
      await client.updateArtistTags(
        entry.artistId,
        { mode: operation.mode, tagIds: requestedIds },
        signal,
      );
    },
    executeDeferredPayload: executeDeferredTagPayload,
    matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
      return (
        queuedOperation === definition.deferability.operation &&
        exactPayloadMatch(definition.payloadFor(entry), queuedPayload)
      );
    },
  };
  return Object.freeze(definition);
}

function createArtistDeleteDefinition(
  input: LidarrArtistDeleteOperation,
): LidarrNonDeferableMutationOperationDefinition {
  const operation = Object.freeze({
    kind: "artist-delete",
    deleteFiles: requireBoolean(input.deleteFiles, "artist-delete operation.deleteFiles"),
  }) satisfies LidarrArtistDeleteOperation;
  const definition: LidarrNonDeferableMutationOperationDefinition = {
    kind: operation.kind,
    operation,
    deferability: Object.freeze({ kind: "non-deferable" }),
    canonicalize: () => ({ ...operation }),
    risk: () => ARTIST_DELETE_RISK,
    referencedResources: () => Object.freeze([]),
    buildEntry(origin, source) {
      const deleteSource = requireSourceKind(source, "artist-delete");
      const identity = validateSourceIdentity(deleteSource);
      const entry: LidarrArtistDeletePlanEntry = {
        ...identity,
        before: deleteEvidence(deleteSource),
        after: Object.freeze({ exists: false }),
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entry,
        idempotencyKey: definition.idempotencyKey(origin, entry),
      });
    },
    hasChange(entry) {
      requireDeleteEntry(entry);
      return true;
    },
    summarize(entries) {
      const deleteEntries = entries.map(requireDeleteEntry);
      return Object.freeze(
        deleteEntries.reduce(
          (summary, entry) => ({
            kind: operation.kind,
            artists: summary.artists + 1,
            albums: summary.albums + entry.before.albumCount,
            trackFiles: summary.trackFiles + entry.before.trackFileCount,
            sizeOnDisk: summary.sizeOnDisk + entry.before.sizeOnDisk,
          }),
          { kind: operation.kind, artists: 0, albums: 0, trackFiles: 0, sizeOnDisk: 0 },
        ),
      );
    },
    payloadFor(entry) {
      const deleteEntry = requireDeleteEntry(entry);
      return Object.freeze({
        artistId: deleteEntry.artistId,
        deleteFiles: operation.deleteFiles,
      });
    },
    idempotencyKey(origin, entry) {
      return hashIdempotencyMaterial({
        origin,
        operation: operation.kind,
        ...definition.payloadFor(entry),
      });
    },
    classifyLive(entry, current) {
      const deleteEntry = requireDeleteEntry(entry);
      const observed = requireDeleteObservedState(current);
      if (!observed.exists) return { state: "satisfied", observed };
      if (sameDeleteEvidence(deleteEntry.before, observed.evidence)) {
        return { state: "ready", observed };
      }
      const changed = (["path", "albumCount", "trackFileCount", "sizeOnDisk"] as const).filter(
        (key) => deleteEntry.before[key] !== observed.evidence[key],
      );
      return {
        state: "drifted",
        observed,
        message: `Artist ${entry.artistId} deletion evidence changed after planning: ${changed.join(", ")}`,
      };
    },
    classify(entry, current) {
      return definition.classifyLive(entry, current).state;
    },
    verify(_entry, current) {
      return !requireDeleteObservedState(current).exists;
    },
    async execute(entry, client, signal) {
      const deleteEntry = requireDeleteEntry(entry);
      await client.deleteArtist(deleteEntry.artistId, operation.deleteFiles, signal);
    },
  };
  return Object.freeze(definition);
}

function requireProfileSourceReference(
  reference: LidarrPlanResourceReference | undefined,
  path: string,
): LidarrPlanResourceReference {
  if (reference === undefined) throw validationError(`${path} is required`);
  return reference;
}

function sameTagIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Resolves the typed behavior owner for an allowlisted plan operation. */
export function getLidarrMutationOperationDefinition(
  operation:
    | LidarrArtistMonitoringOperation
    | LidarrArtistProfileAssignmentOperation
    | LidarrArtistTagMutationOperation,
): LidarrDeferableMutationOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrArtistDeleteOperation,
): LidarrNonDeferableMutationOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrMutationOperationV2,
): LidarrMutationOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrMutationOperationV2,
): LidarrMutationOperationDefinition {
  switch (operation.kind) {
    case "artist-monitoring":
      return createMonitoringDefinition(operation);
    case "artist-profile-assignment":
      return createProfileDefinition(operation);
    case "artist-tag-mutation":
      return createTagDefinition(operation);
    case "artist-delete":
      return createArtistDeleteDefinition(operation);
  }
}

/** Returns the explicit, allowlisted deferred executors shipped by this plan version. */
export function createLidarrMutationExecutors(): ReadonlyMap<string, LidarrIntentExecutor> {
  return new Map<string, LidarrIntentExecutor>([
    [
      LIDARR_ARTIST_MONITORING_OPERATION,
      Object.freeze({
        operation: LIDARR_ARTIST_MONITORING_OPERATION,
        execute: executeDeferredMonitoringPayload,
      }),
    ],
    [
      LIDARR_ARTIST_PROFILE_ASSIGNMENT_OPERATION,
      Object.freeze({
        operation: LIDARR_ARTIST_PROFILE_ASSIGNMENT_OPERATION,
        execute: executeDeferredProfilePayload,
      }),
    ],
    [
      LIDARR_ARTIST_TAG_MUTATION_OPERATION,
      Object.freeze({
        operation: LIDARR_ARTIST_TAG_MUTATION_OPERATION,
        execute: executeDeferredTagPayload,
      }),
    ],
  ]);
}

export function sameResourceReference(
  left: LidarrPlanResourceReference | undefined,
  right: LidarrPlanResourceReference | undefined,
): boolean {
  return left?.id === right?.id && left?.name === right?.name;
}

export function calculateTagAfter(
  before: readonly LidarrPlanTagReference[],
  operation: LidarrArtistTagMutationOperation,
): readonly LidarrPlanTagReference[] {
  const beforeById = new Map(before.map((reference) => [reference.id, reference]));
  const requestedById = new Map(operation.tags.map((reference) => [reference.id, reference]));
  switch (operation.mode) {
    case "add":
      return [...new Map([...beforeById, ...requestedById]).values()].sort(
        (left, right) => left.id - right.id,
      );
    case "remove":
      return before.filter((reference) => !requestedById.has(reference.id));
    case "set":
      return operation.tags;
    case "clear":
      return [];
  }
}

export function calculateTagDelta(
  before: readonly LidarrPlanTagReference[],
  after: readonly LidarrPlanTagReference[],
): {
  readonly added: readonly LidarrPlanTagReference[];
  readonly removed: readonly LidarrPlanTagReference[];
  readonly retained: readonly LidarrPlanTagReference[];
} {
  const beforeIds = new Set(before.map((reference) => reference.id));
  const afterIds = new Set(after.map((reference) => reference.id));
  return {
    added: after.filter((reference) => !beforeIds.has(reference.id)),
    removed: before.filter((reference) => !afterIds.has(reference.id)),
    retained: after.filter((reference) => beforeIds.has(reference.id)),
  };
}
