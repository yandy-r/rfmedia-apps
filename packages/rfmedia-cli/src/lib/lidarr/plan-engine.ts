/** Hardened artifact, history, and claim engine for Lidarr mutation plans. */

import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { hostname as nodeHostname, userInfo } from "node:os";
import { join, resolve } from "node:path";

import pkg from "../../../package.json" with { type: "json" };
import {
  LidarrPlanAlreadyRunningError,
  LidarrPlanArtifactError,
  LidarrPlanValidationError,
} from "../errors.js";
import {
  LIDARR_DISCOVER_MAX_DEPTH,
  LIDARR_DISCOVER_MAX_EXPOSURE_COUNT,
  LIDARR_DISCOVER_MAX_LIMIT,
  LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
} from "../../types/discovery.js";
import {
  LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES,
  LIDARR_PLAN_MAX_BATCH,
  LIDARR_PLAN_MAX_BYTES,
  LIDARR_PLAN_MAX_ENTRIES,
  LIDARR_PLAN_VERSION,
  LIDARR_PLAN_VERSION_V2,
  LIDARR_PLAN_VERSION_V3,
  LIDARR_CASCADE_MODEL_VERSION,
  type LidarrAlbumMonitoringPlanV3,
  type LidarrAlbumMutationPlanV3,
  type LidarrArtistAddExtendedPlanEntryV2,
  type LidarrArtistAddExtendedPlanV2,
  type LidarrArtistAddLegacyPlanEntryV2,
  type LidarrArtistAddLegacyPlanV2,
  type LidarrArtistAddNormalizationPendingHistoryRecord,
  type LidarrArtistAddNormalizationVerificationPendingHistoryRecord,
  type LidarrArtistAddOperationV2,
  type LidarrArtistAddPlanHistoryRecord,
  type LidarrArtistAddPlanEntryV2,
  type LidarrArtistAddPlanV2,
  type LidarrArtistAddPlanV3,
  type LidarrArtistAddPossibleDispatchHistoryRecord,
  type LidarrArtistAddProvenanceV2,
  type LidarrAlbumMonitoringOperation,
  type LidarrAlbumMonitoringPlanEntry,
  type LidarrAlbumMutationPlanEntryV2,
  type LidarrAlbumMutationPlanV2,
  type LidarrAlbumPlanApplyEntryResult,
  type LidarrAlbumPlanHistoryRecord,
  type LidarrArtistProfileAssignmentOperation,
  type LidarrArtistProfilePlanEntry,
  type LidarrArtistDeleteOperation,
  type LidarrArtistDeleteEvidence,
  type LidarrArtistDeletePlanEntry,
  type LidarrArtistDeletePossibleDispatchHistoryRecord,
  type LidarrArtistMonitoringOperation,
  type LidarrArtistMonitoringPlanEntry,
  type LidarrArtistPlanApplyEntryResult,
  type LidarrArtistPlanHistoryRecord,
  type LidarrArtistTagMutationOperation,
  type LidarrArtistTagMutationPlanEntry,
  type LidarrMutationPlan,
  type LidarrMutationOperation,
  type LidarrMutationOperationV2,
  type LidarrMutationOperationV2Extended,
  type LidarrMutationPlanEntry,
  type LidarrMutationPlanEntryV2,
  type LidarrMutationPlanEntryV2Extended,
  type LidarrMutationPlanV1,
  type LidarrPlanApplyEntryResult,
  type LidarrMutationPlanV2,
  type LidarrMutationPlanV3,
  type LidarrCascadeAnalysis,
  type LidarrCascadeBasisCode,
  type LidarrCascadeBudgetAssessment,
  type LidarrCascadeMetric,
  type LidarrCascadePolicy,
  type LidarrCascadeRecommendationCode,
  type LidarrCascadeWarning,
  type LidarrPlanV3,
  type LidarrPlanCreatedBy,
  type LidarrPlanHistoryOutcome,
  type LidarrPlanHistoryRecord,
  type LidarrPlanOperationSummaryV2,
  type LidarrPlanOperationSummaryV2Extended,
  type LidarrPlanResourceReference,
  type LidarrPlanRootFolderReference,
  type LidarrPlanRiskSummary,
  type LidarrPlanStalenessFinding,
  type LidarrPlanSelectionV2,
  type LidarrPlanSelectionV2Extended,
  type LidarrPlanTagReference,
  type LidarrTrackFileFilterOperationV2,
  type LidarrTrackFileFilterPlanEntryV2,
  type LidarrTrackFileFilterPlanV2,
  type LidarrTrackFileFilterPlanEntryV3,
  type LidarrTrackFileFilterPlanV3,
} from "../../types/lidarr-plan.js";
import type { LidarrClientApi } from "./client.js";
import type { LidarrIntentExecutor } from "./deferred-queue.js";
import { getDefaultPlanDir } from "../plan.js";
import {
  acquireExclusiveLock,
  createPrivateFileAtomically,
  readBoundedPrivateFile,
  replacePrivateFileAtomically,
  SECURE_STORE_MAX_PATH_LENGTH as MAX_PATH_LENGTH,
  SECURE_STORE_UUID_PATTERN as UUID_PATTERN,
  SecureStoreError,
} from "../secure-store/index.js";
import type { FileIdentity, SecureStoreLock } from "../secure-store/index.js";
import {
  calculateTagAfter,
  calculateTagDelta,
  createLidarrMutationExecutors as createV2LidarrMutationExecutors,
  getLidarrMutationOperationDefinition as getV2LidarrMutationOperationDefinition,
  getLidarrArtistAddOperationDefinition,
  isLidarrArtistAddExtendedOperation,
  isLidarrArtistAddExtendedPlanEntry,
  LIDARR_ARTIST_MONITORING_OPERATION,
  sameResourceReference,
  type LidarrArtistAddReferencedResource,
  type LidarrDeferableMutationOperationDefinition as LidarrDeferableMutationOperationDefinitionV2,
  type LidarrMutationOperationDefinition as LidarrMutationOperationDefinitionV2,
  type LidarrNonDeferableMutationOperationDefinition as LidarrNonDeferableMutationOperationDefinitionV2,
  type LidarrPlanEntryClassification,
  type LidarrPlanEntrySource,
  type LidarrPlanReferencedResource,
} from "./plan-operation-definitions.js";
// CIRCULARITY GUARD: plan-album-operations.ts imports this engine's sealing
// helpers while the engine imports the album validators below. The cycle is
// safe only because BOTH modules reference the other's bindings exclusively
// inside function bodies — never during module evaluation — so no ESM
// temporal-dead-zone read can occur regardless of load order. Keep it that
// way: no top-level calls into plan-album-operations.js from this module.
import {
  assertLidarrAlbumPlanSummary,
  canonicalizeLidarrAlbumMutationPlanEntry,
  canonicalizeLidarrAlbumPlanSelection,
  canonicalizeLidarrAlbumPlanSummary,
  createLidarrAlbumMutationExecutors,
  getLidarrAlbumMutationOperationDefinition,
  requireAlbumDeleteEntry,
  requireAlbumDeleteOperation,
  requireAlbumEditEntry,
  requireAlbumEditOperation,
  requireLidarrAlbumPlanSelection,
} from "./plan-album-operations.js";
import {
  LIDARR_TRACK_FILTER_RISK,
  assertLidarrTrackFilterSummary,
  canonicalizeLidarrTrackFilterPlanEntry,
  requireLidarrTrackFilterEntry,
  requireLidarrTrackFilterOperation,
  requireLidarrTrackFilterSelection,
  trackFilterIdempotencyKey,
} from "./plan-track-filter-operations.js";
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
import { LIDARR_ALBUM_TYPE_SELECTORS } from "./album-types.js";
import { analyzeLidarrCascade, type LidarrCascadePlanFacts } from "./cascade-analysis.js";

export {
  LIDARR_ARTIST_MONITORING_OPERATION,
  LIDARR_ARTIST_PROFILE_ASSIGNMENT_OPERATION,
  LIDARR_ARTIST_TAG_MUTATION_OPERATION,
} from "./plan-operation-definitions.js";
export type {
  LidarrDeferableMutationOperationDefinition as LidarrDeferableMutationOperationDefinitionV2,
  LidarrMutationOperationDefinition as LidarrMutationOperationDefinitionV2,
  LidarrNonDeferableMutationOperationDefinition as LidarrNonDeferableMutationOperationDefinitionV2,
  LidarrPlanEntryClassification,
  LidarrPlanEntrySource,
  LidarrPlanLiveClassification,
  LidarrPlanLiveState,
  LidarrPlanReferencedResource,
} from "./plan-operation-definitions.js";

/** Every plan family accepted by shared artifact/checksum storage. */
export type LidarrStoredMutationPlan =
  | LidarrMutationPlan
  | LidarrArtistAddPlanV2
  | LidarrAlbumMutationPlanV2
  | LidarrTrackFileFilterPlanV2
  | LidarrPlanV3;

const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANONICAL_MUSICBRAINZ_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
export const LIDARR_ALBUM_MONITORING_OPERATION = "lidarr.album-monitoring";
const MAX_RISK_CASCADE_ITEMS = 20;

export interface LidarrPlanSourceEntry {
  readonly artistId: number;
  readonly artistName: string;
  readonly monitored: boolean;
}

export interface LidarrAlbumPlanSourceEntry {
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly albumType?: string;
  readonly monitored: boolean;
}

export interface BuildLidarrArtistMutationPlanInput {
  readonly origin: string;
  readonly operation: LidarrArtistMonitoringOperation;
  readonly maxBatch: number;
  readonly entries: readonly LidarrPlanSourceEntry[];
}

export interface BuildLidarrAlbumMutationPlanInput {
  readonly origin: string;
  readonly operation: LidarrAlbumMonitoringOperation;
  readonly maxBatch: number;
  readonly entries: readonly LidarrAlbumPlanSourceEntry[];
}

export type BuildLidarrMutationPlanInput =
  | BuildLidarrArtistMutationPlanInput
  | BuildLidarrAlbumMutationPlanInput;

/**
 * Structural narrowing guards: the widened per-kind unions carry no `kind`
 * discriminant (the exact-allowlist validator forbids new keys on artist
 * shapes), so `"albumId" in value` is the sanctioned narrowing tool.
 */
export function isLidarrAlbumPlanEntry(
  entry: LidarrMutationPlanEntry,
): entry is LidarrAlbumMonitoringPlanEntry {
  return "albumId" in entry;
}

export function isLidarrArtistPlanEntry(
  entry: LidarrMutationPlanEntry,
): entry is LidarrArtistMonitoringPlanEntry {
  return !("albumId" in entry);
}

export function isLidarrAlbumApplyEntryResult(
  result: LidarrPlanApplyEntryResult,
): result is LidarrAlbumPlanApplyEntryResult {
  return "albumId" in result;
}

export function isLidarrArtistApplyEntryResult(
  result: LidarrPlanApplyEntryResult,
): result is LidarrArtistPlanApplyEntryResult {
  return !("albumId" in result);
}

export function isLidarrAlbumPlanHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrAlbumPlanHistoryRecord {
  return "albumId" in record;
}

export function isLidarrArtistPlanHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrArtistPlanHistoryRecord {
  return (
    !("albumId" in record) &&
    !("foreignArtistId" in record) &&
    record.outcome !== "possibly-dispatched"
  );
}

/** Narrows durable pre-dispatch evidence from terminal plan history. */
export function isLidarrArtistDeletePossibleDispatchHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrArtistDeletePossibleDispatchHistoryRecord {
  return record.outcome === "possibly-dispatched" && "artistId" in record;
}

/** Narrows terminal history for a foreign-ID artist-add target. */
export function isLidarrArtistAddPlanHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrArtistAddPlanHistoryRecord {
  return (
    "foreignArtistId" in record &&
    record.outcome !== "possibly-dispatched" &&
    record.outcome !== "creation-verified-normalization-pending" &&
    record.outcome !== "normalization-verification-pending"
  );
}

/** Narrows durable pre-dispatch evidence for a foreign-ID artist creation. */
export function isLidarrArtistAddPossibleDispatchHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrArtistAddPossibleDispatchHistoryRecord {
  return record.outcome === "possibly-dispatched" && "foreignArtistId" in record;
}

/** Narrows durable artist creation evidence with normalization still pending. */
export function isLidarrArtistAddNormalizationPendingHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrArtistAddNormalizationPendingHistoryRecord {
  return record.outcome === "creation-verified-normalization-pending";
}

/** Narrows durable album-mutation evidence awaiting fresh verification. */
export function isLidarrArtistAddNormalizationVerificationPendingHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrArtistAddNormalizationVerificationPendingHistoryRecord {
  return record.outcome === "normalization-verification-pending";
}

/** Operation-neutral input for constructing one strict v2 Lidarr mutation plan. */
export interface BuildLidarrMutationPlanV2Input {
  readonly origin: string;
  readonly selection: LidarrPlanSelectionV2;
  readonly operation: LidarrMutationOperationV2;
  readonly maxBatch: number;
  readonly entries: readonly LidarrPlanEntrySource[];
}

/** Ordinary artist v3 input with an already resolved, credential-free policy. */
export interface BuildLidarrMutationPlanV3Input extends BuildLidarrMutationPlanV2Input {
  readonly cascadePolicy: LidarrCascadePolicy;
}

/** Legacy album-monitoring facts migrated to the strict v3 artifact envelope. */
export interface BuildLidarrAlbumMonitoringPlanV3Input extends BuildLidarrAlbumMutationPlanInput {
  readonly cascadePolicy: LidarrCascadePolicy;
}

/** One expected-absent artist source sealed into an artist-add plan. */
export interface BuildLidarrArtistAddPlanEntryV2Input {
  readonly artistName: string;
  readonly foreignArtistId: string;
  readonly provenance: LidarrArtistAddProvenanceV2;
}

/** Input for sealing a legacy single-entry or canonical multi-entry artist-add plan. */
export type BuildLidarrArtistAddPlanV2Input = {
  readonly origin: string;
  readonly operation: LidarrArtistAddOperationV2;
} & (
  | {
      readonly entry: BuildLidarrArtistAddPlanEntryV2Input;
      readonly entries?: never;
    }
  | {
      readonly entry?: never;
      readonly entries: readonly [
        BuildLidarrArtistAddPlanEntryV2Input,
        ...BuildLidarrArtistAddPlanEntryV2Input[],
      ];
    }
);

/** Artist-add v3 input with an already resolved, credential-free policy. */
export type BuildLidarrArtistAddPlanV3Input = BuildLidarrArtistAddPlanV2Input & {
  readonly cascadePolicy: LidarrCascadePolicy;
};

/** Canonical facts accepted by the common v3 sealer. */
export type LidarrPlanV3Seed = LidarrPlanV3 extends infer TPlan
  ? TPlan extends LidarrPlanV3
    ? Omit<TPlan, "version" | "cascadeAnalysis" | "payloadChecksum">
    : never
  : never;

export interface LidarrPlanBuildDependencies {
  readonly randomUUID?: () => string;
  readonly now?: () => Date;
  readonly hostname?: () => string;
  readonly username?: () => string;
  readonly cwd?: () => string;
  readonly cliVersion?: string;
}

export interface LidarrPlanClaimDependencies {
  readonly claimDirectory?: string;
  readonly hostname?: () => string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly randomUUID?: () => string;
}

export interface LidarrPlanClaim {
  readonly path: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

/** Legacy v1 monitoring definition used by immutable artist and album plans. */
export interface LidarrMutationOperationDefinitionV1 {
  readonly kind: LidarrMutationOperation["kind"];
  readonly deferredOperation: string;
  /** Exact scheduler operation label for one apply mutation task. */
  readonly operationLabel: string;
  canonicalize(operation: LidarrMutationOperation): LidarrMutationOperation;
  risk(operation: LidarrMutationOperation): LidarrPlanRiskSummary;
  payloadFor(
    entry: LidarrMutationPlanEntry,
  ):
    | Readonly<{ readonly artistId: number; readonly monitored: boolean }>
    | Readonly<{ readonly albumId: number; readonly monitored: boolean }>;
  idempotencyKey(origin: string, entry: LidarrMutationPlanEntry): string;
  classify(
    entry: LidarrMutationPlanEntry,
    current: { readonly monitored: boolean },
  ): LidarrPlanEntryClassification;
  /** Stable `"artist:<id>"` / `"album:<id>"` identity for one plan entry. */
  entryId(entry: LidarrMutationPlanEntry): string;
  /** Human-readable target label for tables and error messages. */
  entryLabel(entry: LidarrMutationPlanEntry): string;
  /**
   * Bare scheduler task-id fragment; the artist kind returns the artist id
   * without a prefix to preserve existing machine-visible task ids.
   */
  taskIdFragment(entry: LidarrMutationPlanEntry): string;
  /** Deterministic numeric ordering key for apply entry results. */
  resultSortKey(entry: LidarrMutationPlanEntry): number;
  /** Fetches live monitored state for the entries, keyed by `entryId`. */
  loadCurrentStates(
    client: LidarrClientApi,
    entries: readonly LidarrMutationPlanEntry[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, { readonly monitored: boolean }>>;
  /** Builds the per-kind staleness finding for a missing or drifted target. */
  staleFinding(
    entry: LidarrMutationPlanEntry,
    reason: "missing" | "drift",
  ): LidarrPlanStalenessFinding;
  execute(
    entry: LidarrMutationPlanEntry,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
  executeDeferredPayload(
    payload: Readonly<Record<string, unknown>>,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
  matchesDeferredIntent(
    entry: LidarrMutationPlanEntry,
    queuedOperation: string,
    queuedPayload: Readonly<Record<string, unknown>>,
  ): boolean;
}

/** Exact legacy definition for immutable v1 album-monitoring plans. */
export type LidarrAlbumMonitoringOperationDefinition = LidarrMutationOperationDefinitionV1 & {
  readonly kind: "album-monitoring";
};

const ARTIST_MONITORING_RISK = Object.freeze({
  level: "low",
  destructive: false,
  cascade: Object.freeze([
    "Existing files remain unchanged.",
    "Existing download-queue items are not cancelled.",
    "No artist or album search is triggered.",
  ]),
}) satisfies LidarrPlanRiskSummary;

/** Fails fast when a non-album entry reaches album-only definition behavior. */
function requireAlbumEntry(entry: LidarrMutationPlanEntry): LidarrAlbumMonitoringPlanEntry {
  if (!isLidarrAlbumPlanEntry(entry)) {
    throw validationError("expected an album-monitoring plan entry");
  }
  return entry;
}

/** Canonical selector normal form: deduped and sorted by UTF-16 code units. */
function canonicalizeSelectors(selectors: readonly string[]): readonly string[] {
  return [...new Set(selectors)].sort();
}

const ARTIST_MONITORING_DEFINITION_V1 = Object.freeze<LidarrMutationOperationDefinitionV1>({
  kind: "artist-monitoring",
  deferredOperation: LIDARR_ARTIST_MONITORING_OPERATION,
  operationLabel: "lidarr apply artist monitoring",
  canonicalize(operation) {
    return { kind: "artist-monitoring", desiredMonitored: operation.desiredMonitored };
  },
  risk() {
    return ARTIST_MONITORING_RISK;
  },
  payloadFor(entry) {
    return Object.freeze({ artistId: entry.artistId, monitored: entry.after.monitored });
  },
  idempotencyKey(origin, entry) {
    const canonical = JSON.stringify({
      origin,
      operation: "artist-monitoring",
      artistId: entry.artistId,
      desiredMonitored: entry.after.monitored,
    });
    return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  },
  classify(entry, current) {
    if (current.monitored === entry.after.monitored) return "satisfied";
    return current.monitored === entry.before.monitored ? "ready" : "drifted";
  },
  async execute(entry, client, signal) {
    await client.setArtistsMonitored([entry.artistId], entry.after.monitored, signal);
  },
  async executeDeferredPayload(payload, client, signal) {
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
    await this.execute(
      {
        id: `artist:${artistId}`,
        artistId,
        artistName: "deferred artist",
        before: { monitored: !monitored },
        after: { monitored },
        idempotencyKey: "sha256:" + "0".repeat(64),
      },
      client,
      signal,
    );
  },
  matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
    if (queuedOperation !== LIDARR_ARTIST_MONITORING_OPERATION) return false;
    const keys = Object.keys(queuedPayload);
    return (
      keys.length === 2 &&
      keys.includes("artistId") &&
      keys.includes("monitored") &&
      queuedPayload["artistId"] === entry.artistId &&
      queuedPayload["monitored"] === entry.after.monitored
    );
  },
  entryId(entry) {
    return entry.id;
  },
  entryLabel(entry) {
    return entry.artistName;
  },
  taskIdFragment(entry) {
    return String(entry.artistId);
  },
  resultSortKey(entry) {
    return entry.artistId;
  },
  async loadCurrentStates(client, _entries, signal) {
    const artists = await client.listArtists(signal);
    return new Map(
      artists.map((artist) => [`artist:${artist.id}`, { monitored: artist.monitored }]),
    );
  },
  staleFinding(entry, reason) {
    return {
      code: reason === "missing" ? "artist-missing" : "artist-state-drift",
      entryId: entry.id,
      artistId: entry.artistId,
      message:
        reason === "missing"
          ? `Artist ${entry.artistId} no longer exists`
          : `Artist ${entry.artistId} monitoring state changed after planning`,
    };
  },
});

const ALBUM_MONITORING_RISK = Object.freeze({
  level: "low",
  destructive: false,
  cascade: Object.freeze([
    "Album files remain on disk",
    "Artist-level monitoring unchanged",
    "No search triggered",
  ]),
}) satisfies LidarrPlanRiskSummary;

const ALBUM_MONITORING_DEFINITION = Object.freeze<LidarrAlbumMonitoringOperationDefinition>({
  kind: "album-monitoring",
  deferredOperation: LIDARR_ALBUM_MONITORING_OPERATION,
  operationLabel: "lidarr apply album monitoring",
  canonicalize(operation) {
    if (operation.kind !== "album-monitoring") {
      throw validationError("expected an album-monitoring operation");
    }
    return {
      kind: "album-monitoring",
      desiredMonitored: operation.desiredMonitored,
      selectors: canonicalizeSelectors(operation.selectors),
    };
  },
  risk() {
    return ALBUM_MONITORING_RISK;
  },
  payloadFor(entry) {
    const albumEntry = requireAlbumEntry(entry);
    return Object.freeze({ albumId: albumEntry.albumId, monitored: albumEntry.after.monitored });
  },
  idempotencyKey(origin, entry) {
    const albumEntry = requireAlbumEntry(entry);
    const canonical = JSON.stringify({
      origin,
      operation: "album-monitoring",
      albumId: albumEntry.albumId,
      desiredMonitored: albumEntry.after.monitored,
    });
    return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  },
  classify(entry, current) {
    if (current.monitored === entry.after.monitored) return "satisfied";
    return current.monitored === entry.before.monitored ? "ready" : "drifted";
  },
  async execute(entry, client, signal) {
    const albumEntry = requireAlbumEntry(entry);
    await client.setAlbumsMonitored([albumEntry.albumId], albumEntry.after.monitored, signal);
  },
  async executeDeferredPayload(payload, client, signal) {
    const record = requireRecord(payload, "deferred album-monitoring payload");
    requireExactKeys(record, "deferred album-monitoring payload", ["albumId", "monitored"]);
    assertNoSensitiveKeys(record, "deferred album-monitoring payload");
    const albumId = requirePositiveInteger(
      record["albumId"],
      "deferred album-monitoring payload.albumId",
    );
    const monitored = requireBoolean(
      record["monitored"],
      "deferred album-monitoring payload.monitored",
    );
    await this.execute(
      {
        id: `album:${albumId}`,
        albumId,
        albumTitle: "deferred album",
        artistId: 1,
        artistName: "deferred artist",
        before: { monitored: !monitored },
        after: { monitored },
        idempotencyKey: "sha256:" + "0".repeat(64),
      },
      client,
      signal,
    );
  },
  matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
    if (queuedOperation !== LIDARR_ALBUM_MONITORING_OPERATION) return false;
    if (!isLidarrAlbumPlanEntry(entry)) return false;
    const keys = Object.keys(queuedPayload);
    return (
      keys.length === 2 &&
      keys.includes("albumId") &&
      keys.includes("monitored") &&
      queuedPayload["albumId"] === entry.albumId &&
      queuedPayload["monitored"] === entry.after.monitored
    );
  },
  entryId(entry) {
    return requireAlbumEntry(entry).id;
  },
  entryLabel(entry) {
    const albumEntry = requireAlbumEntry(entry);
    return `${albumEntry.albumTitle} — ${albumEntry.artistName}`;
  },
  taskIdFragment(entry) {
    return `album:${requireAlbumEntry(entry).albumId}`;
  },
  resultSortKey(entry) {
    return requireAlbumEntry(entry).albumId;
  },
  async loadCurrentStates(client, entries, signal) {
    const albumIds = entries.map((entry) => requireAlbumEntry(entry).albumId);
    if (albumIds.length === 0) return new Map();
    const albums = await client.listAlbums({ albumIds, signal });
    return new Map(albums.map((album) => [`album:${album.id}`, { monitored: album.monitored }]));
  },
  staleFinding(entry, reason) {
    const albumEntry = requireAlbumEntry(entry);
    return {
      code: reason === "missing" ? "album-missing" : "album-state-drift",
      entryId: albumEntry.id,
      albumId: albumEntry.albumId,
      message:
        reason === "missing"
          ? `Album ${albumEntry.albumId} no longer exists`
          : `Album ${albumEntry.albumId} monitoring state changed after planning`,
    };
  },
});

const LIDARR_MUTATION_OPERATION_DEFINITIONS: ReadonlyMap<
  LidarrMutationOperation["kind"],
  LidarrMutationOperationDefinitionV1
> = new Map([
  [ARTIST_MONITORING_DEFINITION_V1.kind, ARTIST_MONITORING_DEFINITION_V1],
  [ALBUM_MONITORING_DEFINITION.kind, ALBUM_MONITORING_DEFINITION],
]);

export type LidarrArtistMonitoringOperationDefinition = LidarrMutationOperationDefinitionV1 &
  LidarrDeferableMutationOperationDefinitionV2;

/** Exact definition union for the two immutable v1 monitoring operations. */
export type LidarrMonitoringOperationDefinition =
  | LidarrAlbumMonitoringOperationDefinition
  | LidarrArtistMonitoringOperationDefinition;

/** Public union spanning immutable v1 monitoring and strict v2 operations. */
export type LidarrMutationOperationDefinition =
  | LidarrAlbumMonitoringOperationDefinition
  | LidarrMutationOperationDefinitionV2;

/** Resolves the typed behavior owner for an allowlisted v1 or v2 operation. */
export function getLidarrMutationOperationDefinition(
  operation: LidarrAlbumMonitoringOperation,
): LidarrAlbumMonitoringOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrArtistMonitoringOperation,
): LidarrArtistMonitoringOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrMutationOperation,
): LidarrMonitoringOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrArtistProfileAssignmentOperation | LidarrArtistTagMutationOperation,
): LidarrDeferableMutationOperationDefinitionV2;
export function getLidarrMutationOperationDefinition(
  operation: LidarrArtistDeleteOperation,
): LidarrNonDeferableMutationOperationDefinitionV2;
export function getLidarrMutationOperationDefinition(
  operation: LidarrMutationOperationV2,
): LidarrMutationOperationDefinitionV2;
export function getLidarrMutationOperationDefinition(
  operation: LidarrMutationOperation | LidarrMutationOperationV2,
): LidarrMutationOperationDefinition;
export function getLidarrMutationOperationDefinition(
  operation: LidarrMutationOperation | LidarrMutationOperationV2,
): LidarrMutationOperationDefinition {
  if (operation.kind === "album-monitoring") return ALBUM_MONITORING_DEFINITION;
  const definition = getV2LidarrMutationOperationDefinition(operation);
  if (operation.kind !== "artist-monitoring") return definition;
  return Object.freeze({
    ...ARTIST_MONITORING_DEFINITION_V1,
    ...definition,
  }) as LidarrArtistMonitoringOperationDefinition;
}

/** Returns the explicit, allowlisted deferred executors shipped by this plan version. */
export function createLidarrMutationExecutors(): ReadonlyMap<string, LidarrIntentExecutor> {
  const executors = new Map(createV2LidarrMutationExecutors());
  const executor: LidarrIntentExecutor = Object.freeze({
    operation: ALBUM_MONITORING_DEFINITION.deferredOperation,
    execute: (
      payload: Readonly<Record<string, unknown>>,
      client: LidarrClientApi,
      signal?: AbortSignal,
    ) => ALBUM_MONITORING_DEFINITION.executeDeferredPayload(payload, client, signal),
  });
  executors.set(executor.operation, executor);
  return executors;
}

/**
 * Returns every allowlisted deferred executor, including the album-family
 * `lidarr.album-edit` / `lidarr.album-delete` executors.
 *
 * `createLidarrMutationExecutors` is pinned by contract tests to the exact
 * four artist/album-monitoring identities, so the album executors compose
 * here additively instead of mutating the pinned registry.
 */
export function createLidarrMutationExecutorsWithAlbums(): ReadonlyMap<
  string,
  LidarrIntentExecutor
> {
  const executors = new Map(createLidarrMutationExecutors());
  for (const albumExecutor of createLidarrAlbumMutationExecutors().values()) {
    executors.set(albumExecutor.operation, albumExecutor);
  }
  return executors;
}

/** Returns a canonical HTTP(S) origin and rejects path/query/auth variants. */
export function canonicalizeLidarrPlanOrigin(value: string): string {
  if (TERMINAL_CONTROL_PATTERN.test(value)) {
    throw validationError("plan target origin must not contain terminal control characters");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError("plan target origin must be a valid URL origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin
  ) {
    throw validationError("plan target origin must be a canonical HTTP(S) origin");
  }
  return url.origin;
}

function canonicalizeOperation(operation: LidarrMutationOperation): LidarrMutationOperation {
  return getLidarrMutationOperationDefinition(operation).canonicalize(operation);
}

function canonicalizeEntry(entry: LidarrMutationPlanEntry): LidarrMutationPlanEntry {
  if (isLidarrAlbumPlanEntry(entry)) {
    return {
      id: entry.id,
      albumId: entry.albumId,
      albumTitle: entry.albumTitle,
      artistId: entry.artistId,
      artistName: entry.artistName,
      ...(entry.albumType === undefined ? {} : { albumType: entry.albumType }),
      before: { monitored: entry.before.monitored },
      after: { monitored: entry.after.monitored },
      idempotencyKey: entry.idempotencyKey,
    };
  }
  return {
    id: entry.id,
    artistId: entry.artistId,
    artistName: entry.artistName,
    before: { monitored: entry.before.monitored },
    after: { monitored: entry.after.monitored },
    idempotencyKey: entry.idempotencyKey,
  };
}

function canonicalizePlan(
  plan: LidarrMutationPlanV1,
  includeChecksum: boolean,
): Omit<LidarrMutationPlanV1, "payloadChecksum"> & { readonly payloadChecksum?: string } {
  return {
    version: LIDARR_PLAN_VERSION,
    id: plan.id,
    createdAt: plan.createdAt,
    createdBy: {
      host: plan.createdBy.host,
      user: plan.createdBy.user,
      cliVersion: plan.createdBy.cliVersion,
      cwd: plan.createdBy.cwd,
    },
    command: "lidarr",
    target: { origin: plan.target.origin },
    operation: canonicalizeOperation(plan.operation),
    maxBatch: plan.maxBatch,
    entries: plan.entries.map(canonicalizeEntry),
    review: {
      requested: plan.review.requested,
      changed: plan.review.changed,
      unchanged: plan.review.unchanged,
    },
    risk: {
      level: plan.risk.level,
      destructive: plan.risk.destructive,
      cascade: [...plan.risk.cascade],
    },
    ...(includeChecksum && { payloadChecksum: plan.payloadChecksum }),
  };
}

function canonicalizeResourceReference(
  reference: LidarrPlanResourceReference,
): LidarrPlanResourceReference {
  return { id: reference.id, name: reference.name };
}

function canonicalizeRootFolderReference(
  reference: LidarrPlanRootFolderReference,
): LidarrPlanRootFolderReference {
  return { id: reference.id, path: reference.path };
}

function canonicalizeArtistAddProvenance(
  provenance: LidarrArtistAddProvenanceV2,
  path: string,
  artistName: string,
): LidarrArtistAddProvenanceV2 {
  const seedArtist = requireString(provenance.seedArtist, `${path}.seedArtist`);
  if (
    typeof provenance.similarity !== "number" ||
    !Number.isFinite(provenance.similarity) ||
    provenance.similarity < 0 ||
    provenance.similarity > 1
  ) {
    throw validationError(`${path}.similarity must be a finite number from 0 through 1`);
  }
  const candidateUrl = requireString(provenance.candidateUrl, `${path}.candidateUrl`);
  const discoveredAt = requireString(provenance.discoveredAt, `${path}.discoveredAt`);
  if (!Number.isFinite(Date.parse(discoveredAt))) {
    throw validationError(`${path}.discoveredAt is invalid`);
  }
  if (provenance.source !== "lastfm" || provenance.method !== "artist.getSimilar") {
    throw validationError(`${path} source or method is invalid`);
  }
  const hasExtendedProvenance =
    provenance.selectedRank !== undefined ||
    provenance.parentArtist !== undefined ||
    provenance.depth !== undefined ||
    provenance.providerRank !== undefined ||
    provenance.firstSeenSequence !== undefined ||
    provenance.firstPath !== undefined ||
    provenance.adjustedScore !== undefined ||
    provenance.exposureCount !== undefined ||
    provenance.popularityEvidence !== undefined;
  if (
    hasExtendedProvenance &&
    (provenance.selectedRank === undefined ||
      provenance.parentArtist === undefined ||
      provenance.depth === undefined ||
      provenance.providerRank === undefined ||
      provenance.firstSeenSequence === undefined ||
      provenance.firstPath === undefined ||
      provenance.adjustedScore === undefined ||
      provenance.exposureCount === undefined)
  ) {
    throw validationError(`${path} extended discovery evidence is incomplete`);
  }
  const selectedRank =
    provenance.selectedRank === undefined
      ? undefined
      : requirePositiveInteger(
          provenance.selectedRank,
          `${path}.selectedRank`,
          LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
        );
  const parentArtist =
    provenance.parentArtist === undefined
      ? undefined
      : requireString(provenance.parentArtist, `${path}.parentArtist`);
  const depth =
    provenance.depth === undefined
      ? undefined
      : requirePositiveInteger(provenance.depth, `${path}.depth`, LIDARR_DISCOVER_MAX_DEPTH);
  const providerRank =
    provenance.providerRank === undefined
      ? undefined
      : requirePositiveInteger(
          provenance.providerRank,
          `${path}.providerRank`,
          LIDARR_DISCOVER_MAX_LIMIT,
        );
  const firstSeenSequence =
    provenance.firstSeenSequence === undefined
      ? undefined
      : requirePositiveInteger(
          provenance.firstSeenSequence,
          `${path}.firstSeenSequence`,
          LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
        );
  let firstPath: readonly string[] | undefined;
  if (provenance.firstPath !== undefined) {
    if (
      !Array.isArray(provenance.firstPath) ||
      provenance.firstPath.length === 0 ||
      provenance.firstPath.length > LIDARR_DISCOVER_MAX_DEPTH + 1
    ) {
      throw validationError(`${path}.firstPath must be a bounded non-empty array`);
    }
    firstPath = provenance.firstPath.map((artist, index) =>
      requireString(artist, `${path}.firstPath[${index}]`),
    );
  }
  if (
    depth !== undefined &&
    parentArtist !== undefined &&
    firstPath !== undefined &&
    (firstPath.length !== depth + 1 ||
      firstPath[0] !== seedArtist ||
      firstPath.at(-2) !== parentArtist ||
      firstPath.at(-1) !== artistName)
  ) {
    throw validationError(
      `${path}.firstPath must match its depth, seedArtist, parentArtist, and planned artist`,
    );
  }
  const adjustedScore =
    provenance.adjustedScore === undefined
      ? undefined
      : requireUnitInterval(provenance.adjustedScore, `${path}.adjustedScore`);
  const exposureCount =
    provenance.exposureCount === undefined
      ? undefined
      : requirePositiveInteger(
          provenance.exposureCount,
          `${path}.exposureCount`,
          LIDARR_DISCOVER_MAX_EXPOSURE_COUNT,
        );
  if (
    provenance.popularityEvidence !== undefined &&
    provenance.popularityEvidence !== "graph-exposure"
  ) {
    throw validationError(`${path}.popularityEvidence is invalid`);
  }
  return {
    source: "lastfm",
    method: "artist.getSimilar",
    seedArtist,
    similarity: provenance.similarity,
    candidateUrl,
    discoveredAt,
    ...(selectedRank === undefined ? {} : { selectedRank }),
    ...(parentArtist === undefined ? {} : { parentArtist }),
    ...(depth === undefined ? {} : { depth }),
    ...(providerRank === undefined ? {} : { providerRank }),
    ...(firstSeenSequence === undefined ? {} : { firstSeenSequence }),
    ...(firstPath === undefined ? {} : { firstPath }),
    ...(adjustedScore === undefined ? {} : { adjustedScore }),
    ...(exposureCount === undefined ? {} : { exposureCount }),
    ...(provenance.popularityEvidence === undefined
      ? {}
      : { popularityEvidence: provenance.popularityEvidence }),
  };
}

function requireUnitInterval(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw validationError(`${path} must be a finite number from 0 through 1`);
  }
  return value;
}

/** Purely validates and canonicalizes one artist-add source before any Lidarr read. */
export function canonicalizeLidarrArtistAddPlanEntryInput(
  source: BuildLidarrArtistAddPlanEntryV2Input,
  path: string,
): BuildLidarrArtistAddPlanEntryV2Input {
  const foreignArtistId = requireString(source.foreignArtistId, `${path}.foreignArtistId`);
  if (!CANONICAL_MUSICBRAINZ_ID_PATTERN.test(foreignArtistId)) {
    throw validationError(`${path}.foreignArtistId must be a canonical lowercase MusicBrainz UUID`);
  }
  const artistName = requireString(source.artistName, `${path}.artistName`);
  return Object.freeze({
    artistName,
    foreignArtistId,
    provenance: Object.freeze(
      canonicalizeArtistAddProvenance(source.provenance, `${path}.provenance`, artistName),
    ),
  });
}

function canonicalizeTagReference(reference: LidarrPlanTagReference): LidarrPlanTagReference {
  return { id: reference.id, label: reference.label };
}

function canonicalizeSelection(
  selection: LidarrPlanSelectionV2Extended | LidarrArtistAddPlanV2["selection"],
): LidarrPlanSelectionV2Extended | LidarrArtistAddPlanV2["selection"] {
  switch (selection.kind) {
    case "foreign-artist-id":
      return { kind: "foreign-artist-id", foreignArtistId: selection.foreignArtistId };
    case "foreign-artist-ids":
      return { kind: "foreign-artist-ids", foreignArtistIds: [...selection.foreignArtistIds] };
    case "ids":
      return { kind: "ids", artistIds: [...selection.artistIds] };
    case "filters":
      return {
        kind: "filters",
        ...(selection.monitored === undefined ? {} : { monitored: selection.monitored }),
        ...(selection.qualityProfile === undefined
          ? {}
          : { qualityProfile: canonicalizeResourceReference(selection.qualityProfile) }),
        ...(selection.metadataProfile === undefined
          ? {}
          : { metadataProfile: canonicalizeResourceReference(selection.metadataProfile) }),
        ...(selection.tags === undefined
          ? {}
          : { tags: selection.tags.map(canonicalizeTagReference) }),
      };
    case "all":
      return { kind: "all" };
    case "album-ids":
    case "album-filters":
      return canonicalizeLidarrAlbumPlanSelection(selection);
    case "album-track-filter":
      return { kind: "album-track-filter", albumId: selection.albumId };
  }
}

function canonicalizeOperationV2(
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
): LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2 {
  if (operation.kind === "artist-add") {
    return getLidarrArtistAddOperationDefinition(operation).canonicalize();
  }
  if (operation.kind === "album-edit" || operation.kind === "album-delete") {
    return getLidarrAlbumMutationOperationDefinition(operation).canonicalize();
  }
  if (operation.kind === "track-file-filter") {
    return {
      kind: "track-file-filter",
      explicitKeepTrackIds: [...operation.explicitKeepTrackIds],
      ...(operation.minStars === undefined ? {} : { minStars: operation.minStars }),
    };
  }
  return getLidarrMutationOperationDefinition(operation).canonicalize();
}

function canonicalizeProfileState(
  state: LidarrArtistProfilePlanEntry["before"],
): LidarrArtistProfilePlanEntry["before"] {
  return {
    ...(state.qualityProfile === undefined
      ? {}
      : { qualityProfile: canonicalizeResourceReference(state.qualityProfile) }),
    ...(state.metadataProfile === undefined
      ? {}
      : { metadataProfile: canonicalizeResourceReference(state.metadataProfile) }),
  };
}

function canonicalizeEntryV2(
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
  entry: LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2,
): LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2 {
  if (operation.kind === "artist-add") {
    const addEntry = entry as LidarrArtistAddPlanEntryV2;
    const extended = isLidarrArtistAddExtendedOperation(operation);
    if (extended !== isLidarrArtistAddExtendedPlanEntry(addEntry)) {
      throw validationError("artist-add operation and entry shapes are inconsistent");
    }
    const common = {
      id: addEntry.id,
      artistName: addEntry.artistName,
      foreignArtistId: addEntry.foreignArtistId,
      before: { exists: false as const },
      after: {
        exists: true as const,
        rootFolder: canonicalizeRootFolderReference(addEntry.after.rootFolder),
        qualityProfile: { ...addEntry.after.qualityProfile },
        metadataProfile: { ...addEntry.after.metadataProfile },
        monitored: operation.monitored,
        monitorNewItems: "none" as const,
        searchForMissingAlbums: false as const,
      },
      provenance: canonicalizeArtistAddProvenance(
        addEntry.provenance,
        "entry.provenance",
        addEntry.artistName,
      ),
      idempotencyKey: addEntry.idempotencyKey,
    };
    if (extended) {
      return {
        ...common,
        after: {
          ...common.after,
          monitored: operation.monitored,
          postAddUnmonitorSelectors: [...operation.postAddUnmonitorSelectors],
        },
      };
    }
    return { ...common, after: { ...common.after, monitored: false } };
  }
  const existingEntry = entry as LidarrMutationPlanEntryV2Extended;
  const common = {
    id: existingEntry.id,
    artistId: existingEntry.artistId,
    artistName: existingEntry.artistName,
  };
  switch (operation.kind) {
    case "artist-monitoring": {
      const monitoringEntry = entry as LidarrArtistMonitoringPlanEntry;
      return {
        ...common,
        before: { monitored: monitoringEntry.before.monitored },
        after: { monitored: monitoringEntry.after.monitored },
        idempotencyKey: monitoringEntry.idempotencyKey,
      };
    }
    case "artist-profile-assignment": {
      const profileEntry = entry as LidarrArtistProfilePlanEntry;
      return {
        ...common,
        before: canonicalizeProfileState(profileEntry.before),
        after: canonicalizeProfileState(profileEntry.after),
        idempotencyKey: profileEntry.idempotencyKey,
      };
    }
    case "artist-tag-mutation": {
      const tagEntry = entry as LidarrArtistTagMutationPlanEntry;
      return {
        ...common,
        before: { tags: tagEntry.before.tags.map(canonicalizeTagReference) },
        after: { tags: tagEntry.after.tags.map(canonicalizeTagReference) },
        added: tagEntry.added.map(canonicalizeTagReference),
        removed: tagEntry.removed.map(canonicalizeTagReference),
        retained: tagEntry.retained.map(canonicalizeTagReference),
        idempotencyKey: tagEntry.idempotencyKey,
      };
    }
    case "album-edit":
    case "album-delete":
      return canonicalizeLidarrAlbumMutationPlanEntry(
        operation,
        entry as LidarrAlbumMutationPlanEntryV2,
      );
    case "track-file-filter":
      return canonicalizeLidarrTrackFilterPlanEntry(entry as LidarrTrackFileFilterPlanEntryV2);
    case "artist-delete": {
      const deleteEntry = entry as LidarrArtistDeletePlanEntry;
      return {
        ...common,
        before: {
          path: deleteEntry.before.path,
          albumCount: deleteEntry.before.albumCount,
          trackFileCount: deleteEntry.before.trackFileCount,
          sizeOnDisk: deleteEntry.before.sizeOnDisk,
        },
        after: { exists: false },
        idempotencyKey: deleteEntry.idempotencyKey,
      };
    }
  }
}

function canonicalizeSummary(
  summary: LidarrPlanOperationSummaryV2Extended | LidarrArtistAddPlanV2["summary"],
): LidarrPlanOperationSummaryV2Extended | LidarrArtistAddPlanV2["summary"] {
  switch (summary.kind) {
    case "artist-add":
      return { kind: "artist-add", artists: summary.artists };
    case "artist-monitoring":
      return {
        kind: summary.kind,
        monitoredBefore: summary.monitoredBefore,
        monitoredAfter: summary.monitoredAfter,
      };
    case "artist-profile-assignment":
      return {
        kind: summary.kind,
        qualityProfileChanged: summary.qualityProfileChanged,
        metadataProfileChanged: summary.metadataProfileChanged,
      };
    case "artist-tag-mutation":
      return {
        kind: summary.kind,
        added: summary.added,
        removed: summary.removed,
        retained: summary.retained,
      };
    case "album-edit":
    case "album-delete":
      return canonicalizeLidarrAlbumPlanSummary(summary);
    case "track-file-filter":
      return {
        kind: summary.kind,
        tracks: summary.tracks,
        kept: summary.kept,
        deleteCandidates: summary.deleteCandidates,
        warnings: summary.warnings,
        totalDeleteBytes: summary.totalDeleteBytes,
      };
    case "artist-delete":
      return {
        kind: summary.kind,
        artists: summary.artists,
        albums: summary.albums,
        trackFiles: summary.trackFiles,
        sizeOnDisk: summary.sizeOnDisk,
      };
  }
}

function canonicalizePlanV2(
  plan:
    | LidarrMutationPlanV2
    | LidarrArtistAddPlanV2
    | LidarrAlbumMutationPlanV2
    | LidarrTrackFileFilterPlanV2,
  includeChecksum: boolean,
): UnknownRecord {
  return {
    version: LIDARR_PLAN_VERSION_V2,
    id: plan.id,
    createdAt: plan.createdAt,
    createdBy: {
      host: plan.createdBy.host,
      user: plan.createdBy.user,
      cliVersion: plan.createdBy.cliVersion,
      cwd: plan.createdBy.cwd,
    },
    command: "lidarr",
    target: { origin: plan.target.origin },
    selection: canonicalizeSelection(plan.selection),
    operation: canonicalizeOperationV2(plan.operation),
    maxBatch: plan.maxBatch,
    entries: plan.entries.map((entry) => canonicalizeEntryV2(plan.operation, entry)),
    review: {
      requested: plan.review.requested,
      changed: plan.review.changed,
      unchanged: plan.review.unchanged,
    },
    summary: canonicalizeSummary(plan.summary),
    risk: {
      level: plan.risk.level,
      destructive: plan.risk.destructive,
      cascade: [...plan.risk.cascade],
    },
    ...(includeChecksum && { payloadChecksum: plan.payloadChecksum }),
  };
}

function canonicalizeCascadeMetric(metric: LidarrCascadeMetric): LidarrCascadeMetric {
  return {
    value: metric.value,
    certainty: metric.certainty,
    horizon: metric.horizon,
    unit: metric.unit,
    basis: metric.basis,
  };
}

function canonicalizeCascadeBudget(
  budget: LidarrCascadeBudgetAssessment,
): LidarrCascadeBudgetAssessment {
  return {
    status: budget.status,
    limit: budget.limit,
    projected: budget.projected,
    provenance: budget.provenance,
  };
}

function canonicalizeCascadeWarning(warning: LidarrCascadeWarning): LidarrCascadeWarning {
  if (warning.code === "budget-assessment-incomplete") {
    return {
      code: warning.code,
      metric: warning.metric,
      projected: null,
      limit: warning.limit,
    };
  }
  return warning.code === "indexer-query-budget-exceeded"
    ? {
        code: "indexer-query-budget-exceeded",
        metric: "indexerQueries",
        projected: warning.projected,
        limit: warning.limit,
        overBy: warning.overBy,
      }
    : {
        code: "acquisition-budget-exceeded",
        metric: "acquisitionCandidates",
        projected: warning.projected,
        limit: warning.limit,
        overBy: warning.overBy,
      };
}

function canonicalizeCascadeAnalysis(analysis: LidarrCascadeAnalysis): LidarrCascadeAnalysis {
  return {
    modelVersion: analysis.modelVersion,
    assumptions: {
      albumsPerArtist: analysis.assumptions.albumsPerArtist,
      indexerQueriesPerCandidate: analysis.assumptions.indexerQueriesPerCandidate,
    },
    metrics: {
      immediateIndexerQueries: canonicalizeCascadeMetric(analysis.metrics.immediateIndexerQueries),
      acquisitionCandidates: canonicalizeCascadeMetric(analysis.metrics.acquisitionCandidates),
      conditionalIndexerQueries: canonicalizeCascadeMetric(
        analysis.metrics.conditionalIndexerQueries,
      ),
      newlyMonitored: canonicalizeCascadeMetric(analysis.metrics.newlyMonitored),
      filesAffected: canonicalizeCascadeMetric(analysis.metrics.filesAffected),
      bytesAffected: canonicalizeCascadeMetric(analysis.metrics.bytesAffected),
    },
    budgets: {
      indexerQueries: canonicalizeCascadeBudget(analysis.budgets.indexerQueries),
      acquisitionCandidates: canonicalizeCascadeBudget(analysis.budgets.acquisitionCandidates),
    },
    warnings: analysis.warnings.map(canonicalizeCascadeWarning),
    recommendations: [...analysis.recommendations],
  };
}

function canonicalizeEntryV3(
  operation: LidarrPlanV3["operation"],
  entry: LidarrPlanV3["entries"][number],
): LidarrPlanV3["entries"][number] {
  if (operation.kind !== "track-file-filter") {
    return canonicalizeEntryV2(
      operation as LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
      entry as LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2,
    ) as LidarrPlanV3["entries"][number];
  }
  const trackEntry = entry as LidarrTrackFileFilterPlanEntryV3;
  const canonical = canonicalizeLidarrTrackFilterPlanEntry(trackEntry);
  return {
    ...canonical,
    before: {
      albumMonitored: trackEntry.before.albumMonitored,
      deleteCandidates: canonical.before.deleteCandidates,
    },
  } as LidarrTrackFileFilterPlanEntryV3;
}

function canonicalizePlanV3(plan: LidarrPlanV3, includeChecksum: boolean): UnknownRecord {
  if (plan.operation.kind === "album-monitoring") {
    const albumPlan = plan as LidarrAlbumMonitoringPlanV3;
    return {
      version: LIDARR_PLAN_VERSION_V3,
      id: albumPlan.id,
      createdAt: albumPlan.createdAt,
      createdBy: {
        host: albumPlan.createdBy.host,
        user: albumPlan.createdBy.user,
        cliVersion: albumPlan.createdBy.cliVersion,
        cwd: albumPlan.createdBy.cwd,
      },
      command: "lidarr",
      target: { origin: albumPlan.target.origin },
      operation: canonicalizeOperation(albumPlan.operation),
      maxBatch: albumPlan.maxBatch,
      entries: albumPlan.entries.map(canonicalizeEntry),
      review: {
        requested: albumPlan.review.requested,
        changed: albumPlan.review.changed,
        unchanged: albumPlan.review.unchanged,
      },
      risk: {
        level: albumPlan.risk.level,
        destructive: albumPlan.risk.destructive,
        cascade: [...albumPlan.risk.cascade],
      },
      cascadeAnalysis: canonicalizeCascadeAnalysis(albumPlan.cascadeAnalysis),
      ...(includeChecksum && { payloadChecksum: albumPlan.payloadChecksum }),
    };
  }
  const v2ShapedPlan = plan as Exclude<LidarrPlanV3, LidarrAlbumMonitoringPlanV3>;
  return {
    version: LIDARR_PLAN_VERSION_V3,
    id: v2ShapedPlan.id,
    createdAt: v2ShapedPlan.createdAt,
    createdBy: {
      host: v2ShapedPlan.createdBy.host,
      user: v2ShapedPlan.createdBy.user,
      cliVersion: v2ShapedPlan.createdBy.cliVersion,
      cwd: v2ShapedPlan.createdBy.cwd,
    },
    command: "lidarr",
    target: { origin: v2ShapedPlan.target.origin },
    selection: canonicalizeSelection(v2ShapedPlan.selection),
    operation: canonicalizeOperationV2(v2ShapedPlan.operation),
    maxBatch: v2ShapedPlan.maxBatch,
    entries: v2ShapedPlan.entries.map((entry) =>
      canonicalizeEntryV3(v2ShapedPlan.operation, entry),
    ),
    review: {
      requested: v2ShapedPlan.review.requested,
      changed: v2ShapedPlan.review.changed,
      unchanged: v2ShapedPlan.review.unchanged,
    },
    summary: canonicalizeSummary(v2ShapedPlan.summary),
    risk: {
      level: v2ShapedPlan.risk.level,
      destructive: v2ShapedPlan.risk.destructive,
      cascade: [...v2ShapedPlan.risk.cascade],
    },
    cascadeAnalysis: canonicalizeCascadeAnalysis(v2ShapedPlan.cascadeAnalysis),
    ...(includeChecksum && { payloadChecksum: v2ShapedPlan.payloadChecksum }),
  };
}

function computeLidarrPlanChecksumV1(plan: LidarrMutationPlanV1): string {
  const canonical = JSON.stringify(canonicalizePlan(plan, false));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function isAlbumPlanInput(
  input: BuildLidarrMutationPlanInput,
): input is BuildLidarrAlbumMutationPlanInput {
  return input.operation.kind === "album-monitoring";
}

function buildArtistPlanEntries(
  origin: string,
  definition: LidarrMutationOperationDefinition,
  sources: readonly LidarrPlanSourceEntry[],
  desiredMonitored: boolean,
): LidarrArtistMonitoringPlanEntry[] {
  const seen = new Set<number>();
  return [...sources]
    .sort((left, right) => left.artistId - right.artistId)
    .map((entry) => {
      const artistId = requirePositiveInteger(entry.artistId, "entry.artistId");
      if (seen.has(artistId)) throw validationError(`duplicate artist id ${artistId}`);
      seen.add(artistId);
      const artistName = requireString(entry.artistName, `artist ${artistId} name`);
      const plannedEntry: LidarrArtistMonitoringPlanEntry = {
        id: `artist:${artistId}`,
        artistId,
        artistName,
        before: { monitored: entry.monitored },
        after: { monitored: desiredMonitored },
        idempotencyKey: "",
      };
      return {
        ...plannedEntry,
        idempotencyKey: definition.idempotencyKey(origin, plannedEntry),
      };
    });
}

function buildAlbumPlanEntries(
  origin: string,
  definition: LidarrMutationOperationDefinition,
  sources: readonly LidarrAlbumPlanSourceEntry[],
  desiredMonitored: boolean,
): LidarrAlbumMonitoringPlanEntry[] {
  const seen = new Set<number>();
  return [...sources]
    .sort((left, right) => left.albumId - right.albumId)
    .map((entry) => {
      const albumId = requirePositiveInteger(entry.albumId, "entry.albumId");
      if (seen.has(albumId)) throw validationError(`duplicate album id ${albumId}`);
      seen.add(albumId);
      // Album titles may legitimately be "" (Lidarr null-title normalization).
      const albumTitle = requireString(entry.albumTitle, `album ${albumId} title`, true);
      const artistId = requirePositiveInteger(entry.artistId, `album ${albumId} artistId`);
      const artistName = requireString(entry.artistName, `album ${albumId} artist name`);
      const albumType =
        entry.albumType === undefined
          ? undefined
          : requireString(entry.albumType, `album ${albumId} type`);
      const plannedEntry: LidarrAlbumMonitoringPlanEntry = {
        id: `album:${albumId}`,
        albumId,
        albumTitle,
        artistId,
        artistName,
        ...(albumType === undefined ? {} : { albumType }),
        before: { monitored: entry.monitored },
        after: { monitored: desiredMonitored },
        idempotencyKey: "",
      };
      return {
        ...plannedEntry,
        idempotencyKey: definition.idempotencyKey(origin, plannedEntry),
      };
    });
}

/** Computes the SHA-256 seal using the canonical representation for the plan's exact version. */
export function computeLidarrPlanChecksum(plan: LidarrStoredMutationPlan): string {
  if (plan.version === LIDARR_PLAN_VERSION) return computeLidarrPlanChecksumV1(plan);
  const canonical = JSON.stringify(
    plan.version === LIDARR_PLAN_VERSION_V2
      ? canonicalizePlanV2(plan, false)
      : canonicalizePlanV3(plan, false),
  );
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Shared plan-envelope identity produced by every sealed plan builder. */
export interface LidarrPlanEnvelope {
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: LidarrPlanCreatedBy;
}

/** Builds the shared plan envelope (id, createdAt, createdBy) from injectable dependencies. */
export function createLidarrPlanEnvelope(
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrPlanEnvelope {
  const now = dependencies.now?.() ?? new Date();
  return {
    id: dependencies.randomUUID?.() ?? nodeRandomUUID(),
    createdAt: now.toISOString(),
    createdBy: {
      host: dependencies.hostname?.() ?? nodeHostname(),
      user: dependencies.username?.() ?? userInfo().username,
      cliVersion: dependencies.cliVersion ?? pkg.version,
      cwd: dependencies.cwd?.() ?? process.cwd(),
    },
  };
}

/** Builds a deterministic, checksum-sealed desired-state mutation plan. */
export function buildLidarrMutationPlan(
  input: BuildLidarrMutationPlanInput,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrMutationPlanV1 {
  const origin = canonicalizeLidarrPlanOrigin(input.origin);
  const maxBatch = requirePositiveInteger(input.maxBatch, "maxBatch", LIDARR_PLAN_MAX_BATCH);
  if (input.entries.length === 0) throw validationError("entries must not be empty");
  if (input.entries.length > maxBatch) {
    throw validationError(`entries exceed maxBatch (${input.entries.length} > ${maxBatch})`);
  }
  if (input.entries.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`entries exceed the maximum of ${LIDARR_PLAN_MAX_ENTRIES}`);
  }
  const operation = canonicalizeOperation(input.operation);
  const definition = getLidarrMutationOperationDefinition(operation);
  const entries: LidarrMutationPlanEntry[] = isAlbumPlanInput(input)
    ? buildAlbumPlanEntries(origin, definition, input.entries, operation.desiredMonitored)
    : buildArtistPlanEntries(origin, definition, input.entries, operation.desiredMonitored);
  const changed = entries.filter(
    (entry) => entry.before.monitored !== entry.after.monitored,
  ).length;
  const now = dependencies.now?.() ?? new Date();
  const planWithoutSeal = {
    version: LIDARR_PLAN_VERSION,
    id: dependencies.randomUUID?.() ?? nodeRandomUUID(),
    createdAt: now.toISOString(),
    createdBy: {
      host: dependencies.hostname?.() ?? nodeHostname(),
      user: dependencies.username?.() ?? userInfo().username,
      cliVersion: dependencies.cliVersion ?? pkg.version,
      cwd: dependencies.cwd?.() ?? process.cwd(),
    },
    command: "lidarr" as const,
    target: { origin },
    operation,
    maxBatch,
    entries,
    review: { requested: entries.length, changed, unchanged: entries.length - changed },
    risk: definition.risk(operation),
    payloadChecksum: "",
  } satisfies LidarrMutationPlanV1;
  const plan = {
    ...planWithoutSeal,
    payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
  } satisfies LidarrMutationPlanV1;
  assertLidarrMutationPlanV1(plan);
  return Object.freeze(plan);
}

function validateReferencedResources(
  references: readonly (LidarrPlanReferencedResource | LidarrArtistAddReferencedResource)[],
): void {
  if (references.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`operation references exceed the maximum of ${LIDARR_PLAN_MAX_ENTRIES}`);
  }
  const seen = new Set<string>();
  references.forEach((reference, index) => {
    const path = `operation references[${index}]`;
    const id = requirePositiveInteger(reference.id, `${path}.id`);
    const key = `${reference.kind}:${id}`;
    if (seen.has(key)) throw validationError(`operation references contain duplicate ${key}`);
    seen.add(key);
    if (reference.kind === "tag") {
      requireString(reference.label, `${path}.label`);
    } else if (reference.kind === "root-folder") {
      requireString(reference.path, `${path}.path`);
    } else {
      requireString(reference.name, `${path}.name`);
    }
  });
}

/** Builds, canonicalizes, validates, and checksum-seals one strict v2 mutation plan. */
export function buildLidarrMutationPlanV2(
  input: BuildLidarrMutationPlanV2Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrMutationPlanV2 {
  const origin = canonicalizeLidarrPlanOrigin(input.origin);
  const maxBatch = requirePositiveInteger(input.maxBatch, "maxBatch", LIDARR_PLAN_MAX_BATCH);
  if (input.entries.length === 0) throw validationError("entries must not be empty");
  if (input.entries.length > maxBatch) {
    throw validationError(`entries exceed maxBatch (${input.entries.length} > ${maxBatch})`);
  }
  if (input.entries.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`entries exceed the maximum of ${LIDARR_PLAN_MAX_ENTRIES}`);
  }

  const definition = getLidarrMutationOperationDefinition(input.operation);
  const operation = definition.canonicalize();
  validateReferencedResources(definition.referencedResources());
  const selection = canonicalizeSelection(requireSelectionV2(input.selection));
  const seen = new Set<number>();
  const entries = [...input.entries]
    .sort((left, right) => left.artistId - right.artistId)
    .map((source) => {
      const entry = definition.buildEntry(origin, source);
      if (seen.has(entry.artistId)) {
        throw validationError(`duplicate artist id ${entry.artistId}`);
      }
      seen.add(entry.artistId);
      return entry;
    });
  const changed = entries.filter((entry) => definition.hasChange(entry)).length;
  const now = dependencies.now?.() ?? new Date();
  const planWithoutSeal = {
    version: LIDARR_PLAN_VERSION_V2,
    id: dependencies.randomUUID?.() ?? nodeRandomUUID(),
    createdAt: now.toISOString(),
    createdBy: {
      host: dependencies.hostname?.() ?? nodeHostname(),
      user: dependencies.username?.() ?? userInfo().username,
      cliVersion: dependencies.cliVersion ?? pkg.version,
      cwd: dependencies.cwd?.() ?? process.cwd(),
    },
    command: "lidarr" as const,
    target: { origin },
    selection,
    operation,
    maxBatch,
    entries,
    review: { requested: entries.length, changed, unchanged: entries.length - changed },
    summary: definition.summarize(entries),
    risk: definition.risk(),
    payloadChecksum: "",
  } as LidarrMutationPlanV2;
  const plan: unknown = {
    ...planWithoutSeal,
    payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
  };
  assertLidarrMutationPlanV2(plan);
  return Object.freeze(plan);
}

/** Builds and seals a bounded expected-absent foreign-ID artist-add plan. */
export function buildLidarrArtistAddPlanV2(
  input: BuildLidarrArtistAddPlanV2Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrArtistAddPlanV2 {
  const origin = canonicalizeLidarrPlanOrigin(input.origin);
  const definition = getLidarrArtistAddOperationDefinition(input.operation);
  const operation = definition.canonicalize();
  validateReferencedResources(definition.referencedResources());
  const legacySelection = "entry" in input && input.entry !== undefined;
  const sources = legacySelection ? [input.entry] : input.entries;
  if (sources.length === 0 || sources.length > LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES) {
    throw validationError(
      `artist-add entries must contain from 1 through ${LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES} targets`,
    );
  }
  const seenForeignArtistIds = new Set<string>();
  const canonicalSources = sources.map((source, index) => {
    const path = legacySelection ? "entry" : `entries[${index}]`;
    const canonicalSource = canonicalizeLidarrArtistAddPlanEntryInput(source, path);
    const { foreignArtistId } = canonicalSource;
    if (seenForeignArtistIds.has(foreignArtistId)) {
      throw validationError(`artist-add entries contain duplicate MBID ${foreignArtistId}`);
    }
    seenForeignArtistIds.add(foreignArtistId);
    return canonicalSource;
  });
  const envelope = createLidarrPlanEnvelope(dependencies);
  if (isLidarrArtistAddExtendedOperation(operation)) {
    const after = Object.freeze({
      exists: true as const,
      rootFolder: operation.rootFolder,
      qualityProfile: operation.qualityProfile,
      metadataProfile: operation.metadataProfile,
      monitored: operation.monitored,
      monitorNewItems: "none" as const,
      searchForMissingAlbums: false as const,
      postAddUnmonitorSelectors: operation.postAddUnmonitorSelectors,
    });
    const builtEntries = canonicalSources.map((canonicalSource) => {
      const entryWithoutKey: LidarrArtistAddExtendedPlanEntryV2 = {
        id: `artist:${canonicalSource.foreignArtistId}`,
        artistName: canonicalSource.artistName,
        foreignArtistId: canonicalSource.foreignArtistId,
        before: Object.freeze({ exists: false }),
        after,
        provenance: canonicalSource.provenance,
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entryWithoutKey,
        idempotencyKey: definition.idempotencyKey(origin, entryWithoutKey),
      });
    });
    const firstEntry = builtEntries[0];
    if (firstEntry === undefined) throw validationError("artist-add entries must not be empty");
    const entries = Object.freeze([firstEntry, ...builtEntries.slice(1)]) as readonly [
      LidarrArtistAddExtendedPlanEntryV2,
      ...LidarrArtistAddExtendedPlanEntryV2[],
    ];
    const foreignArtistIds = Object.freeze(
      entries.map((entry) => entry.foreignArtistId),
    ) as readonly [string, ...string[]];
    const selection: LidarrArtistAddExtendedPlanV2["selection"] = legacySelection
      ? { kind: "foreign-artist-id", foreignArtistId: firstEntry.foreignArtistId }
      : { kind: "foreign-artist-ids", foreignArtistIds };
    const planWithoutSeal: LidarrArtistAddExtendedPlanV2 = {
      version: LIDARR_PLAN_VERSION_V2,
      ...envelope,
      command: "lidarr",
      target: { origin },
      selection,
      operation,
      maxBatch: entries.length,
      entries,
      review: { requested: entries.length, changed: entries.length, unchanged: 0 },
      summary: { kind: "artist-add", artists: entries.length },
      risk: definition.risk(),
      payloadChecksum: "",
    };
    const plan = Object.freeze({
      ...planWithoutSeal,
      payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
    });
    assertLidarrArtistAddPlanV2(plan);
    return plan;
  }
  const after = Object.freeze({
    exists: true as const,
    rootFolder: operation.rootFolder,
    qualityProfile: operation.qualityProfile,
    metadataProfile: operation.metadataProfile,
    monitored: false as const,
    monitorNewItems: "none" as const,
    searchForMissingAlbums: false as const,
  });
  const builtEntries = canonicalSources.map((canonicalSource) => {
    const entryWithoutKey: LidarrArtistAddLegacyPlanEntryV2 = {
      id: `artist:${canonicalSource.foreignArtistId}`,
      artistName: canonicalSource.artistName,
      foreignArtistId: canonicalSource.foreignArtistId,
      before: Object.freeze({ exists: false }),
      after,
      provenance: canonicalSource.provenance,
      idempotencyKey: "",
    };
    return Object.freeze({
      ...entryWithoutKey,
      idempotencyKey: definition.idempotencyKey(origin, entryWithoutKey),
    });
  });
  const firstEntry = builtEntries[0];
  if (firstEntry === undefined) {
    throw validationError("artist-add entries must not be empty");
  }
  const entries = Object.freeze([firstEntry, ...builtEntries.slice(1)]) as readonly [
    LidarrArtistAddLegacyPlanEntryV2,
    ...LidarrArtistAddLegacyPlanEntryV2[],
  ];
  const foreignArtistIds = Object.freeze(
    entries.map((entry) => entry.foreignArtistId),
  ) as readonly [string, ...string[]];
  const selection: LidarrArtistAddLegacyPlanV2["selection"] = legacySelection
    ? { kind: "foreign-artist-id", foreignArtistId: firstEntry.foreignArtistId }
    : {
        kind: "foreign-artist-ids",
        foreignArtistIds,
      };
  const planWithoutSeal: LidarrArtistAddLegacyPlanV2 = {
    version: LIDARR_PLAN_VERSION_V2,
    ...envelope,
    command: "lidarr",
    target: { origin },
    selection,
    operation,
    maxBatch: entries.length,
    entries,
    review: { requested: entries.length, changed: entries.length, unchanged: 0 },
    summary: { kind: "artist-add", artists: entries.length },
    risk: definition.risk(),
    payloadChecksum: "",
  };
  const plan = Object.freeze({
    ...planWithoutSeal,
    payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
  });
  assertLidarrArtistAddPlanV2(plan);
  return plan;
}

type SealedLidarrPlanV3<TSeed extends LidarrPlanV3Seed> = TSeed & {
  readonly version: typeof LIDARR_PLAN_VERSION_V3;
  readonly cascadeAnalysis: LidarrCascadeAnalysis;
  readonly payloadChecksum: string;
};

function cascadeFactsFromPlan(
  plan: Pick<LidarrPlanV3, "operation" | "entries">,
): LidarrCascadePlanFacts {
  return {
    operation: plan.operation,
    entries: plan.entries,
  } as unknown as LidarrCascadePlanFacts;
}

/**
 * Adds deterministic cascade evidence and a v3 checksum to already canonical
 * plan facts. Family builders remain responsible for their existing facts.
 */
export function sealLidarrMutationPlanV3<TSeed extends LidarrPlanV3Seed>(
  seed: TSeed,
  cascadePolicy: LidarrCascadePolicy,
): SealedLidarrPlanV3<TSeed> {
  const cascadeAnalysis = analyzeLidarrCascade(
    cascadeFactsFromPlan(seed as Pick<LidarrPlanV3, "operation" | "entries">),
    cascadePolicy,
  );
  const planWithoutSeal = {
    version: LIDARR_PLAN_VERSION_V3,
    ...seed,
    cascadeAnalysis,
    payloadChecksum: "",
  } as SealedLidarrPlanV3<TSeed>;
  const plan = {
    ...planWithoutSeal,
    payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal as LidarrPlanV3),
  } as SealedLidarrPlanV3<TSeed>;
  assertLidarrMutationPlanV3(plan);
  return Object.freeze(plan) as unknown as SealedLidarrPlanV3<TSeed>;
}

/** Builds an ordinary artist mutation plan with sealed v3 cascade evidence. */
export function buildLidarrMutationPlanV3(
  input: BuildLidarrMutationPlanV3Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrMutationPlanV3 {
  const { cascadePolicy, ...legacyInput } = input;
  const legacy = buildLidarrMutationPlanV2(legacyInput, dependencies);
  const { version: _version, payloadChecksum: _payloadChecksum, ...seed } = legacy;
  return sealLidarrMutationPlanV3(seed, cascadePolicy);
}

/** Builds an expected-absent artist-add plan with sealed v3 cascade evidence. */
export function buildLidarrArtistAddPlanV3(
  input: BuildLidarrArtistAddPlanV3Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrArtistAddPlanV3 {
  const { cascadePolicy, ...legacyInput } = input;
  const legacy = buildLidarrArtistAddPlanV2(legacyInput, dependencies);
  const { version: _version, payloadChecksum: _payloadChecksum, ...seed } = legacy;
  return sealLidarrMutationPlanV3(seed, cascadePolicy);
}

/** Builds a legacy-shaped album-monitoring plan in the strict v3 envelope. */
export function buildLidarrAlbumMonitoringPlanV3(
  input: BuildLidarrAlbumMonitoringPlanV3Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrAlbumMonitoringPlanV3 {
  const { cascadePolicy, ...legacyInput } = input;
  const legacy = buildLidarrMutationPlan(legacyInput, dependencies);
  if (legacy.operation.kind !== "album-monitoring") {
    throw validationError("album-monitoring v3 builder requires an album-monitoring operation");
  }
  const { version: _version, payloadChecksum: _payloadChecksum, ...seed } = legacy;
  return sealLidarrMutationPlanV3(
    seed as Omit<LidarrAlbumMonitoringPlanV3, "version" | "cascadeAnalysis" | "payloadChecksum">,
    cascadePolicy,
  );
}

const MAX_OPERATION_SELECTORS = 64;
const ARTIST_ADD_SELECTOR_ALLOWLIST: ReadonlySet<string> = new Set(LIDARR_ALBUM_TYPE_SELECTORS);

function requireSortedUniqueSelectors(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_OPERATION_SELECTORS) {
    throw validationError(`${path} must be a bounded array`);
  }
  const selectors = value.map((item, index) => requireString(item, `${path}[${index}]`));
  for (let index = 1; index < selectors.length; index += 1) {
    if (selectors[index - 1]! >= selectors[index]!) {
      throw validationError(`${path} must be sorted and unique`);
    }
  }
  return selectors;
}

function requireSelectors(value: unknown): readonly string[] {
  return requireSortedUniqueSelectors(value, "plan.operation.selectors");
}

function requireArtistAddSelectors(value: unknown, path: string): readonly string[] {
  const selectors = requireSortedUniqueSelectors(value, path);
  for (const [index, selector] of selectors.entries()) {
    if (!ARTIST_ADD_SELECTOR_ALLOWLIST.has(selector)) {
      throw validationError(`${path}[${index}] is not a supported album type selector`);
    }
  }
  return selectors;
}

function requireOperation(value: unknown): LidarrMutationOperation {
  const operation = requireRecord(value, "plan.operation");
  const kind = operation["kind"];
  if (kind === "artist-monitoring") {
    requireExactKeys(operation, "plan.operation", ["kind", "desiredMonitored"]);
    return {
      kind,
      desiredMonitored: requireBoolean(
        operation["desiredMonitored"],
        "plan.operation.desiredMonitored",
      ),
    };
  }
  if (kind === "album-monitoring") {
    requireExactKeys(operation, "plan.operation", ["kind", "desiredMonitored", "selectors"]);
    return {
      kind,
      desiredMonitored: requireBoolean(
        operation["desiredMonitored"],
        "plan.operation.desiredMonitored",
      ),
      selectors: requireSelectors(operation["selectors"]),
    };
  }
  throw validationError(`unsupported Lidarr mutation operation ${JSON.stringify(kind)}`);
}

function assertEntry(
  value: unknown,
  index: number,
  kind: LidarrMutationOperation["kind"],
): asserts value is LidarrMutationPlanEntry {
  const path = `plan.entries[${index}]`;
  const entry = requireRecord(value, path);
  if (kind === "album-monitoring") {
    requireExactKeys(
      entry,
      path,
      [
        "id",
        "albumId",
        "albumTitle",
        "artistId",
        "artistName",
        "before",
        "after",
        "idempotencyKey",
      ],
      ["albumType"],
    );
    const id = requireString(entry["id"], `${path}.id`);
    const albumId = requirePositiveInteger(entry["albumId"], `${path}.albumId`);
    if (id !== `album:${albumId}`) throw validationError(`${path}.id does not match albumId`);
    requireString(entry["albumTitle"], `${path}.albumTitle`, true);
    requirePositiveInteger(entry["artistId"], `${path}.artistId`);
    requireString(entry["artistName"], `${path}.artistName`);
    if (entry["albumType"] !== undefined) requireString(entry["albumType"], `${path}.albumType`);
  } else {
    requireExactKeys(entry, path, [
      "id",
      "artistId",
      "artistName",
      "before",
      "after",
      "idempotencyKey",
    ]);
    const id = requireString(entry["id"], `${path}.id`);
    const artistId = requirePositiveInteger(entry["artistId"], `${path}.artistId`);
    if (id !== `artist:${artistId}`) throw validationError(`${path}.id does not match artistId`);
    requireString(entry["artistName"], `${path}.artistName`);
  }
  for (const stateName of ["before", "after"] as const) {
    const state = requireRecord(entry[stateName], `${path}.${stateName}`);
    requireExactKeys(state, `${path}.${stateName}`, ["monitored"]);
    requireBoolean(state["monitored"], `${path}.${stateName}.monitored`);
  }
  const key = requireString(entry["idempotencyKey"], `${path}.idempotencyKey`);
  if (!CHECKSUM_PATTERN.test(key)) throw validationError(`${path}.idempotencyKey is invalid`);
}

/** Exact allowlist validator for untrusted Lidarr plan JSON. */
export function assertLidarrMutationPlanV1(value: unknown): asserts value is LidarrMutationPlanV1 {
  assertNoSensitiveKeys(value);
  const plan = requireRecord(value, "plan");
  requireExactKeys(plan, "plan", [
    "version",
    "id",
    "createdAt",
    "createdBy",
    "command",
    "target",
    "operation",
    "maxBatch",
    "entries",
    "review",
    "risk",
    "payloadChecksum",
  ]);
  if (plan["version"] !== LIDARR_PLAN_VERSION) {
    throw validationError(`unsupported plan version ${JSON.stringify(plan["version"])}`);
  }
  const id = requireString(plan["id"], "plan.id");
  if (!UUID_PATTERN.test(id)) throw validationError("plan.id must be a UUID");
  const createdAt = requireString(plan["createdAt"], "plan.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw validationError("plan.createdAt is invalid");
  const createdBy = requireRecord(plan["createdBy"], "plan.createdBy");
  requireExactKeys(createdBy, "plan.createdBy", ["host", "user", "cliVersion", "cwd"]);
  for (const key of ["host", "user", "cliVersion", "cwd"] as const) {
    requireString(createdBy[key], `plan.createdBy.${key}`, key === "cwd");
  }
  if (plan["command"] !== "lidarr") throw validationError('plan.command must be "lidarr"');
  const target = requireRecord(plan["target"], "plan.target");
  requireExactKeys(target, "plan.target", ["origin"]);
  const origin = canonicalizeLidarrPlanOrigin(
    requireString(target["origin"], "plan.target.origin"),
  );
  const operation = requireOperation(plan["operation"]);
  const definition = getLidarrMutationOperationDefinition(operation);
  const maxBatch = requirePositiveInteger(plan["maxBatch"], "plan.maxBatch", LIDARR_PLAN_MAX_BATCH);
  if (!Array.isArray(plan["entries"]) || plan["entries"].length === 0) {
    throw validationError("plan.entries must be a non-empty array");
  }
  if (plan["entries"].length > maxBatch || plan["entries"].length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError("plan.entries exceeds its bound");
  }
  const seenIds = new Set<string>();
  const seenTargets = new Set<number>();
  let lastTargetId = 0;
  plan["entries"].forEach((entry, index) => {
    assertEntry(entry, index, operation.kind);
    const isAlbumEntry = isLidarrAlbumPlanEntry(entry);
    const targetId = isAlbumEntry ? entry.albumId : entry.artistId;
    if (seenIds.has(entry.id) || seenTargets.has(targetId)) {
      throw validationError(`plan.entries contains duplicate target ${entry.id}`);
    }
    if (targetId <= lastTargetId) {
      throw validationError(
        `plan.entries must be sorted by ${isAlbumEntry ? "albumId" : "artistId"}`,
      );
    }
    lastTargetId = targetId;
    seenIds.add(entry.id);
    seenTargets.add(targetId);
    if (entry.after.monitored !== operation.desiredMonitored) {
      throw validationError(`plan.entries[${index}].after is inconsistent with plan.operation`);
    }
    const expectedKey = definition.idempotencyKey(origin, entry);
    if (entry.idempotencyKey !== expectedKey) {
      throw validationError(`plan.entries[${index}].idempotencyKey is inconsistent`);
    }
  });
  const review = requireRecord(plan["review"], "plan.review");
  requireExactKeys(review, "plan.review", ["requested", "changed", "unchanged"]);
  const requested = requirePositiveInteger(review["requested"], "plan.review.requested", maxBatch);
  const changed = requirePositiveIntegerOrZero(review["changed"], "plan.review.changed", requested);
  const unchanged = requirePositiveIntegerOrZero(
    review["unchanged"],
    "plan.review.unchanged",
    requested,
  );
  if (requested !== plan["entries"].length || changed + unchanged !== requested) {
    throw validationError("plan.review counts do not match entries");
  }
  const expectedChanged = plan["entries"].filter(
    (entry) => entry.before.monitored !== entry.after.monitored,
  ).length;
  if (changed !== expectedChanged)
    throw validationError("plan.review changed count is inconsistent");
  const risk = requireRecord(plan["risk"], "plan.risk");
  requireExactKeys(risk, "plan.risk", ["level", "destructive", "cascade"]);
  const expectedRisk = definition.risk(operation);
  if (risk["level"] !== expectedRisk.level || risk["destructive"] !== expectedRisk.destructive) {
    throw validationError("plan.risk is inconsistent with plan.operation");
  }
  if (
    !Array.isArray(risk["cascade"]) ||
    risk["cascade"].length === 0 ||
    risk["cascade"].length > 20
  ) {
    throw validationError("plan.risk.cascade must be a bounded non-empty array");
  }
  risk["cascade"].forEach((item, index) => requireString(item, `plan.risk.cascade[${index}]`));
  if (
    risk["cascade"].length !== expectedRisk.cascade.length ||
    risk["cascade"].some((item, index) => item !== expectedRisk.cascade[index])
  ) {
    throw validationError("plan.risk.cascade is inconsistent with plan.operation");
  }
  const checksum = requireString(plan["payloadChecksum"], "plan.payloadChecksum");
  if (!CHECKSUM_PATTERN.test(checksum)) throw validationError("plan.payloadChecksum is invalid");
}

function requireResourceReference(value: unknown, path: string): LidarrPlanResourceReference {
  const reference = requireRecord(value, path);
  requireExactKeys(reference, path, ["id", "name"]);
  return {
    id: requirePositiveInteger(reference["id"], `${path}.id`),
    name: requireString(reference["name"], `${path}.name`),
  };
}

function requireRootFolderReference(value: unknown, path: string): LidarrPlanRootFolderReference {
  const reference = requireRecord(value, path);
  requireExactKeys(reference, path, ["id", "path"]);
  return {
    id: requirePositiveInteger(reference["id"], `${path}.id`),
    path: requireString(reference["path"], `${path}.path`),
  };
}

function requireTagReference(value: unknown, path: string): LidarrPlanTagReference {
  const reference = requireRecord(value, path);
  requireExactKeys(reference, path, ["id", "label"]);
  return {
    id: requirePositiveInteger(reference["id"], `${path}.id`),
    label: requireString(reference["label"], `${path}.label`),
  };
}

function requireSortedTagReferences(
  value: unknown,
  path: string,
): readonly LidarrPlanTagReference[] {
  if (!Array.isArray(value) || value.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`${path} must be a bounded array`);
  }
  let previousId = 0;
  return value.map((item, index) => {
    const reference = requireTagReference(item, `${path}[${index}]`);
    if (reference.id <= previousId) {
      throw validationError(`${path} must be sorted by unique tag id`);
    }
    previousId = reference.id;
    return reference;
  });
}

function requireSelectionV2(
  value: unknown,
): LidarrPlanSelectionV2Extended | LidarrArtistAddPlanV2["selection"] {
  const selection = requireRecord(value, "plan.selection");
  const kind = selection["kind"];
  switch (kind) {
    case "foreign-artist-id": {
      requireExactKeys(selection, "plan.selection", ["kind", "foreignArtistId"]);
      const foreignArtistId = requireString(
        selection["foreignArtistId"],
        "plan.selection.foreignArtistId",
      );
      if (!CANONICAL_MUSICBRAINZ_ID_PATTERN.test(foreignArtistId)) {
        throw validationError("plan.selection.foreignArtistId is invalid");
      }
      return { kind, foreignArtistId };
    }
    case "foreign-artist-ids": {
      requireExactKeys(selection, "plan.selection", ["kind", "foreignArtistIds"]);
      if (
        !Array.isArray(selection["foreignArtistIds"]) ||
        selection["foreignArtistIds"].length === 0 ||
        selection["foreignArtistIds"].length > LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES
      ) {
        throw validationError("plan.selection.foreignArtistIds must be a bounded non-empty array");
      }
      const seen = new Set<string>();
      const foreignArtistIds = selection["foreignArtistIds"].map((item, index) => {
        const foreignArtistId = requireString(item, `plan.selection.foreignArtistIds[${index}]`);
        if (!CANONICAL_MUSICBRAINZ_ID_PATTERN.test(foreignArtistId)) {
          throw validationError(`plan.selection.foreignArtistIds[${index}] is invalid`);
        }
        if (seen.has(foreignArtistId)) {
          throw validationError("plan.selection.foreignArtistIds must be unique");
        }
        seen.add(foreignArtistId);
        return foreignArtistId;
      });
      const firstForeignArtistId = foreignArtistIds[0];
      if (firstForeignArtistId === undefined) {
        throw validationError("plan.selection.foreignArtistIds must not be empty");
      }
      return {
        kind,
        foreignArtistIds: [firstForeignArtistId, ...foreignArtistIds.slice(1)],
      };
    }
    case "album-track-filter":
      return requireLidarrTrackFilterSelection(selection);
    case "album-ids":
    case "album-filters":
      return requireLidarrAlbumPlanSelection(selection);
    case "ids": {
      requireExactKeys(selection, "plan.selection", ["kind", "artistIds"]);
      if (
        !Array.isArray(selection["artistIds"]) ||
        selection["artistIds"].length === 0 ||
        selection["artistIds"].length > LIDARR_PLAN_MAX_ENTRIES
      ) {
        throw validationError("plan.selection.artistIds must be a bounded non-empty array");
      }
      let previousId = 0;
      const artistIds = selection["artistIds"].map((item, index) => {
        const artistId = requirePositiveInteger(item, `plan.selection.artistIds[${index}]`);
        if (artistId <= previousId) {
          throw validationError("plan.selection.artistIds must be sorted and unique");
        }
        previousId = artistId;
        return artistId;
      });
      return { kind, artistIds };
    }
    case "filters": {
      requireExactKeys(
        selection,
        "plan.selection",
        ["kind"],
        ["monitored", "qualityProfile", "metadataProfile", "tags"],
      );
      const monitored =
        selection["monitored"] === undefined
          ? undefined
          : requireBoolean(selection["monitored"], "plan.selection.monitored");
      const qualityProfile =
        selection["qualityProfile"] === undefined
          ? undefined
          : requireResourceReference(selection["qualityProfile"], "plan.selection.qualityProfile");
      const metadataProfile =
        selection["metadataProfile"] === undefined
          ? undefined
          : requireResourceReference(
              selection["metadataProfile"],
              "plan.selection.metadataProfile",
            );
      const tags =
        selection["tags"] === undefined
          ? undefined
          : requireSortedTagReferences(selection["tags"], "plan.selection.tags");
      if (
        monitored === undefined &&
        qualityProfile === undefined &&
        metadataProfile === undefined &&
        (tags === undefined || tags.length === 0)
      ) {
        throw validationError("plan.selection filters must not be empty");
      }
      if (tags !== undefined && tags.length === 0) {
        throw validationError("plan.selection.tags must not be empty when present");
      }
      return {
        kind,
        ...(monitored === undefined ? {} : { monitored }),
        ...(qualityProfile === undefined ? {} : { qualityProfile }),
        ...(metadataProfile === undefined ? {} : { metadataProfile }),
        ...(tags === undefined ? {} : { tags }),
      };
    }
    case "all":
      requireExactKeys(selection, "plan.selection", ["kind"]);
      return { kind };
    default:
      throw validationError("plan.selection.kind is invalid");
  }
}

function requireOperationV2(
  value: unknown,
): LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2 {
  const operation = requireRecord(value, "plan.operation");
  switch (operation["kind"]) {
    case "artist-add": {
      const extended = Object.hasOwn(operation, "postAddUnmonitorSelectors");
      requireExactKeys(operation, "plan.operation", [
        "kind",
        "rootFolder",
        "qualityProfile",
        "metadataProfile",
        "monitored",
        "monitorNewItems",
        "searchForMissingAlbums",
        ...(extended ? ["postAddUnmonitorSelectors"] : []),
      ]);
      if (
        operation["monitorNewItems"] !== "none" ||
        operation["searchForMissingAlbums"] !== false
      ) {
        throw validationError("plan.operation artist-add policy is invalid");
      }
      const common = {
        kind: "artist-add" as const,
        rootFolder: requireRootFolderReference(
          operation["rootFolder"],
          "plan.operation.rootFolder",
        ),
        qualityProfile: requireResourceReference(
          operation["qualityProfile"],
          "plan.operation.qualityProfile",
        ),
        metadataProfile: requireResourceReference(
          operation["metadataProfile"],
          "plan.operation.metadataProfile",
        ),
        monitorNewItems: "none" as const,
        searchForMissingAlbums: false as const,
      };
      if (extended) {
        return {
          ...common,
          monitored: requireBoolean(operation["monitored"], "plan.operation.monitored"),
          postAddUnmonitorSelectors: requireArtistAddSelectors(
            operation["postAddUnmonitorSelectors"],
            "plan.operation.postAddUnmonitorSelectors",
          ),
        };
      }
      if (operation["monitored"] !== false) {
        throw validationError("plan.operation artist-add policy is invalid");
      }
      return { ...common, monitored: false };
    }
    case "track-file-filter":
      return requireLidarrTrackFilterOperation(operation);
    case "album-edit":
      return requireAlbumEditOperation(operation);
    case "album-delete":
      return requireAlbumDeleteOperation(operation);
    case "artist-monitoring":
      requireExactKeys(operation, "plan.operation", ["kind", "desiredMonitored"]);
      return {
        kind: "artist-monitoring",
        desiredMonitored: requireBoolean(
          operation["desiredMonitored"],
          "plan.operation.desiredMonitored",
        ),
      };
    case "artist-profile-assignment": {
      requireExactKeys(
        operation,
        "plan.operation",
        ["kind"],
        ["qualityProfile", "metadataProfile"],
      );
      const qualityProfile =
        operation["qualityProfile"] === undefined
          ? undefined
          : requireResourceReference(operation["qualityProfile"], "plan.operation.qualityProfile");
      const metadataProfile =
        operation["metadataProfile"] === undefined
          ? undefined
          : requireResourceReference(
              operation["metadataProfile"],
              "plan.operation.metadataProfile",
            );
      if (qualityProfile === undefined && metadataProfile === undefined) {
        throw validationError("plan.operation must manage at least one profile");
      }
      return {
        kind: "artist-profile-assignment",
        ...(qualityProfile === undefined ? {} : { qualityProfile }),
        ...(metadataProfile === undefined ? {} : { metadataProfile }),
      };
    }
    case "artist-tag-mutation": {
      requireExactKeys(operation, "plan.operation", ["kind", "mode", "tags"]);
      const mode = operation["mode"];
      if (mode !== "add" && mode !== "remove" && mode !== "set" && mode !== "clear") {
        throw validationError("plan.operation.mode is invalid");
      }
      const tags = requireSortedTagReferences(operation["tags"], "plan.operation.tags");
      if ((mode === "clear" && tags.length !== 0) || (mode !== "clear" && tags.length === 0)) {
        throw validationError("plan.operation tags are inconsistent with tag mode");
      }
      return { kind: "artist-tag-mutation", mode, tags };
    }
    case "artist-delete":
      requireExactKeys(operation, "plan.operation", ["kind", "deleteFiles"]);
      return {
        kind: "artist-delete",
        deleteFiles: requireBoolean(operation["deleteFiles"], "plan.operation.deleteFiles"),
      };
    default:
      throw validationError("plan.operation.kind is invalid");
  }
}

function sameTagReferences(
  left: readonly LidarrPlanTagReference[],
  right: readonly LidarrPlanTagReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (reference, index) =>
        reference.id === right[index]?.id && reference.label === right[index]?.label,
    )
  );
}

function requireProfileState(
  value: unknown,
  path: string,
  operation: LidarrArtistProfileAssignmentOperation,
): LidarrArtistProfilePlanEntry["before"] {
  const state = requireRecord(value, path);
  const managedKeys = [
    ...(operation.qualityProfile === undefined ? [] : ["qualityProfile"]),
    ...(operation.metadataProfile === undefined ? [] : ["metadataProfile"]),
  ];
  requireExactKeys(state, path, managedKeys);
  return {
    ...(operation.qualityProfile === undefined
      ? {}
      : {
          qualityProfile: requireResourceReference(
            state["qualityProfile"],
            `${path}.qualityProfile`,
          ),
        }),
    ...(operation.metadataProfile === undefined
      ? {}
      : {
          metadataProfile: requireResourceReference(
            state["metadataProfile"],
            `${path}.metadataProfile`,
          ),
        }),
  };
}

function requireDeleteEvidence(value: unknown, path: string): LidarrArtistDeleteEvidence {
  const evidence = requireRecord(value, path);
  requireExactKeys(evidence, path, ["path", "albumCount", "trackFileCount", "sizeOnDisk"]);
  return {
    path: requireString(evidence["path"], `${path}.path`),
    albumCount: requirePositiveIntegerOrZero(
      evidence["albumCount"],
      `${path}.albumCount`,
      Number.MAX_SAFE_INTEGER,
    ),
    trackFileCount: requirePositiveIntegerOrZero(
      evidence["trackFileCount"],
      `${path}.trackFileCount`,
      Number.MAX_SAFE_INTEGER,
    ),
    sizeOnDisk: requirePositiveIntegerOrZero(
      evidence["sizeOnDisk"],
      `${path}.sizeOnDisk`,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function requireArtistAddProvenance(
  value: unknown,
  path: string,
  artistName: string,
): LidarrArtistAddProvenanceV2 {
  const provenance = requireRecord(value, path);
  requireExactKeys(
    provenance,
    path,
    ["source", "method", "seedArtist", "similarity", "candidateUrl", "discoveredAt"],
    [
      "selectedRank",
      "parentArtist",
      "depth",
      "providerRank",
      "firstSeenSequence",
      "firstPath",
      "adjustedScore",
      "exposureCount",
      "popularityEvidence",
    ],
  );
  return canonicalizeArtistAddProvenance(
    {
      source: provenance["source"] as "lastfm",
      method: provenance["method"] as "artist.getSimilar",
      seedArtist: provenance["seedArtist"] as string,
      similarity: provenance["similarity"] as number,
      candidateUrl: provenance["candidateUrl"] as string,
      discoveredAt: provenance["discoveredAt"] as string,
      ...(provenance["selectedRank"] === undefined
        ? {}
        : { selectedRank: provenance["selectedRank"] as number }),
      ...(provenance["parentArtist"] === undefined
        ? {}
        : { parentArtist: provenance["parentArtist"] as string }),
      ...(provenance["depth"] === undefined ? {} : { depth: provenance["depth"] as number }),
      ...(provenance["providerRank"] === undefined
        ? {}
        : { providerRank: provenance["providerRank"] as number }),
      ...(provenance["firstSeenSequence"] === undefined
        ? {}
        : { firstSeenSequence: provenance["firstSeenSequence"] as number }),
      ...(provenance["firstPath"] === undefined
        ? {}
        : { firstPath: provenance["firstPath"] as readonly string[] }),
      ...(provenance["adjustedScore"] === undefined
        ? {}
        : { adjustedScore: provenance["adjustedScore"] as number }),
      ...(provenance["exposureCount"] === undefined
        ? {}
        : { exposureCount: provenance["exposureCount"] as number }),
      ...(provenance["popularityEvidence"] === undefined
        ? {}
        : {
            popularityEvidence: provenance[
              "popularityEvidence"
            ] as LidarrArtistAddProvenanceV2["popularityEvidence"],
          }),
    },
    path,
    artistName,
  );
}

function isAlbumOperationV2(
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
): operation is Extract<
  LidarrMutationOperationV2Extended,
  { readonly kind: "album-edit" | "album-delete" }
> {
  return operation.kind === "album-edit" || operation.kind === "album-delete";
}

function expectedV2IdempotencyKey(
  origin: string,
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
  entry: LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2,
): string {
  if (operation.kind === "artist-add") {
    return getLidarrArtistAddOperationDefinition(operation).idempotencyKey(
      origin,
      entry as LidarrArtistAddPlanEntryV2,
    );
  }
  if (operation.kind === "track-file-filter") {
    return trackFilterIdempotencyKey(origin, operation, entry as LidarrTrackFileFilterPlanEntryV2);
  }
  if (isAlbumOperationV2(operation)) {
    return getLidarrAlbumMutationOperationDefinition(operation).idempotencyKey(
      origin,
      entry as LidarrAlbumMutationPlanEntryV2,
    );
  }
  return getLidarrMutationOperationDefinition(operation).idempotencyKey(
    origin,
    entry as LidarrMutationPlanEntryV2,
  );
}

function expectedV2Risk(
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
): LidarrPlanRiskSummary {
  if (operation.kind === "artist-add") {
    return getLidarrArtistAddOperationDefinition(operation).risk();
  }
  if (operation.kind === "track-file-filter") {
    return LIDARR_TRACK_FILTER_RISK;
  }
  if (isAlbumOperationV2(operation)) {
    return getLidarrAlbumMutationOperationDefinition(operation).risk();
  }
  return getLidarrMutationOperationDefinition(operation).risk();
}

function expectedV2ChangedCount(
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
  entries: readonly (LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2)[],
): number {
  if (operation.kind === "artist-add") return entries.length;
  if (operation.kind === "track-file-filter") {
    return (
      (entries[0] as LidarrTrackFileFilterPlanEntryV2 | undefined)?.before.deleteCandidates
        .length ?? 0
    );
  }
  if (isAlbumOperationV2(operation)) {
    const definition = getLidarrAlbumMutationOperationDefinition(operation);
    return entries.filter((entry) => definition.hasChange(entry as LidarrAlbumMutationPlanEntryV2))
      .length;
  }
  const definition = getLidarrMutationOperationDefinition(operation);
  return entries.filter((entry) => definition.hasChange(entry as LidarrMutationPlanEntryV2)).length;
}

function requireEntryIdentity(
  entry: UnknownRecord,
  path: string,
): { readonly id: string; readonly artistId: number; readonly artistName: string } {
  const id = requireString(entry["id"], `${path}.id`);
  const artistId = requirePositiveInteger(entry["artistId"], `${path}.artistId`);
  if (id !== `artist:${artistId}`) throw validationError(`${path}.id does not match artistId`);
  return {
    id,
    artistId,
    artistName: requireString(entry["artistName"], `${path}.artistName`),
  };
}

function requireEntryV2(
  value: unknown,
  index: number,
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
): LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2 {
  const path = `plan.entries[${index}]`;
  const entry = requireRecord(value, path);
  switch (operation.kind) {
    case "artist-add": {
      requireExactKeys(entry, path, [
        "id",
        "artistName",
        "foreignArtistId",
        "before",
        "after",
        "provenance",
        "idempotencyKey",
      ]);
      const foreignArtistId = requireString(entry["foreignArtistId"], `${path}.foreignArtistId`);
      if (!CANONICAL_MUSICBRAINZ_ID_PATTERN.test(foreignArtistId)) {
        throw validationError(`${path}.foreignArtistId is invalid`);
      }
      const id = requireString(entry["id"], `${path}.id`);
      if (id !== `artist:${foreignArtistId}`) {
        throw validationError(`${path}.id does not match foreignArtistId`);
      }
      const before = requireRecord(entry["before"], `${path}.before`);
      requireExactKeys(before, `${path}.before`, ["exists"]);
      if (before["exists"] !== false) {
        throw validationError(`${path}.before must seal artist absence`);
      }
      const after = requireRecord(entry["after"], `${path}.after`);
      const extended = isLidarrArtistAddExtendedOperation(operation);
      requireExactKeys(after, `${path}.after`, [
        "exists",
        "rootFolder",
        "qualityProfile",
        "metadataProfile",
        "monitored",
        "monitorNewItems",
        "searchForMissingAlbums",
        ...(extended ? ["postAddUnmonitorSelectors"] : []),
      ]);
      const rootFolder = requireRootFolderReference(
        after["rootFolder"],
        `${path}.after.rootFolder`,
      );
      const qualityProfile = requireResourceReference(
        after["qualityProfile"],
        `${path}.after.qualityProfile`,
      );
      const metadataProfile = requireResourceReference(
        after["metadataProfile"],
        `${path}.after.metadataProfile`,
      );
      const monitored = extended
        ? requireBoolean(after["monitored"], `${path}.after.monitored`)
        : after["monitored"];
      const postAddUnmonitorSelectors = extended
        ? requireArtistAddSelectors(
            after["postAddUnmonitorSelectors"],
            `${path}.after.postAddUnmonitorSelectors`,
          )
        : undefined;
      if (
        after["exists"] !== true ||
        monitored !== operation.monitored ||
        after["monitorNewItems"] !== "none" ||
        after["searchForMissingAlbums"] !== false ||
        rootFolder.id !== operation.rootFolder.id ||
        rootFolder.path !== operation.rootFolder.path ||
        !sameResourceReference(qualityProfile, operation.qualityProfile) ||
        !sameResourceReference(metadataProfile, operation.metadataProfile) ||
        (extended &&
          (postAddUnmonitorSelectors?.length !== operation.postAddUnmonitorSelectors.length ||
            postAddUnmonitorSelectors.some(
              (selector, selectorIndex) =>
                selector !== operation.postAddUnmonitorSelectors[selectorIndex],
            )))
      ) {
        throw validationError(`${path}.after is inconsistent with plan.operation`);
      }
      const artistName = requireString(entry["artistName"], `${path}.artistName`);
      const common = {
        id,
        artistName,
        foreignArtistId,
        before: { exists: false },
        after: {
          exists: true,
          rootFolder,
          qualityProfile,
          metadataProfile,
          monitored: operation.monitored,
          monitorNewItems: "none",
          searchForMissingAlbums: false,
          ...(extended
            ? {
                postAddUnmonitorSelectors: postAddUnmonitorSelectors ?? [],
              }
            : {}),
        },
        provenance: requireArtistAddProvenance(
          entry["provenance"],
          `${path}.provenance`,
          artistName,
        ),
        idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
      };
      return common as LidarrArtistAddPlanEntryV2;
    }
    case "track-file-filter": {
      if (index !== 0) throw validationError("track-file-filter requires exactly one entry");
      const selection = requireLidarrTrackFilterSelection({
        kind: "album-track-filter",
        albumId: requirePositiveInteger(entry["albumId"], `${path}.albumId`),
      });
      return requireLidarrTrackFilterEntry(entry, operation, selection);
    }
    case "album-edit":
      return requireAlbumEditEntry(entry, index, operation);
    case "album-delete":
      return requireAlbumDeleteEntry(entry, index, operation);
    case "artist-monitoring": {
      requireExactKeys(entry, path, [
        "id",
        "artistId",
        "artistName",
        "before",
        "after",
        "idempotencyKey",
      ]);
      const identity = requireEntryIdentity(entry, path);
      const before = requireRecord(entry["before"], `${path}.before`);
      const after = requireRecord(entry["after"], `${path}.after`);
      requireExactKeys(before, `${path}.before`, ["monitored"]);
      requireExactKeys(after, `${path}.after`, ["monitored"]);
      const result: LidarrArtistMonitoringPlanEntry = {
        ...identity,
        before: {
          monitored: requireBoolean(before["monitored"], `${path}.before.monitored`),
        },
        after: {
          monitored: requireBoolean(after["monitored"], `${path}.after.monitored`),
        },
        idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
      };
      if (result.after.monitored !== operation.desiredMonitored) {
        throw validationError(`${path}.after is inconsistent with plan.operation`);
      }
      return result;
    }
    case "artist-profile-assignment": {
      requireExactKeys(entry, path, [
        "id",
        "artistId",
        "artistName",
        "before",
        "after",
        "idempotencyKey",
      ]);
      const identity = requireEntryIdentity(entry, path);
      const before = requireProfileState(entry["before"], `${path}.before`, operation);
      const after = requireProfileState(entry["after"], `${path}.after`, operation);
      if (
        !sameResourceReference(after.qualityProfile, operation.qualityProfile) ||
        !sameResourceReference(after.metadataProfile, operation.metadataProfile)
      ) {
        throw validationError(`${path}.after is inconsistent with plan.operation`);
      }
      return {
        ...identity,
        before,
        after,
        idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
      };
    }
    case "artist-tag-mutation": {
      requireExactKeys(entry, path, [
        "id",
        "artistId",
        "artistName",
        "before",
        "after",
        "added",
        "removed",
        "retained",
        "idempotencyKey",
      ]);
      const identity = requireEntryIdentity(entry, path);
      const beforeState = requireRecord(entry["before"], `${path}.before`);
      const afterState = requireRecord(entry["after"], `${path}.after`);
      requireExactKeys(beforeState, `${path}.before`, ["tags"]);
      requireExactKeys(afterState, `${path}.after`, ["tags"]);
      const before = requireSortedTagReferences(beforeState["tags"], `${path}.before.tags`);
      const after = requireSortedTagReferences(afterState["tags"], `${path}.after.tags`);
      const expectedAfter = calculateTagAfter(before, operation);
      if (!sameTagReferences(after, expectedAfter)) {
        throw validationError(`${path}.after is inconsistent with plan.operation`);
      }
      const delta = calculateTagDelta(before, after);
      const added = requireSortedTagReferences(entry["added"], `${path}.added`);
      const removed = requireSortedTagReferences(entry["removed"], `${path}.removed`);
      const retained = requireSortedTagReferences(entry["retained"], `${path}.retained`);
      if (
        !sameTagReferences(added, delta.added) ||
        !sameTagReferences(removed, delta.removed) ||
        !sameTagReferences(retained, delta.retained)
      ) {
        throw validationError(`${path} tag delta is inconsistent`);
      }
      return {
        ...identity,
        before: { tags: before },
        after: { tags: after },
        added,
        removed,
        retained,
        idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
      };
    }
    case "artist-delete": {
      requireExactKeys(entry, path, [
        "id",
        "artistId",
        "artistName",
        "before",
        "after",
        "idempotencyKey",
      ]);
      const identity = requireEntryIdentity(entry, path);
      const before = requireDeleteEvidence(entry["before"], `${path}.before`);
      const after = requireRecord(entry["after"], `${path}.after`);
      requireExactKeys(after, `${path}.after`, ["exists"]);
      if (after["exists"] !== false) {
        throw validationError(`${path}.after must seal artist absence`);
      }
      return {
        ...identity,
        before,
        after: { exists: false },
        idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
      };
    }
  }
}

function assertV2Summary(
  value: unknown,
  operation: LidarrMutationOperationV2Extended | LidarrArtistAddOperationV2,
  entries: readonly (LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2)[],
): void {
  const summary = requireRecord(value, "plan.summary");
  switch (operation.kind) {
    case "artist-add":
      requireExactKeys(summary, "plan.summary", ["kind", "artists"]);
      if (
        summary["kind"] !== "artist-add" ||
        requirePositiveInteger(
          summary["artists"],
          "plan.summary.artists",
          LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES,
        ) !== entries.length
      ) {
        throw validationError("plan.summary is inconsistent with artist-add");
      }
      return;
    case "track-file-filter":
      if (entries.length !== 1) {
        throw validationError("track-file-filter requires exactly one entry");
      }
      assertLidarrTrackFilterSummary(summary, entries[0] as LidarrTrackFileFilterPlanEntryV2);
      return;
    case "album-edit":
    case "album-delete":
      assertLidarrAlbumPlanSummary(
        summary,
        operation,
        entries as readonly LidarrAlbumMutationPlanEntryV2[],
      );
      return;
    case "artist-monitoring": {
      requireExactKeys(summary, "plan.summary", ["kind", "monitoredBefore", "monitoredAfter"]);
      if (summary["kind"] !== operation.kind)
        throw validationError("plan.summary is inconsistent with plan.operation");
      const monitoringEntries = entries as readonly LidarrArtistMonitoringPlanEntry[];
      const monitoredBefore = monitoringEntries.filter((entry) => entry.before.monitored).length;
      const monitoredAfter = monitoringEntries.filter((entry) => entry.after.monitored).length;
      if (
        requirePositiveIntegerOrZero(
          summary["monitoredBefore"],
          "plan.summary.monitoredBefore",
          entries.length,
        ) !== monitoredBefore ||
        requirePositiveIntegerOrZero(
          summary["monitoredAfter"],
          "plan.summary.monitoredAfter",
          entries.length,
        ) !== monitoredAfter
      ) {
        throw validationError("plan.summary counts are inconsistent");
      }
      return;
    }
    case "artist-profile-assignment": {
      requireExactKeys(summary, "plan.summary", [
        "kind",
        "qualityProfileChanged",
        "metadataProfileChanged",
      ]);
      if (summary["kind"] !== operation.kind)
        throw validationError("plan.summary is inconsistent with plan.operation");
      const profileEntries = entries as readonly LidarrArtistProfilePlanEntry[];
      const qualityChanged = profileEntries.filter(
        (entry) =>
          operation.qualityProfile !== undefined &&
          !sameResourceReference(entry.before.qualityProfile, entry.after.qualityProfile),
      ).length;
      const metadataChanged = profileEntries.filter(
        (entry) =>
          operation.metadataProfile !== undefined &&
          !sameResourceReference(entry.before.metadataProfile, entry.after.metadataProfile),
      ).length;
      if (
        requirePositiveIntegerOrZero(
          summary["qualityProfileChanged"],
          "plan.summary.qualityProfileChanged",
          entries.length,
        ) !== qualityChanged ||
        requirePositiveIntegerOrZero(
          summary["metadataProfileChanged"],
          "plan.summary.metadataProfileChanged",
          entries.length,
        ) !== metadataChanged
      ) {
        throw validationError("plan.summary counts are inconsistent");
      }
      return;
    }
    case "artist-tag-mutation": {
      requireExactKeys(summary, "plan.summary", ["kind", "added", "removed", "retained"]);
      if (summary["kind"] !== operation.kind)
        throw validationError("plan.summary is inconsistent with plan.operation");
      const tagEntries = entries as readonly LidarrArtistTagMutationPlanEntry[];
      const maximum = entries.length * LIDARR_PLAN_MAX_ENTRIES;
      const totals = tagEntries.reduce(
        (result, entry) => ({
          added: result.added + entry.added.length,
          removed: result.removed + entry.removed.length,
          retained: result.retained + entry.retained.length,
        }),
        { added: 0, removed: 0, retained: 0 },
      );
      for (const key of ["added", "removed", "retained"] as const) {
        if (
          requirePositiveIntegerOrZero(summary[key], `plan.summary.${key}`, maximum) !== totals[key]
        ) {
          throw validationError("plan.summary counts are inconsistent");
        }
      }
      return;
    }
    case "artist-delete": {
      requireExactKeys(summary, "plan.summary", [
        "kind",
        "artists",
        "albums",
        "trackFiles",
        "sizeOnDisk",
      ]);
      if (summary["kind"] !== operation.kind) {
        throw validationError("plan.summary is inconsistent with plan.operation");
      }
      const deleteEntries = entries as readonly LidarrArtistDeletePlanEntry[];
      const totals = deleteEntries.reduce(
        (result, entry) => ({
          albums: result.albums + entry.before.albumCount,
          trackFiles: result.trackFiles + entry.before.trackFileCount,
          sizeOnDisk: result.sizeOnDisk + entry.before.sizeOnDisk,
        }),
        { albums: 0, trackFiles: 0, sizeOnDisk: 0 },
      );
      if (
        requirePositiveIntegerOrZero(summary["artists"], "plan.summary.artists", entries.length) !==
        entries.length
      ) {
        throw validationError("plan.summary counts are inconsistent");
      }
      for (const key of ["albums", "trackFiles", "sizeOnDisk"] as const) {
        if (
          requirePositiveIntegerOrZero(
            summary[key],
            `plan.summary.${key}`,
            Number.MAX_SAFE_INTEGER,
          ) !== totals[key]
        ) {
          throw validationError("plan.summary counts are inconsistent");
        }
      }
      return;
    }
  }
}

/** Exact allowlist validator for untrusted strict v2 Lidarr plan JSON. */
export function assertLidarrMutationPlanV2(value: unknown): asserts value is LidarrMutationPlanV2 {
  validateLidarrMutationPlanV2(value);
}

/** Exact validator for the expected-absent foreign-ID artist-add v2 family. */
export function assertLidarrArtistAddPlanV2(
  value: unknown,
): asserts value is LidarrArtistAddPlanV2 {
  if (validateLidarrMutationPlanV2(value) !== "artist-add") {
    throw validationError("plan.operation.kind is not artist-add");
  }
}

/**
 * Exact allowlist validator for untrusted album-family v2 plan JSON. Album
 * plans share the exact `"rfmedia.lidarr-plan.v2"` version string with artist
 * plans; only `plan.operation.kind` separates the families.
 */
export function assertLidarrAlbumMutationPlanV2(
  value: unknown,
): asserts value is LidarrAlbumMutationPlanV2 {
  const operationKind = validateLidarrMutationPlanV2(value);
  if (operationKind !== "album-edit" && operationKind !== "album-delete") {
    throw validationError("plan.operation.kind is not an album mutation");
  }
}

/** Exact validator for the single-album trackfile-filter v2 family. */
export function assertLidarrTrackFileFilterPlanV2(
  value: unknown,
): asserts value is LidarrTrackFileFilterPlanV2 {
  const operationKind = validateLidarrMutationPlanV2(value);
  if (operationKind !== "track-file-filter") {
    throw validationError("plan.operation.kind is not track-file-filter");
  }
}

/** Shared strict v2 validation body; returns the validated operation kind. */
function validateLidarrMutationPlanV2(
  value: unknown,
): LidarrMutationOperationV2Extended["kind"] | "artist-add" {
  assertNoSensitiveKeys(value);
  const plan = requireRecord(value, "plan");
  requireExactKeys(plan, "plan", [
    "version",
    "id",
    "createdAt",
    "createdBy",
    "command",
    "target",
    "selection",
    "operation",
    "maxBatch",
    "entries",
    "review",
    "summary",
    "risk",
    "payloadChecksum",
  ]);
  if (plan["version"] !== LIDARR_PLAN_VERSION_V2) {
    throw validationError(`unsupported plan version ${JSON.stringify(plan["version"])}`);
  }
  const id = requireString(plan["id"], "plan.id");
  if (!UUID_PATTERN.test(id)) throw validationError("plan.id must be a UUID");
  const createdAt = requireString(plan["createdAt"], "plan.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw validationError("plan.createdAt is invalid");
  const createdBy = requireRecord(plan["createdBy"], "plan.createdBy");
  requireExactKeys(createdBy, "plan.createdBy", ["host", "user", "cliVersion", "cwd"]);
  for (const key of ["host", "user", "cliVersion", "cwd"] as const) {
    requireString(createdBy[key], `plan.createdBy.${key}`, key === "cwd");
  }
  if (plan["command"] !== "lidarr") throw validationError('plan.command must be "lidarr"');
  const target = requireRecord(plan["target"], "plan.target");
  requireExactKeys(target, "plan.target", ["origin"]);
  const origin = canonicalizeLidarrPlanOrigin(
    requireString(target["origin"], "plan.target.origin"),
  );
  const selection = requireSelectionV2(plan["selection"]);
  const operation = requireOperationV2(plan["operation"]);
  const albumSelection = selection.kind === "album-ids" || selection.kind === "album-filters";
  const trackFilterSelection = selection.kind === "album-track-filter";
  const artistAddSelection =
    selection.kind === "foreign-artist-id" || selection.kind === "foreign-artist-ids";
  if (
    isAlbumOperationV2(operation) !== albumSelection ||
    (operation.kind === "track-file-filter") !== trackFilterSelection ||
    (operation.kind === "artist-add") !== artistAddSelection
  ) {
    throw validationError("plan.selection is inconsistent with plan.operation");
  }
  const maxBatch = requirePositiveInteger(plan["maxBatch"], "plan.maxBatch", LIDARR_PLAN_MAX_BATCH);
  if (!Array.isArray(plan["entries"]) || plan["entries"].length === 0) {
    throw validationError("plan.entries must be a non-empty array");
  }
  if (
    plan["entries"].length > LIDARR_PLAN_MAX_ENTRIES ||
    (operation.kind === "artist-add" &&
      plan["entries"].length > LIDARR_ARTIST_ADD_PLAN_MAX_ENTRIES) ||
    (operation.kind === "track-file-filter"
      ? plan["entries"].length !== 1
      : plan["entries"].length > maxBatch)
  ) {
    throw validationError("plan.entries exceeds its bound");
  }
  if (operation.kind === "artist-add" && maxBatch !== plan["entries"].length) {
    throw validationError("artist-add plan.maxBatch must equal plan.entries.length");
  }
  const entries: Array<LidarrMutationPlanEntryV2Extended | LidarrArtistAddPlanEntryV2> = [];
  let previousTargetId = 0;
  let previousSelectedRank = 0;
  const seenEntryIds = new Set<string>();
  const seenForeignArtistIds = new Set<string>();
  for (const [index, valueEntry] of plan["entries"].entries()) {
    const entry = requireEntryV2(valueEntry, index, operation);
    if (seenEntryIds.has(entry.id)) {
      throw validationError(`plan.entries contains duplicate entry id ${entry.id}`);
    }
    seenEntryIds.add(entry.id);
    if ("foreignArtistId" in entry && !("artistId" in entry)) {
      if (seenForeignArtistIds.has(entry.foreignArtistId)) {
        throw validationError(`plan.entries contains duplicate MBID ${entry.foreignArtistId}`);
      }
      seenForeignArtistIds.add(entry.foreignArtistId);
      if (selection.kind === "foreign-artist-ids") {
        const selectedRank = entry.provenance.selectedRank;
        if (selectedRank === undefined || selectedRank <= previousSelectedRank) {
          throw validationError(
            "artist-add plan.entries must be in strictly increasing selected-rank order",
          );
        }
        previousSelectedRank = selectedRank;
      }
    } else if ("albumId" in entry) {
      if (entry.albumId <= previousTargetId) {
        throw validationError("plan.entries must be sorted by unique albumId");
      }
      previousTargetId = entry.albumId;
    } else if ("artistId" in entry && typeof entry.artistId === "number") {
      if (entry.artistId <= previousTargetId) {
        throw validationError("plan.entries must be sorted by unique artistId");
      }
      previousTargetId = entry.artistId;
    } else {
      throw validationError(`plan.entries[${index}] is inconsistent with plan.operation`);
    }
    const idempotencyKey = requireString(
      entry.idempotencyKey,
      `plan.entries[${index}].idempotencyKey`,
    );
    if (
      !CHECKSUM_PATTERN.test(idempotencyKey) ||
      idempotencyKey !== expectedV2IdempotencyKey(origin, operation, entry)
    ) {
      throw validationError(`plan.entries[${index}].idempotencyKey is inconsistent`);
    }
    entries.push(entry);
  }
  if (selection.kind === "foreign-artist-id") {
    const entry = entries[0];
    if (
      operation.kind !== "artist-add" ||
      entries.length !== 1 ||
      entry === undefined ||
      !("foreignArtistId" in entry) ||
      selection.foreignArtistId !== entry.foreignArtistId
    ) {
      throw validationError("plan.selection.foreignArtistId must match plan.entries");
    }
  }
  if (
    selection.kind === "foreign-artist-ids" &&
    (operation.kind !== "artist-add" ||
      selection.foreignArtistIds.length !== entries.length ||
      selection.foreignArtistIds.some((foreignArtistId, index) => {
        const entry = entries[index];
        return (
          entry === undefined ||
          !("foreignArtistId" in entry) ||
          foreignArtistId !== entry.foreignArtistId
        );
      }))
  ) {
    throw validationError("plan.selection.foreignArtistIds must match plan.entries in order");
  }
  if (
    selection.kind === "ids" &&
    (selection.artistIds.length !== entries.length ||
      selection.artistIds.some((artistId, index) => {
        const entry = entries[index];
        return entry === undefined || !("artistId" in entry) || artistId !== entry.artistId;
      }))
  ) {
    throw validationError("plan.selection.artistIds must match plan.entries");
  }
  if (
    selection.kind === "album-ids" &&
    (selection.albumIds.length !== entries.length ||
      selection.albumIds.some((albumId, index) => {
        const entry = entries[index];
        return entry === undefined || !("albumId" in entry) || albumId !== entry.albumId;
      }))
  ) {
    throw validationError("plan.selection.albumIds must match plan.entries");
  }
  if (selection.kind === "album-track-filter") {
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      entry === undefined ||
      !("albumId" in entry) ||
      entry.albumId !== selection.albumId
    ) {
      throw validationError("plan.selection.albumId must match the track-filter entry");
    }
    if ((entry as LidarrTrackFileFilterPlanEntryV2).before.deleteCandidates.length > maxBatch) {
      throw validationError("track-file-filter delete candidates exceed plan.maxBatch");
    }
  }
  const review = requireRecord(plan["review"], "plan.review");
  requireExactKeys(review, "plan.review", ["requested", "changed", "unchanged"]);
  const requested = requirePositiveInteger(review["requested"], "plan.review.requested", maxBatch);
  const changed = requirePositiveIntegerOrZero(review["changed"], "plan.review.changed", requested);
  const unchanged = requirePositiveIntegerOrZero(
    review["unchanged"],
    "plan.review.unchanged",
    requested,
  );
  const expectedChanged = expectedV2ChangedCount(operation, entries);
  const expectedRequested =
    operation.kind === "track-file-filter"
      ? (entries[0] as LidarrTrackFileFilterPlanEntryV2).before.deleteCandidates.length
      : entries.length;
  if (
    requested !== expectedRequested ||
    changed + unchanged !== requested ||
    changed !== expectedChanged
  ) {
    throw validationError("plan.review counts do not match entries");
  }
  assertV2Summary(plan["summary"], operation, entries);
  const risk = requireRecord(plan["risk"], "plan.risk");
  requireExactKeys(risk, "plan.risk", ["level", "destructive", "cascade"]);
  const expectedRisk = expectedV2Risk(operation);
  if (risk["level"] !== expectedRisk.level || risk["destructive"] !== expectedRisk.destructive) {
    throw validationError("plan.risk is inconsistent with plan.operation");
  }
  if (
    !Array.isArray(risk["cascade"]) ||
    risk["cascade"].length === 0 ||
    risk["cascade"].length > MAX_RISK_CASCADE_ITEMS
  ) {
    throw validationError("plan.risk.cascade must be a bounded non-empty array");
  }
  risk["cascade"].forEach((item, index) => requireString(item, `plan.risk.cascade[${index}]`));
  if (
    risk["cascade"].length !== expectedRisk.cascade.length ||
    risk["cascade"].some((item, index) => item !== expectedRisk.cascade[index])
  ) {
    throw validationError("plan.risk.cascade is inconsistent with plan.operation");
  }
  const checksum = requireString(plan["payloadChecksum"], "plan.payloadChecksum");
  if (!CHECKSUM_PATTERN.test(checksum)) throw validationError("plan.payloadChecksum is invalid");
  return operation.kind;
}

const CASCADE_BASIS_CODES: ReadonlySet<LidarrCascadeBasisCode> = new Set([
  "current-operation-no-search",
  "changed-artist-monitoring",
  "changed-album-monitoring",
  "configured-albums-per-artist",
  "operation-removes-acquisition-scope",
  "release-automation-evidence-unavailable",
  "monitored-album-file-removal",
  "unmonitored-album-file-removal",
  "configured-indexer-queries-per-candidate",
  "acquisition-candidates-known-zero",
  "acquisition-candidates-unknown",
  "indexer-queries-per-candidate-not-configured",
  "changed-entries",
  "track-file-delete-candidates",
  "affected-file-bytes",
  "no-file-impact",
]);
const CASCADE_RECOMMENDATION_CODES: ReadonlySet<LidarrCascadeRecommendationCode> = new Set([
  "reduce-scope",
  "split-into-batches",
  "delay-apply",
]);
const MAX_CASCADE_POLICY_VALUE = 1_000_000;

function requireNullableCascadePolicyValue(value: unknown, path: string): number | null {
  if (value === null) return null;
  return requirePositiveInteger(value, path, MAX_CASCADE_POLICY_VALUE);
}

function requireNullableNonNegativeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return requirePositiveIntegerOrZero(value, path, Number.MAX_SAFE_INTEGER);
}

function requireCascadeMetric(value: unknown, path: string): LidarrCascadeMetric {
  const metric = requireRecord(value, path);
  requireExactKeys(metric, path, ["value", "certainty", "horizon", "unit", "basis"]);
  const metricValue = requireNullableNonNegativeInteger(metric["value"], `${path}.value`);
  const certainty = metric["certainty"];
  if (certainty !== "exact" && certainty !== "modelled" && certainty !== "unknown") {
    throw validationError(`${path}.certainty is invalid`);
  }
  const horizon = metric["horizon"];
  if (horizon !== "immediate" && horizon !== "conditional" && horizon !== "none") {
    throw validationError(`${path}.horizon is invalid`);
  }
  const unit = metric["unit"];
  if (
    unit !== "artists" &&
    unit !== "albums" &&
    unit !== "indexer-queries" &&
    unit !== "acquisition-candidates" &&
    unit !== "files" &&
    unit !== "bytes"
  ) {
    throw validationError(`${path}.unit is invalid`);
  }
  const basis = metric["basis"];
  if (typeof basis !== "string" || !CASCADE_BASIS_CODES.has(basis as LidarrCascadeBasisCode)) {
    throw validationError(`${path}.basis is invalid`);
  }
  if ((certainty === "unknown") !== (metricValue === null)) {
    throw validationError(`${path}.value and certainty are inconsistent`);
  }
  if (horizon === "none" && (certainty !== "exact" || metricValue !== 0)) {
    throw validationError(`${path} none-horizon metrics must be exact zero`);
  }
  return {
    value: metricValue,
    certainty,
    horizon,
    unit,
    basis: basis as LidarrCascadeBasisCode,
  };
}

function requireCascadeBudget(value: unknown, path: string): LidarrCascadeBudgetAssessment {
  const budget = requireRecord(value, path);
  requireExactKeys(budget, path, ["status", "limit", "projected", "provenance"]);
  const status = budget["status"];
  if (
    status !== "not-configured" &&
    status !== "within" &&
    status !== "exceeded" &&
    status !== "unknown"
  ) {
    throw validationError(`${path}.status is invalid`);
  }
  const limit = requireNullableCascadePolicyValue(budget["limit"], `${path}.limit`);
  const projected = requireNullableNonNegativeInteger(budget["projected"], `${path}.projected`);
  if (budget["provenance"] !== "configured-per-plan") {
    throw validationError(`${path}.provenance is invalid`);
  }
  const valid =
    (status === "not-configured" && limit === null) ||
    (status === "unknown" && limit !== null && projected === null) ||
    (status === "within" && limit !== null && projected !== null && projected <= limit) ||
    (status === "exceeded" && limit !== null && projected !== null && projected > limit);
  if (!valid) throw validationError(`${path} fields are inconsistent`);
  return { status, limit, projected, provenance: "configured-per-plan" };
}

function requireCascadeWarning(value: unknown, path: string): LidarrCascadeWarning {
  const warning = requireRecord(value, path);
  switch (warning["code"]) {
    case "indexer-query-budget-exceeded":
    case "acquisition-budget-exceeded": {
      requireExactKeys(warning, path, ["code", "metric", "projected", "limit", "overBy"]);
      const expectedMetric =
        warning["code"] === "indexer-query-budget-exceeded"
          ? "indexerQueries"
          : "acquisitionCandidates";
      if (warning["metric"] !== expectedMetric) {
        throw validationError(`${path}.metric is inconsistent with its code`);
      }
      const projected = requirePositiveIntegerOrZero(
        warning["projected"],
        `${path}.projected`,
        Number.MAX_SAFE_INTEGER,
      );
      const limit = requirePositiveInteger(
        warning["limit"],
        `${path}.limit`,
        MAX_CASCADE_POLICY_VALUE,
      );
      const overBy = requirePositiveInteger(
        warning["overBy"],
        `${path}.overBy`,
        Number.MAX_SAFE_INTEGER,
      );
      if (projected - limit !== overBy) {
        throw validationError(`${path}.overBy is inconsistent`);
      }
      return {
        code: warning["code"],
        metric: expectedMetric,
        projected,
        limit,
        overBy,
      } as LidarrCascadeWarning;
    }
    case "budget-assessment-incomplete": {
      requireExactKeys(warning, path, ["code", "metric", "projected", "limit"]);
      if (warning["metric"] !== "indexerQueries" && warning["metric"] !== "acquisitionCandidates") {
        throw validationError(`${path}.metric is invalid`);
      }
      if (warning["projected"] !== null) {
        throw validationError(`${path}.projected must be null`);
      }
      return {
        code: "budget-assessment-incomplete",
        metric: warning["metric"],
        projected: null,
        limit: requirePositiveInteger(warning["limit"], `${path}.limit`, MAX_CASCADE_POLICY_VALUE),
      };
    }
    default:
      throw validationError(`${path}.code is invalid`);
  }
}

function requireCascadeAnalysis(value: unknown): LidarrCascadeAnalysis {
  const analysis = requireRecord(value, "plan.cascadeAnalysis");
  requireExactKeys(analysis, "plan.cascadeAnalysis", [
    "modelVersion",
    "assumptions",
    "metrics",
    "budgets",
    "warnings",
    "recommendations",
  ]);
  if (analysis["modelVersion"] !== LIDARR_CASCADE_MODEL_VERSION) {
    throw validationError("plan.cascadeAnalysis.modelVersion is invalid");
  }
  const assumptions = requireRecord(analysis["assumptions"], "plan.cascadeAnalysis.assumptions");
  requireExactKeys(assumptions, "plan.cascadeAnalysis.assumptions", [
    "albumsPerArtist",
    "indexerQueriesPerCandidate",
  ]);
  const metrics = requireRecord(analysis["metrics"], "plan.cascadeAnalysis.metrics");
  requireExactKeys(metrics, "plan.cascadeAnalysis.metrics", [
    "immediateIndexerQueries",
    "acquisitionCandidates",
    "conditionalIndexerQueries",
    "newlyMonitored",
    "filesAffected",
    "bytesAffected",
  ]);
  const budgets = requireRecord(analysis["budgets"], "plan.cascadeAnalysis.budgets");
  requireExactKeys(budgets, "plan.cascadeAnalysis.budgets", [
    "indexerQueries",
    "acquisitionCandidates",
  ]);
  if (!Array.isArray(analysis["warnings"]) || analysis["warnings"].length > 2) {
    throw validationError("plan.cascadeAnalysis.warnings must be a bounded array");
  }
  const warnings = analysis["warnings"].map((warning, index) =>
    requireCascadeWarning(warning, `plan.cascadeAnalysis.warnings[${index}]`),
  );
  if (!Array.isArray(analysis["recommendations"]) || analysis["recommendations"].length > 3) {
    throw validationError("plan.cascadeAnalysis.recommendations must be a bounded array");
  }
  const recommendations = analysis["recommendations"].map((recommendation, index) => {
    if (
      typeof recommendation !== "string" ||
      !CASCADE_RECOMMENDATION_CODES.has(recommendation as LidarrCascadeRecommendationCode)
    ) {
      throw validationError(`plan.cascadeAnalysis.recommendations[${index}] is invalid`);
    }
    return recommendation as LidarrCascadeRecommendationCode;
  });
  if (new Set(recommendations).size !== recommendations.length) {
    throw validationError("plan.cascadeAnalysis.recommendations must be unique");
  }
  return {
    modelVersion: LIDARR_CASCADE_MODEL_VERSION,
    assumptions: {
      albumsPerArtist: requireNullableCascadePolicyValue(
        assumptions["albumsPerArtist"],
        "plan.cascadeAnalysis.assumptions.albumsPerArtist",
      ),
      indexerQueriesPerCandidate: requireNullableCascadePolicyValue(
        assumptions["indexerQueriesPerCandidate"],
        "plan.cascadeAnalysis.assumptions.indexerQueriesPerCandidate",
      ),
    },
    metrics: {
      immediateIndexerQueries: requireCascadeMetric(
        metrics["immediateIndexerQueries"],
        "plan.cascadeAnalysis.metrics.immediateIndexerQueries",
      ),
      acquisitionCandidates: requireCascadeMetric(
        metrics["acquisitionCandidates"],
        "plan.cascadeAnalysis.metrics.acquisitionCandidates",
      ),
      conditionalIndexerQueries: requireCascadeMetric(
        metrics["conditionalIndexerQueries"],
        "plan.cascadeAnalysis.metrics.conditionalIndexerQueries",
      ),
      newlyMonitored: requireCascadeMetric(
        metrics["newlyMonitored"],
        "plan.cascadeAnalysis.metrics.newlyMonitored",
      ),
      filesAffected: requireCascadeMetric(
        metrics["filesAffected"],
        "plan.cascadeAnalysis.metrics.filesAffected",
      ),
      bytesAffected: requireCascadeMetric(
        metrics["bytesAffected"],
        "plan.cascadeAnalysis.metrics.bytesAffected",
      ),
    },
    budgets: {
      indexerQueries: requireCascadeBudget(
        budgets["indexerQueries"],
        "plan.cascadeAnalysis.budgets.indexerQueries",
      ),
      acquisitionCandidates: requireCascadeBudget(
        budgets["acquisitionCandidates"],
        "plan.cascadeAnalysis.budgets.acquisitionCandidates",
      ),
    },
    warnings,
    recommendations,
  };
}

function projectTrackFilterEntriesToV2(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item, index) => {
    const entry = requireRecord(item, `plan.entries[${index}]`);
    const before = requireRecord(entry["before"], `plan.entries[${index}].before`);
    requireExactKeys(before, `plan.entries[${index}].before`, [
      "albumMonitored",
      "deleteCandidates",
    ]);
    requireBoolean(before["albumMonitored"], `plan.entries[${index}].before.albumMonitored`);
    return {
      ...entry,
      before: { deleteCandidates: before["deleteCandidates"] },
    };
  });
}

function projectV3PlanToLegacy(
  plan: UnknownRecord,
  operationKind: unknown,
): LidarrStoredMutationPlan {
  if (operationKind === "album-monitoring") {
    const projected = {
      version: LIDARR_PLAN_VERSION,
      id: plan["id"],
      createdAt: plan["createdAt"],
      createdBy: plan["createdBy"],
      command: plan["command"],
      target: plan["target"],
      operation: plan["operation"],
      maxBatch: plan["maxBatch"],
      entries: plan["entries"],
      review: plan["review"],
      risk: plan["risk"],
      payloadChecksum: plan["payloadChecksum"],
    };
    assertLidarrMutationPlanV1(projected);
    return projected;
  }
  const entries =
    operationKind === "track-file-filter"
      ? projectTrackFilterEntriesToV2(plan["entries"])
      : plan["entries"];
  const projected = {
    version: LIDARR_PLAN_VERSION_V2,
    id: plan["id"],
    createdAt: plan["createdAt"],
    createdBy: plan["createdBy"],
    command: plan["command"],
    target: plan["target"],
    selection: plan["selection"],
    operation: plan["operation"],
    maxBatch: plan["maxBatch"],
    entries,
    review: plan["review"],
    summary: plan["summary"],
    risk: plan["risk"],
    payloadChecksum: plan["payloadChecksum"],
  };
  validateLidarrMutationPlanV2(projected);
  return projected as LidarrStoredMutationPlan;
}

type LidarrPlanV3OperationKind = LidarrPlanV3["operation"]["kind"];

function validateLidarrMutationPlanV3(value: unknown): LidarrPlanV3OperationKind {
  assertNoSensitiveKeys(value);
  const plan = requireRecord(value, "plan");
  if (plan["version"] !== LIDARR_PLAN_VERSION_V3) {
    throw validationError(`unsupported plan version ${JSON.stringify(plan["version"])}`);
  }
  const operationRecord = requireRecord(plan["operation"], "plan.operation");
  const operationKind = operationRecord["kind"];
  const albumMonitoring = operationKind === "album-monitoring";
  requireExactKeys(
    plan,
    "plan",
    albumMonitoring
      ? [
          "version",
          "id",
          "createdAt",
          "createdBy",
          "command",
          "target",
          "operation",
          "maxBatch",
          "entries",
          "review",
          "risk",
          "cascadeAnalysis",
          "payloadChecksum",
        ]
      : [
          "version",
          "id",
          "createdAt",
          "createdBy",
          "command",
          "target",
          "selection",
          "operation",
          "maxBatch",
          "entries",
          "review",
          "summary",
          "risk",
          "cascadeAnalysis",
          "payloadChecksum",
        ],
  );
  projectV3PlanToLegacy(plan, operationKind);
  const analysis = requireCascadeAnalysis(plan["cascadeAnalysis"]);
  const policy: LidarrCascadePolicy = {
    assumptions: analysis.assumptions,
    budgets: {
      indexerQueries: analysis.budgets.indexerQueries.limit,
      acquisitionCandidates: analysis.budgets.acquisitionCandidates.limit,
    },
  };
  const expected = analyzeLidarrCascade(cascadeFactsFromPlan(value as LidarrPlanV3), policy);
  if (
    JSON.stringify(canonicalizeCascadeAnalysis(analysis)) !==
    JSON.stringify(canonicalizeCascadeAnalysis(expected))
  ) {
    throw validationError("plan.cascadeAnalysis is inconsistent with canonical plan facts");
  }
  return operationKind as LidarrPlanV3OperationKind;
}

/** Exact structural and semantic validator for every correlated v3 family. */
export function assertLidarrMutationPlanV3(value: unknown): asserts value is LidarrPlanV3 {
  validateLidarrMutationPlanV3(value);
}

/** Exact v3 validator for expected-absent artist-add plans. */
export function assertLidarrArtistAddPlanV3(
  value: unknown,
): asserts value is LidarrArtistAddPlanV3 {
  if (validateLidarrMutationPlanV3(value) !== "artist-add") {
    throw validationError("plan.operation.kind is not artist-add");
  }
}

/** Exact v3 validator for album edit/delete plans. */
export function assertLidarrAlbumMutationPlanV3(
  value: unknown,
): asserts value is LidarrAlbumMutationPlanV3 {
  const operationKind = validateLidarrMutationPlanV3(value);
  if (operationKind !== "album-edit" && operationKind !== "album-delete") {
    throw validationError("plan.operation.kind is not an album mutation");
  }
}

/** Exact v3 validator for the single-album trackfile-filter family. */
export function assertLidarrTrackFileFilterPlanV3(
  value: unknown,
): asserts value is LidarrTrackFileFilterPlanV3 {
  if (validateLidarrMutationPlanV3(value) !== "track-file-filter") {
    throw validationError("plan.operation.kind is not track-file-filter");
  }
}

/** Dispatches strict validation using only the exact plan version discriminator. */
export function assertLidarrMutationPlan(
  value: unknown,
): asserts value is LidarrStoredMutationPlan {
  assertNoSensitiveKeys(value);
  const plan = requireRecord(value, "plan");
  switch (plan["version"]) {
    case LIDARR_PLAN_VERSION:
      assertLidarrMutationPlanV1(value);
      return;
    case LIDARR_PLAN_VERSION_V2:
      assertLidarrMutationPlanV2(value);
      return;
    case LIDARR_PLAN_VERSION_V3:
      assertLidarrMutationPlanV3(value);
      return;
    default:
      throw validationError(`unsupported plan version ${JSON.stringify(plan["version"])}`);
  }
}

function requirePositiveIntegerOrZero(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    throw validationError(`${path} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

const LIDARR_PLAN_ARTIFACT_SUBJECT = "Lidarr plan artifact";
const LIDARR_PLAN_HISTORY_SUBJECT = "Lidarr plan history";

function resolveLidarrStoragePath(inputPath: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.length > MAX_PATH_LENGTH ||
    TERMINAL_CONTROL_PATTERN.test(inputPath)
  ) {
    throw new LidarrPlanArtifactError(
      "LIDARR_PLAN_UNSAFE_PATH",
      "Lidarr plan path must be non-empty, bounded, and free of terminal control characters",
    );
  }
  return resolve(inputPath);
}

/** Writes a plan with private permissions and atomic no-clobber publication. */
export async function writeLidarrPlanArtifact(
  inputPath: string,
  plan: LidarrStoredMutationPlan,
): Promise<string> {
  const path = resolveLidarrStoragePath(inputPath);
  assertLidarrMutationPlan(plan);
  if (computeLidarrPlanChecksum(plan) !== plan.payloadChecksum) {
    throw new LidarrPlanArtifactError(
      "LIDARR_PLAN_CHECKSUM_MISMATCH",
      "Refusing to write a Lidarr plan with an invalid checksum",
      path,
    );
  }
  const canonical =
    plan.version === LIDARR_PLAN_VERSION
      ? canonicalizePlan(plan, true)
      : plan.version === LIDARR_PLAN_VERSION_V2
        ? canonicalizePlanV2(plan, true)
        : canonicalizePlanV3(plan, true);
  const text = `${JSON.stringify(canonical, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > LIDARR_PLAN_MAX_BYTES) {
    throw new LidarrPlanArtifactError(
      "LIDARR_PLAN_TOO_LARGE",
      "Lidarr plan exceeds the maximum artifact size",
      path,
    );
  }
  try {
    await createPrivateFileAtomically({
      path,
      text,
      subject: LIDARR_PLAN_ARTIFACT_SUBJECT,
      temporaryId: plan.id,
    });
    return path;
  } catch (error) {
    throw translateLidarrCreateFailure(
      error,
      path,
      `Lidarr plan already exists: ${path}`,
      "Unable to write Lidarr plan",
    );
  }
}

/** Reads, bounds, validates, and verifies a Lidarr plan artifact. */
export async function readLidarrPlanArtifact(inputPath: string): Promise<LidarrStoredMutationPlan> {
  const path = resolveLidarrStoragePath(inputPath);
  try {
    const read = await readBoundedPrivateFile(
      path,
      LIDARR_PLAN_MAX_BYTES,
      LIDARR_PLAN_ARTIFACT_SUBJECT,
      "allow-foreign-read",
    );
    if (read === undefined) {
      throw new LidarrPlanArtifactError("LIDARR_PLAN_IO", "Unable to read Lidarr plan", path);
    }
    let value: unknown;
    try {
      value = JSON.parse(read.text) as unknown;
    } catch (error) {
      throw new LidarrPlanArtifactError(
        "LIDARR_PLAN_MALFORMED",
        "Lidarr plan is not valid JSON",
        path,
        { cause: error },
      );
    }
    try {
      assertLidarrMutationPlan(value);
    } catch (error) {
      if (error instanceof LidarrPlanValidationError) {
        throw new LidarrPlanValidationError(error.detail, path);
      }
      throw error;
    }
    if (computeLidarrPlanChecksum(value) !== value.payloadChecksum) {
      throw new LidarrPlanArtifactError(
        "LIDARR_PLAN_CHECKSUM_MISMATCH",
        "Lidarr plan checksum does not match its payload",
        path,
      );
    }
    return value;
  } catch (error) {
    throw translateLidarrIoFailure(error, path, "Unable to read Lidarr plan");
  }
}

/** Returns the authoritative Lidarr plan history path. */
export function getLidarrPlanHistoryPath(): string {
  return join(getDefaultPlanDir(), "lidarr-history");
}

type LidarrPossibleDispatchHistoryRecord =
  | LidarrArtistDeletePossibleDispatchHistoryRecord
  | LidarrArtistAddPossibleDispatchHistoryRecord;

function isLidarrPossibleDispatchHistoryRecord(
  record: LidarrPlanHistoryRecord,
): record is LidarrPossibleDispatchHistoryRecord {
  return (
    isLidarrArtistDeletePossibleDispatchHistoryRecord(record) ||
    isLidarrArtistAddPossibleDispatchHistoryRecord(record)
  );
}

function resolveHistoryStoragePath(
  planId: string,
  planChecksum: string,
  historyPath?: string,
): string {
  return resolveLidarrStoragePath(
    historyPath ??
      join(getLidarrPlanHistoryPath(), `${planId}-${planChecksum.slice("sha256:".length)}.jsonl`),
  );
}

function assertHistoryRecord(value: unknown): asserts value is LidarrPlanHistoryRecord {
  assertNoSensitiveKeys(value, "history record");
  const record = requireRecord(value, "history record");
  // History lines are re-validated without plan context, so the record kind is
  // inferred from its shape: album records carry `albumId`, existing artists
  // carry `artistId`, and expected-absent artist-add records carry only their
  // canonical `foreignArtistId`.
  const isAlbumRecord = "albumId" in record;
  const isForeignArtistRecord = "foreignArtistId" in record;
  const isPossibleDispatch = record["outcome"] === "possibly-dispatched";
  const isNormalizationPending = record["outcome"] === "creation-verified-normalization-pending";
  const isNormalizationVerificationPending =
    record["outcome"] === "normalization-verification-pending";
  const isNormalizationStage = isNormalizationPending || isNormalizationVerificationPending;
  if (isAlbumRecord && isPossibleDispatch) {
    throw validationError("possibly-dispatched history must identify one artist");
  }
  if (isNormalizationStage && (!isForeignArtistRecord || isAlbumRecord)) {
    throw validationError("normalization history must identify one foreign artist");
  }
  requireExactKeys(
    record,
    "history record",
    isNormalizationVerificationPending
      ? [
          "planId",
          "planChecksum",
          "entryId",
          "foreignArtistId",
          "lidarrId",
          "recordedAt",
          "outcome",
          "albumIds",
          "idempotencyKey",
        ]
      : isNormalizationPending
        ? [
            "planId",
            "planChecksum",
            "entryId",
            "foreignArtistId",
            "lidarrId",
            "recordedAt",
            "outcome",
            "idempotencyKey",
          ]
        : isPossibleDispatch
          ? isForeignArtistRecord
            ? [
                "planId",
                "planChecksum",
                "entryId",
                "foreignArtistId",
                "recordedAt",
                "outcome",
                "idempotencyKey",
              ]
            : [
                "planId",
                "planChecksum",
                "entryId",
                "artistId",
                "recordedAt",
                "outcome",
                "idempotencyKey",
              ]
          : isAlbumRecord
            ? ["planId", "planChecksum", "entryId", "albumId", "artistId", "recordedAt", "outcome"]
            : isForeignArtistRecord
              ? ["planId", "planChecksum", "entryId", "foreignArtistId", "recordedAt", "outcome"]
              : ["planId", "planChecksum", "entryId", "artistId", "recordedAt", "outcome"],
    isPossibleDispatch && isForeignArtistRecord
      ? ["lidarrId"]
      : isPossibleDispatch || isNormalizationStage
        ? []
        : ["errorCode", "message"],
  );
  const planId = requireString(record["planId"], "history record.planId");
  if (!UUID_PATTERN.test(planId)) throw validationError("history record.planId must be a UUID");
  const checksum = requireString(record["planChecksum"], "history record.planChecksum");
  if (!CHECKSUM_PATTERN.test(checksum))
    throw validationError("history record.planChecksum is invalid");
  const entryId = requireString(record["entryId"], "history record.entryId");
  if (isAlbumRecord) {
    const albumId = requirePositiveInteger(record["albumId"], "history record.albumId");
    requirePositiveInteger(record["artistId"], "history record.artistId");
    if (entryId !== `album:${albumId}` && entryId !== `album:${albumId}:track-file-filter`)
      throw validationError("history record entry does not match album");
  } else if (isForeignArtistRecord) {
    const foreignArtistId = requireString(
      record["foreignArtistId"],
      "history record.foreignArtistId",
    );
    if (!CANONICAL_MUSICBRAINZ_ID_PATTERN.test(foreignArtistId)) {
      throw validationError("history record.foreignArtistId is invalid");
    }
    if (entryId !== `artist:${foreignArtistId}`) {
      throw validationError("history record entry does not match foreign artist");
    }
  } else {
    const artistId = requirePositiveInteger(record["artistId"], "history record.artistId");
    if (entryId !== `artist:${artistId}`)
      throw validationError("history record entry does not match artist");
  }
  const recordedAt = requireString(record["recordedAt"], "history record.recordedAt");
  if (!Number.isFinite(Date.parse(recordedAt)))
    throw validationError("history record.recordedAt is invalid");
  if (isPossibleDispatch || isNormalizationStage) {
    const idempotencyKey = requireString(record["idempotencyKey"], "history record.idempotencyKey");
    if (!CHECKSUM_PATTERN.test(idempotencyKey)) {
      throw validationError("history record.idempotencyKey is invalid");
    }
    if (isPossibleDispatch && isForeignArtistRecord && record["lidarrId"] !== undefined) {
      requirePositiveInteger(record["lidarrId"], "history record.lidarrId");
    }
    if (isNormalizationStage) {
      requirePositiveInteger(record["lidarrId"], "history record.lidarrId");
    }
    if (isNormalizationVerificationPending) {
      const albumIds = record["albumIds"];
      if (
        !Array.isArray(albumIds) ||
        albumIds.length === 0 ||
        albumIds.length > LIDARR_PLAN_MAX_ENTRIES
      ) {
        throw validationError("history record.albumIds must be a bounded non-empty array");
      }
      let previousAlbumId = 0;
      for (const [index, value] of albumIds.entries()) {
        const albumId = requirePositiveInteger(value, `history record.albumIds[${index}]`);
        if (albumId <= previousAlbumId) {
          throw validationError("history record.albumIds must be sorted and unique");
        }
        previousAlbumId = albumId;
      }
    }
    return;
  }
  const outcomes: readonly LidarrPlanHistoryOutcome[] = [
    "succeeded",
    "satisfied",
    "failed",
    "deferred",
    "uncertain",
  ];
  if (!outcomes.includes(record["outcome"] as LidarrPlanHistoryOutcome)) {
    throw validationError("history record.outcome is invalid");
  }
  if (record["errorCode"] !== undefined)
    requireString(record["errorCode"], "history record.errorCode");
  if (record["message"] !== undefined)
    requireString(record["message"], "history record.message", true);
}

/** Appends one validated terminal target record; failures are intentionally blocking. */
export async function appendLidarrPlanHistory(
  record: LidarrPlanHistoryRecord,
  historyPath?: string,
): Promise<void> {
  assertHistoryRecord(record);
  const path = resolveHistoryStoragePath(record.planId, record.planChecksum, historyPath);
  const terminalRecords = new Map<string, LidarrPlanHistoryRecord>();
  const possibleDispatchRecords = new Map<string, LidarrPossibleDispatchHistoryRecord>();
  let replacedIdentity: FileIdentity | undefined;
  try {
    const existing = await readBoundedPrivateFile(
      path,
      LIDARR_PLAN_MAX_BYTES,
      LIDARR_PLAN_HISTORY_SUBJECT,
      "allow-foreign-read",
    );
    if (existing !== undefined) {
      replacedIdentity = existing.identity;
      for (const [index, line] of existing.text.split("\n").entries()) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
          assertHistoryRecord(parsed);
        } catch (error) {
          throw validationError(
            `history line ${index + 1} is malformed: ${error instanceof Error ? error.message : String(error)}`,
            path,
          );
        }
        if (parsed.planId !== record.planId || parsed.planChecksum !== record.planChecksum) {
          throw validationError("per-plan history contains a different plan identity", path);
        }
        if (isLidarrPossibleDispatchHistoryRecord(parsed)) {
          possibleDispatchRecords.set(parsed.entryId, parsed);
        } else {
          terminalRecords.set(parsed.entryId, parsed);
        }
      }
    }
  } catch (error) {
    throw translateLidarrIoFailure(error, path, "Unable to read Lidarr plan history");
  }
  const previousTerminal = terminalRecords.get(record.entryId);
  const previousPossibleDispatch = possibleDispatchRecords.get(record.entryId);
  if (
    previousTerminal !== undefined &&
    previousTerminal.outcome !== "failed" &&
    isLidarrPossibleDispatchHistoryRecord(record)
  ) {
    throw validationError(
      "possibly-dispatched history cannot replace a terminal entry outcome",
      path,
    );
  }
  if (
    previousPossibleDispatch !== undefined &&
    isLidarrPossibleDispatchHistoryRecord(record) &&
    previousPossibleDispatch.idempotencyKey !== record.idempotencyKey
  ) {
    throw validationError(
      "possibly-dispatched history cannot change an entry idempotency key",
      path,
    );
  }
  if (
    previousPossibleDispatch !== undefined &&
    isLidarrArtistAddPossibleDispatchHistoryRecord(previousPossibleDispatch) &&
    isLidarrArtistAddPossibleDispatchHistoryRecord(record) &&
    previousPossibleDispatch.lidarrId !== undefined &&
    previousPossibleDispatch.lidarrId !== record.lidarrId
  ) {
    throw validationError(
      "artist-add possible-dispatch history cannot change or remove its Lidarr artist identity",
      path,
    );
  }
  if (isLidarrPossibleDispatchHistoryRecord(record)) {
    terminalRecords.delete(record.entryId);
    possibleDispatchRecords.set(record.entryId, record);
  } else {
    terminalRecords.set(record.entryId, record);
    if (record.outcome !== "uncertain") {
      possibleDispatchRecords.delete(record.entryId);
    }
  }
  const entryIds = new Set([...terminalRecords.keys(), ...possibleDispatchRecords.keys()]);
  if (entryIds.size > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError("per-plan history exceeds the maximum entry count", path);
  }
  const records = [...possibleDispatchRecords.values(), ...terminalRecords.values()];
  const text = `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
  if (Buffer.byteLength(text, "utf8") > LIDARR_PLAN_MAX_BYTES) {
    throw new LidarrPlanArtifactError(
      "LIDARR_PLAN_TOO_LARGE",
      "Per-plan Lidarr history exceeds the maximum artifact size",
      path,
    );
  }
  try {
    if (replacedIdentity === undefined) {
      await createPrivateFileAtomically({
        path,
        text,
        subject: LIDARR_PLAN_HISTORY_SUBJECT,
        temporaryId: `${record.planId}.history`,
      });
    } else {
      await replacePrivateFileAtomically({
        path,
        text,
        subject: LIDARR_PLAN_HISTORY_SUBJECT,
        temporaryId: `${record.planId}.history`,
        expectedIdentity: replacedIdentity,
      });
    }
  } catch (error) {
    if (replacedIdentity === undefined) {
      throw translateLidarrCreateFailure(
        error,
        path,
        "Lidarr plan history already exists",
        "Unable to persist Lidarr plan history",
      );
    }
    throw translateLidarrIoFailure(error, path, "Unable to persist Lidarr plan history");
  }
}

/** Reads all authoritative records for one exact plan identity. */
export async function readLidarrPlanHistory(
  planId: string,
  planChecksum: string,
  historyPath?: string,
): Promise<LidarrPlanHistoryRecord[]> {
  if (!UUID_PATTERN.test(planId) || !CHECKSUM_PATTERN.test(planChecksum)) {
    throw validationError("invalid plan identity for history lookup");
  }
  const path = resolveHistoryStoragePath(planId, planChecksum, historyPath);
  let text: string;
  try {
    const read = await readBoundedPrivateFile(
      path,
      LIDARR_PLAN_MAX_BYTES,
      LIDARR_PLAN_HISTORY_SUBJECT,
      "allow-foreign-read",
    );
    if (read === undefined) return [];
    text = read.text;
  } catch (error) {
    throw translateLidarrIoFailure(error, path, "Unable to read Lidarr plan history");
  }
  const records: LidarrPlanHistoryRecord[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
      assertHistoryRecord(parsed);
    } catch (error) {
      throw validationError(
        `history line ${index + 1} is malformed: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }
    if (parsed.planId !== planId || parsed.planChecksum !== planChecksum) {
      throw validationError("per-plan history contains a different plan identity", path);
    }
    records.push(parsed);
  }
  return records;
}

/** Returns entries not durably recorded as succeeded or already satisfied. */
type LidarrResumePlan =
  | LidarrMutationPlan
  | LidarrMutationPlanV3
  | LidarrArtistAddPlanV2
  | LidarrArtistAddPlanV3;

function isLidarrArtistAddPlan(
  plan: LidarrResumePlan,
): plan is LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3 {
  return plan.operation.kind === "artist-add";
}

export function selectLidarrResumeEntries(
  plan: LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrArtistAddPlanEntryV2[];
export function selectLidarrResumeEntries(
  plan: LidarrMutationPlanV1,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrMutationPlanEntry[];
export function selectLidarrResumeEntries(
  plan: LidarrMutationPlanV2,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrMutationPlanEntryV2[];
export function selectLidarrResumeEntries(
  plan: LidarrMutationPlanV3,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrMutationPlanEntry[] | LidarrMutationPlanEntryV2[];
export function selectLidarrResumeEntries(
  plan: LidarrResumePlan,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrMutationPlanEntry[] | LidarrMutationPlanEntryV2[] | LidarrArtistAddPlanEntryV2[];
export function selectLidarrResumeEntries(
  plan: LidarrResumePlan,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrMutationPlanEntry[] | LidarrMutationPlanEntryV2[] | LidarrArtistAddPlanEntryV2[] {
  const latest = new Map<string, LidarrPlanHistoryRecord>();
  for (const record of history) {
    if (record.planId === plan.id && record.planChecksum === plan.payloadChecksum) {
      assertHistoryRecordMatchesPlan(plan, record);
      latest.set(record.entryId, record);
    }
  }
  const shouldResume = (entry: { readonly id: string }): boolean => {
    const outcome = latest.get(entry.id)?.outcome;
    return outcome !== "succeeded" && outcome !== "satisfied";
  };

  if (isLidarrArtistAddPlan(plan)) return plan.entries.filter(shouldResume);
  if (plan.version === LIDARR_PLAN_VERSION) return plan.entries.filter(shouldResume);
  return plan.entries.filter(shouldResume);
}

function assertHistoryRecordMatchesPlan(
  plan: LidarrResumePlan,
  record: LidarrPlanHistoryRecord,
): void {
  if (isLidarrArtistAddPlan(plan)) {
    const entry = plan.entries.find((candidate) => candidate.id === record.entryId);
    if (
      entry === undefined ||
      !("foreignArtistId" in record) ||
      entry.foreignArtistId !== record.foreignArtistId
    ) {
      throw validationError("history record does not match an artist-add plan entry");
    }
    if (
      (isLidarrArtistAddPossibleDispatchHistoryRecord(record) ||
        isLidarrArtistAddNormalizationPendingHistoryRecord(record) ||
        isLidarrArtistAddNormalizationVerificationPendingHistoryRecord(record)) &&
      entry.idempotencyKey !== record.idempotencyKey
    ) {
      throw validationError("resumable history does not match the artist-add plan entry");
    }
    if (
      (isLidarrArtistAddNormalizationPendingHistoryRecord(record) ||
        isLidarrArtistAddNormalizationVerificationPendingHistoryRecord(record)) &&
      !isLidarrArtistAddExtendedPlanEntry(entry)
    ) {
      throw validationError("normalization history does not match a legacy artist-add entry");
    }
    return;
  }
  if ("foreignArtistId" in record) {
    throw validationError("history record does not match a plan entry");
  }
  const entry = plan.entries.find((candidate) => candidate.id === record.entryId);
  if (entry === undefined || entry.artistId !== record.artistId) {
    throw validationError("history record does not match a plan entry");
  }
  if ("albumId" in record) {
    if (!("albumId" in entry) || entry.albumId !== record.albumId) {
      throw validationError("history record does not match a plan entry");
    }
    return;
  }
  if ("albumId" in entry) {
    throw validationError("history record does not match a plan entry");
  }
  if (isLidarrArtistDeletePossibleDispatchHistoryRecord(record)) {
    if (
      (plan.version !== LIDARR_PLAN_VERSION_V2 && plan.version !== LIDARR_PLAN_VERSION_V3) ||
      plan.operation.kind !== "artist-delete" ||
      !("exists" in entry.after) ||
      entry.idempotencyKey !== record.idempotencyKey
    ) {
      throw validationError("possibly-dispatched history does not match the deletion plan entry");
    }
  }
}

/**
 * Returns whether an absent deletion target is attributable to a durable
 * pre-dispatch boundary for this exact sealed plan entry.
 */
export function hasLidarrArtistDeletePossibleDispatchEvidence(
  plan: LidarrMutationPlanV2 | LidarrMutationPlanV3,
  entry: LidarrMutationPlanEntryV2,
  history: readonly LidarrPlanHistoryRecord[],
): boolean {
  if (plan.operation.kind !== "artist-delete" || !("exists" in entry.after)) return false;
  const belongsToPlan = plan.entries.some(
    (candidate) =>
      candidate.id === entry.id &&
      candidate.artistId === entry.artistId &&
      candidate.idempotencyKey === entry.idempotencyKey,
  );
  if (!belongsToPlan) return false;
  return history.some((record) => {
    if (record.planId !== plan.id || record.planChecksum !== plan.payloadChecksum) return false;
    assertHistoryRecordMatchesPlan(plan, record);
    return (
      isLidarrArtistDeletePossibleDispatchHistoryRecord(record) &&
      record.entryId === entry.id &&
      record.artistId === entry.artistId &&
      record.idempotencyKey === entry.idempotencyKey
    );
  });
}

/**
 * Returns whether an artist-add target has durable possible-dispatch evidence
 * for this exact sealed foreign-ID entry.
 */
export function hasLidarrArtistAddPossibleDispatchEvidence(
  plan: LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3,
  entry: LidarrArtistAddPlanEntryV2,
  history: readonly LidarrPlanHistoryRecord[],
): boolean {
  return findLidarrArtistAddPossibleDispatchEvidence(plan, entry, history) !== undefined;
}

/**
 * Returns the durable artist-add possible-dispatch record for one exact sealed
 * foreign-ID entry, including its create-response identity when available.
 */
export function findLidarrArtistAddPossibleDispatchEvidence(
  plan: LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3,
  entry: LidarrArtistAddPlanEntryV2,
  history: readonly LidarrPlanHistoryRecord[],
): LidarrArtistAddPossibleDispatchHistoryRecord | undefined {
  const belongsToPlan = plan.entries.some(
    (candidate) =>
      candidate.id === entry.id &&
      candidate.foreignArtistId === entry.foreignArtistId &&
      candidate.idempotencyKey === entry.idempotencyKey,
  );
  if (!belongsToPlan) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const record = history[index];
    if (record === undefined) continue;
    if (record.planId !== plan.id || record.planChecksum !== plan.payloadChecksum) continue;
    assertHistoryRecordMatchesPlan(plan, record);
    if (
      isLidarrArtistAddPossibleDispatchHistoryRecord(record) &&
      record.entryId === entry.id &&
      record.foreignArtistId === entry.foreignArtistId &&
      record.idempotencyKey === entry.idempotencyKey
    ) {
      return record;
    }
  }
  return undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function translateLidarrIoFailure(
  error: unknown,
  path: string,
  message: string,
): LidarrPlanArtifactError | LidarrPlanValidationError | LidarrPlanAlreadyRunningError {
  if (
    error instanceof LidarrPlanArtifactError ||
    error instanceof LidarrPlanValidationError ||
    error instanceof LidarrPlanAlreadyRunningError
  ) {
    return error;
  }
  const unsafe =
    (error instanceof SecureStoreError &&
      (error.code === "SECURE_STORE_UNSAFE_PATH" || error.code === "SECURE_STORE_PERMISSIONS")) ||
    hasCode(error, "ELOOP") ||
    hasCode(error, "ENOTDIR") ||
    hasCode(error, "EACCES") ||
    hasCode(error, "EPERM");
  const code = unsafe
    ? "LIDARR_PLAN_UNSAFE_PATH"
    : error instanceof SecureStoreError && error.code === "SECURE_STORE_TOO_LARGE"
      ? "LIDARR_PLAN_TOO_LARGE"
      : "LIDARR_PLAN_IO";
  return new LidarrPlanArtifactError(code, message, path, { cause: error });
}

function translateLidarrCreateFailure(
  error: unknown,
  path: string,
  existsMessage: string,
  ioMessage: string,
): LidarrPlanArtifactError | LidarrPlanValidationError | LidarrPlanAlreadyRunningError {
  if (error instanceof SecureStoreError && error.code === "SECURE_STORE_VERSION_CONFLICT") {
    return new LidarrPlanArtifactError("LIDARR_PLAN_EXISTS", existsMessage, path, { cause: error });
  }
  return translateLidarrIoFailure(error, path, ioMessage);
}

function translateClaimAcquisitionFailure(
  error: unknown,
  planId: string,
  claimPath: string,
): LidarrPlanArtifactError | LidarrPlanValidationError | LidarrPlanAlreadyRunningError {
  if (
    error instanceof SecureStoreError &&
    (error.code === "SECURE_STORE_LOCK_BUSY" || error.code === "SECURE_STORE_CORRUPT")
  ) {
    return new LidarrPlanAlreadyRunningError(planId, claimPath);
  }
  return translateLidarrIoFailure(error, claimPath, "Unable to acquire Lidarr plan claim");
}

function translateClaimAssertionFailure(
  error: unknown,
  planId: string,
  claimPath: string,
): LidarrPlanArtifactError | LidarrPlanValidationError | LidarrPlanAlreadyRunningError {
  if (
    error instanceof SecureStoreError &&
    (error.code === "SECURE_STORE_LOCK_BUSY" || error.code === "SECURE_STORE_CORRUPT")
  ) {
    return new LidarrPlanAlreadyRunningError(planId, claimPath);
  }
  return translateLidarrIoFailure(error, claimPath, "Unable to assert Lidarr plan claim ownership");
}

function translateClaimReleaseFailure(error: unknown, claimPath: string): void {
  // A record we cannot parse cannot prove ownership, so preserve it and resolve
  // as "not owned" rather than masking the caller's in-flight failure.
  if (error instanceof SecureStoreError && error.code === "SECURE_STORE_CORRUPT") {
    return;
  }
  throw translateLidarrIoFailure(error, claimPath, "Unable to release Lidarr plan claim");
}

/** Acquires an exclusive per-plan claim and recovers only demonstrably stale owners. */
export async function acquireLidarrPlanClaim(
  planId: string,
  dependencies: LidarrPlanClaimDependencies = {},
): Promise<LidarrPlanClaim> {
  if (!UUID_PATTERN.test(planId)) throw validationError("claim planId must be a UUID");
  const claimDirectory = resolveLidarrStoragePath(
    dependencies.claimDirectory ?? join(getDefaultPlanDir(), "lidarr-claims"),
  );
  const claimPath = join(claimDirectory, `${planId}.lock`);
  const host = dependencies.hostname?.() ?? nodeHostname();
  const pid = dependencies.pid ?? process.pid;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    TERMINAL_CONTROL_PATTERN.test(host) ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    throw validationError("claim owner metadata is invalid");
  }
  const acquisitionTime = dependencies.now?.() ?? new Date();
  if (!(acquisitionTime instanceof Date)) {
    throw validationError("claim acquisition time is invalid");
  }
  const acquisitionEpochMs = acquisitionTime.getTime();
  if (!Number.isSafeInteger(acquisitionEpochMs)) {
    throw validationError("claim acquisition time is invalid");
  }
  const ownershipToken = dependencies.randomUUID?.() ?? nodeRandomUUID();
  if (typeof ownershipToken !== "string" || !UUID_PATTERN.test(ownershipToken)) {
    throw validationError("claim ownership token must be a UUID");
  }

  let held: SecureStoreLock;
  try {
    held = await acquireExclusiveLock(claimPath, {
      subject: "Lidarr plan claim",
      // A deadline equal to the cached acquisition time preserves immediate
      // contention failure while still allowing one dead same-host recovery.
      deadlineEpochMs: acquisitionEpochMs,
      // A healthy apply can exceed the shared age threshold and has no renewal
      // API, so age alone must never allow another process to steal its claim.
      maxAgeMs: null,
      strictRecordShape: true,
      now: () => acquisitionEpochMs,
      hostname: () => host,
      pid,
      isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
      randomUUID: () => ownershipToken,
      temporaryUUID: nodeRandomUUID,
      // No binding: the validated plan ID already namespaces the filename, and
      // legacy four-field claims must remain recoverable after a crashed apply.
    });
  } catch (error) {
    throw translateClaimAcquisitionFailure(error, planId, claimPath);
  }

  return Object.freeze({
    path: held.path,
    assertOwned: async (): Promise<void> => {
      try {
        await held.assertOwned();
      } catch (error) {
        throw translateClaimAssertionFailure(error, planId, claimPath);
      }
    },
    release: async (): Promise<void> => {
      try {
        await held.release();
      } catch (error) {
        translateClaimReleaseFailure(error, claimPath);
      }
    },
  });
}
