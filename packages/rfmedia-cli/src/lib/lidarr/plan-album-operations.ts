/**
 * Typed behavior definitions, validators, and the sealed builder for the
 * album-family v2 mutation operations (`album-edit` / `album-delete`).
 *
 * This is a PARALLEL lane beside the artist-typed v2 machinery in
 * plan-operation-definitions.ts (design §4): album definitions classify and
 * verify against `LidarrAlbum | undefined` (absence is an observable state —
 * a missing delete target is "satisfied") instead of the artist-typed
 * signatures, so the shipped artist definitions stay untouched.
 */

import { createHash } from "node:crypto";

import {
  LIDARR_PLAN_MAX_BATCH,
  LIDARR_PLAN_MAX_ENTRIES,
  LIDARR_PLAN_VERSION_V2,
  type LidarrAlbumDeleteOperationV2,
  type LidarrAlbumDeletePlanEntryV2,
  type LidarrAlbumEditOperationV2,
  type LidarrAlbumEditPlanEntryV2,
  type LidarrAlbumMutationOperationV2,
  type LidarrAlbumMutationPlanEntryV2,
  type LidarrAlbumMutationPlanV2,
  type LidarrAlbumMutationPlanV3,
  type LidarrAlbumPlanOperationSummaryV2,
  type LidarrAlbumPlanSelectionV2,
  type LidarrAlbumPlanStalenessFinding,
  type LidarrCascadePolicy,
  type LidarrPlanRiskSummary,
} from "../../types/lidarr-plan.js";
import type { LidarrAlbum } from "../../types/lidarr.js";
import type { LidarrClientApi } from "./client.js";
import type { LidarrIntentExecutor } from "./deferred-queue.js";
// CIRCULARITY GUARD: plan-engine.ts statically imports this module's
// validators while this module imports the engine's sealing helpers. The
// cycle is safe only because BOTH modules reference the other's bindings
// exclusively inside function bodies — never during module evaluation — so
// no ESM temporal-dead-zone read can occur regardless of load order. Keep it
// that way: no top-level calls into plan-engine.js from this module.
import {
  assertLidarrAlbumMutationPlanV2,
  canonicalizeLidarrPlanOrigin,
  computeLidarrPlanChecksum,
  createLidarrPlanEnvelope,
  sealLidarrMutationPlanV3,
  type LidarrPlanBuildDependencies,
} from "./plan-engine.js";
import type {
  LidarrPlanEntryClassification,
  LidarrPlanReferencedResource,
} from "./plan-operation-definitions.js";
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

export const LIDARR_ALBUM_EDIT_OPERATION = "lidarr.album-edit";
export const LIDARR_ALBUM_DELETE_OPERATION = "lidarr.album-delete";

const MAX_OPERATION_SELECTORS = 64;

/** Normalized source state from which an album definition constructs an entry. */
export type LidarrAlbumPlanEntrySource =
  | {
      readonly kind: "album-edit";
      readonly albumId: number;
      readonly albumTitle: string;
      readonly artistId: number;
      readonly artistName: string;
      readonly albumType?: string;
      readonly anyReleaseOk: boolean;
    }
  | {
      readonly kind: "album-delete";
      readonly albumId: number;
      readonly albumTitle: string;
      readonly artistId: number;
      readonly artistName: string;
      readonly albumType?: string;
      readonly foreignAlbumId?: string;
      readonly monitored: boolean;
      readonly trackFileCount: number;
      readonly sizeOnDisk: number;
    };

/** Input for constructing one sealed album-family v2 mutation plan. */
export interface BuildLidarrAlbumMutationPlanV2Input {
  readonly origin: string;
  readonly selection: LidarrAlbumPlanSelectionV2;
  readonly operation: LidarrAlbumMutationOperationV2;
  readonly maxBatch: number;
  readonly entries: readonly LidarrAlbumPlanEntrySource[];
}

/** Input for sealing an album-family plan with resolved cascade policy. */
export interface BuildLidarrAlbumMutationPlanV3Input extends BuildLidarrAlbumMutationPlanV2Input {
  readonly cascadePolicy: LidarrCascadePolicy;
}

/**
 * Exact behavior contract for one allowlisted album mutation operation.
 *
 * Sibling of the artist-typed `LidarrMutationOperationDefinition`: classify
 * and verify take `LidarrAlbum | undefined` so target absence is a first-class
 * observation (delete treats it as satisfied; edit fails closed).
 */
export interface LidarrAlbumMutationOperationDefinition {
  readonly kind: LidarrAlbumMutationOperationV2["kind"];
  readonly operation: LidarrAlbumMutationOperationV2;
  readonly deferredOperation: string;
  canonicalize(): LidarrAlbumMutationOperationV2;
  risk(): LidarrPlanRiskSummary;
  referencedResources(): readonly LidarrPlanReferencedResource[];
  buildEntry(origin: string, source: LidarrAlbumPlanEntrySource): LidarrAlbumMutationPlanEntryV2;
  hasChange(entry: LidarrAlbumMutationPlanEntryV2): boolean;
  summarize(entries: readonly LidarrAlbumMutationPlanEntryV2[]): LidarrAlbumPlanOperationSummaryV2;
  payloadFor(entry: LidarrAlbumMutationPlanEntryV2): Readonly<Record<string, unknown>>;
  idempotencyKey(origin: string, entry: LidarrAlbumMutationPlanEntryV2): string;
  classify(
    entry: LidarrAlbumMutationPlanEntryV2,
    current: LidarrAlbum | undefined,
  ): LidarrPlanEntryClassification;
  verify(entry: LidarrAlbumMutationPlanEntryV2, current: LidarrAlbum | undefined): boolean;
  /** Targeted live reads via `listAlbums({albumIds})`; absence = missing map key. */
  loadCurrentStates(
    client: LidarrClientApi,
    entries: readonly LidarrAlbumMutationPlanEntryV2[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, LidarrAlbum>>;
  entryId(entry: LidarrAlbumMutationPlanEntryV2): string;
  entryLabel(entry: LidarrAlbumMutationPlanEntryV2): string;
  taskIdFragment(entry: LidarrAlbumMutationPlanEntryV2): string;
  resultSortKey(entry: LidarrAlbumMutationPlanEntryV2): number;
  staleFinding(
    entry: LidarrAlbumMutationPlanEntryV2,
    reason: "missing" | "drift",
  ): LidarrAlbumPlanStalenessFinding;
  execute(
    entry: LidarrAlbumMutationPlanEntryV2,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
  executeDeferredPayload(
    payload: Readonly<Record<string, unknown>>,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
  matchesDeferredIntent(
    entry: LidarrAlbumMutationPlanEntryV2,
    queuedOperation: string,
    queuedPayload: Readonly<Record<string, unknown>>,
  ): boolean;
}

/** Structural discriminator: album-edit entries carry `before.anyReleaseOk`. */
export function isAlbumEditPlanEntry(
  entry: LidarrAlbumMutationPlanEntryV2,
): entry is LidarrAlbumEditPlanEntryV2 {
  return "anyReleaseOk" in entry.before;
}

/** Structural discriminator: album-delete entries carry `after.deleted`. */
export function isAlbumDeletePlanEntry(
  entry: LidarrAlbumMutationPlanEntryV2,
): entry is LidarrAlbumDeletePlanEntryV2 {
  return "deleted" in entry.after;
}

function requireEditEntry(entry: LidarrAlbumMutationPlanEntryV2): LidarrAlbumEditPlanEntryV2 {
  if (!isAlbumEditPlanEntry(entry)) {
    throw validationError("album-edit definition received an incompatible entry");
  }
  return entry;
}

function requireDeleteEntry(entry: LidarrAlbumMutationPlanEntryV2): LidarrAlbumDeletePlanEntryV2 {
  if (!isAlbumDeletePlanEntry(entry)) {
    throw validationError("album-delete definition received an incompatible entry");
  }
  return entry;
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    throw validationError(`${path} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value;
}

function hashIdempotencyMaterial(material: UnknownRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex")}`;
}

function exactPayloadMatch(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return (
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, index) => key === actualKeys[index]) &&
    expectedKeys.every((key) => expected[key] === actual[key])
  );
}

/** Canonical selector normal form: deduped and sorted by UTF-16 code units. */
function canonicalizeSelectors(selectors: readonly string[]): readonly string[] {
  return [...new Set(selectors)].sort();
}

function requireAlbumSelectors(value: unknown, path: string): readonly string[] {
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

function requireSortedIds(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`${path} must be a bounded non-empty array`);
  }
  let previous = 0;
  return value.map((item, index) => {
    const id = requirePositiveInteger(item, `${path}[${index}]`);
    if (id <= previous) throw validationError(`${path} must be sorted and unique`);
    previous = id;
    return id;
  });
}

const ALBUM_EDIT_RISK = Object.freeze({
  level: "medium",
  destructive: false,
  cascade: Object.freeze([
    "Existing files remain unchanged.",
    "Future release selection for edited albums may change.",
    "No artist or album search is triggered.",
  ]),
}) satisfies LidarrPlanRiskSummary;

/** Deterministic per-operation risk so validators can recompute it exactly. */
function createAlbumDeleteRisk(operation: LidarrAlbumDeleteOperationV2): LidarrPlanRiskSummary {
  return Object.freeze({
    level: "high",
    destructive: true,
    cascade: Object.freeze([
      "Albums are removed from the Lidarr library.",
      operation.deleteFiles
        ? "Track files on disk are PERMANENTLY deleted and cannot be recovered."
        : "Track files on disk are not deleted.",
      operation.addImportListExclusion
        ? "Import-list exclusions are added so deleted albums are not re-imported."
        : "Deleted albums may be re-added by import lists unless --add-import-list-exclusion is set.",
    ]),
  }) satisfies LidarrPlanRiskSummary;
}

interface AlbumEntryIdentity {
  readonly id: string;
  readonly albumId: number;
  readonly albumTitle: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly albumType?: string;
}

function validateAlbumSourceIdentity(
  source: Extract<LidarrAlbumPlanEntrySource, { readonly albumId: number }>,
): AlbumEntryIdentity {
  const albumId = requirePositiveInteger(source.albumId, "entry source.albumId");
  return {
    id: `album:${albumId}`,
    albumId,
    // Album titles may legitimately be "" (Lidarr null-title normalization).
    albumTitle: requireString(source.albumTitle, `album ${albumId} title`, true),
    artistId: requirePositiveInteger(source.artistId, `album ${albumId} artistId`),
    artistName: requireString(source.artistName, `album ${albumId} artist name`),
    ...(source.albumType === undefined
      ? {}
      : { albumType: requireString(source.albumType, `album ${albumId} type`) }),
  };
}

async function loadAlbumCurrentStates(
  client: LidarrClientApi,
  entries: readonly LidarrAlbumMutationPlanEntryV2[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, LidarrAlbum>> {
  if (entries.length === 0) return new Map();
  const albumIds = entries.map((entry) => entry.albumId);
  const albums = await client.listAlbums({ albumIds, signal });
  return new Map(albums.map((album) => [`album:${album.id}`, album]));
}

function albumStaleFinding(
  entry: LidarrAlbumMutationPlanEntryV2,
  reason: "missing" | "drift",
  driftDetail: string,
): LidarrAlbumPlanStalenessFinding {
  return {
    code: reason === "missing" ? "album-missing" : "album-state-drift",
    entryId: entry.id,
    albumId: entry.albumId,
    message:
      reason === "missing"
        ? `Album ${entry.albumId} no longer exists`
        : `Album ${entry.albumId} ${driftDetail}`,
  };
}

async function executeDeferredAlbumEditPayload(
  payload: Readonly<Record<string, unknown>>,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<void> {
  const path = "deferred album-edit payload";
  const record = requireRecord(payload, path);
  requireExactKeys(record, path, ["albumId", "anyReleaseOk"]);
  assertNoSensitiveKeys(record, path);
  const albumId = requirePositiveInteger(record["albumId"], `${path}.albumId`);
  const anyReleaseOk = requireBoolean(record["anyReleaseOk"], `${path}.anyReleaseOk`);
  await client.setAlbumAnyReleaseOk(albumId, anyReleaseOk, signal);
}

async function executeDeferredAlbumDeletePayload(
  payload: Readonly<Record<string, unknown>>,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<void> {
  const path = "deferred album-delete payload";
  const record = requireRecord(payload, path);
  requireExactKeys(record, path, ["albumId", "deleteFiles", "addImportListExclusion"]);
  assertNoSensitiveKeys(record, path);
  const albumId = requirePositiveInteger(record["albumId"], `${path}.albumId`);
  const deleteFiles = requireBoolean(record["deleteFiles"], `${path}.deleteFiles`);
  const addImportListExclusion = requireBoolean(
    record["addImportListExclusion"],
    `${path}.addImportListExclusion`,
  );
  await client.deleteAlbum(albumId, { deleteFiles, addImportListExclusion }, signal);
}

function createAlbumEditDefinition(
  input: LidarrAlbumEditOperationV2,
): LidarrAlbumMutationOperationDefinition {
  const operation = Object.freeze({
    kind: "album-edit",
    desiredAnyReleaseOk: requireBoolean(
      input.desiredAnyReleaseOk,
      "album-edit operation.desiredAnyReleaseOk",
    ),
    selectors: canonicalizeSelectors(input.selectors),
  }) satisfies LidarrAlbumEditOperationV2;
  const definition: LidarrAlbumMutationOperationDefinition = {
    kind: operation.kind,
    operation,
    deferredOperation: LIDARR_ALBUM_EDIT_OPERATION,
    canonicalize: () => ({ ...operation, selectors: [...operation.selectors] }),
    risk: () => ALBUM_EDIT_RISK,
    referencedResources: () => Object.freeze([]),
    buildEntry(origin, source) {
      if (source.kind !== "album-edit") {
        throw validationError("album-edit definition received an incompatible entry source");
      }
      const identity = validateAlbumSourceIdentity(source);
      const entry: LidarrAlbumEditPlanEntryV2 = {
        ...identity,
        before: {
          anyReleaseOk: requireBoolean(
            source.anyReleaseOk,
            `album ${identity.albumId} anyReleaseOk`,
          ),
        },
        after: { anyReleaseOk: operation.desiredAnyReleaseOk },
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entry,
        idempotencyKey: definition.idempotencyKey(origin, entry),
      });
    },
    hasChange(entry) {
      const editEntry = requireEditEntry(entry);
      return editEntry.before.anyReleaseOk !== editEntry.after.anyReleaseOk;
    },
    summarize(entries) {
      const editEntries = entries.map(requireEditEntry);
      return Object.freeze({
        kind: operation.kind,
        changedToTrue: editEntries.filter(
          (entry) => !entry.before.anyReleaseOk && entry.after.anyReleaseOk,
        ).length,
        changedToFalse: editEntries.filter(
          (entry) => entry.before.anyReleaseOk && !entry.after.anyReleaseOk,
        ).length,
      });
    },
    payloadFor(entry) {
      const editEntry = requireEditEntry(entry);
      return Object.freeze({
        albumId: editEntry.albumId,
        anyReleaseOk: editEntry.after.anyReleaseOk,
      });
    },
    idempotencyKey(origin, entry) {
      return hashIdempotencyMaterial({
        origin,
        operation: operation.kind,
        albumId: entry.albumId,
        desiredAnyReleaseOk: operation.desiredAnyReleaseOk,
      });
    },
    classify(entry, current) {
      const editEntry = requireEditEntry(entry);
      // Fail closed: an edit target that vanished or lost its release policy
      // is never dispatchable.
      if (current === undefined) return "drifted";
      if (current.anyReleaseOk === editEntry.after.anyReleaseOk) return "satisfied";
      return current.anyReleaseOk === editEntry.before.anyReleaseOk ? "ready" : "drifted";
    },
    verify(entry, current) {
      const editEntry = requireEditEntry(entry);
      return current !== undefined && current.anyReleaseOk === editEntry.after.anyReleaseOk;
    },
    loadCurrentStates: loadAlbumCurrentStates,
    entryId: (entry) => entry.id,
    entryLabel: (entry) => `${entry.albumTitle} — ${entry.artistName}`,
    taskIdFragment: (entry) => `album:${entry.albumId}`,
    resultSortKey: (entry) => entry.albumId,
    staleFinding: (entry, reason) =>
      albumStaleFinding(entry, reason, "release policy changed after planning"),
    async execute(entry, client, signal) {
      const editEntry = requireEditEntry(entry);
      await client.setAlbumAnyReleaseOk(editEntry.albumId, editEntry.after.anyReleaseOk, signal);
    },
    executeDeferredPayload: executeDeferredAlbumEditPayload,
    matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
      return (
        queuedOperation === definition.deferredOperation &&
        exactPayloadMatch(definition.payloadFor(entry), queuedPayload)
      );
    },
  };
  return Object.freeze(definition);
}

function createAlbumDeleteDefinition(
  input: LidarrAlbumDeleteOperationV2,
): LidarrAlbumMutationOperationDefinition {
  const operation = Object.freeze({
    kind: "album-delete",
    deleteFiles: requireBoolean(input.deleteFiles, "album-delete operation.deleteFiles"),
    addImportListExclusion: requireBoolean(
      input.addImportListExclusion,
      "album-delete operation.addImportListExclusion",
    ),
    includeMonitored: requireBoolean(
      input.includeMonitored,
      "album-delete operation.includeMonitored",
    ),
    selectors: canonicalizeSelectors(input.selectors),
  }) satisfies LidarrAlbumDeleteOperationV2;
  const risk = createAlbumDeleteRisk(operation);
  const definition: LidarrAlbumMutationOperationDefinition = {
    kind: operation.kind,
    operation,
    deferredOperation: LIDARR_ALBUM_DELETE_OPERATION,
    canonicalize: () => ({ ...operation, selectors: [...operation.selectors] }),
    risk: () => risk,
    referencedResources: () => Object.freeze([]),
    buildEntry(origin, source) {
      if (source.kind !== "album-delete") {
        throw validationError("album-delete definition received an incompatible entry source");
      }
      const identity = validateAlbumSourceIdentity(source);
      const foreignAlbumId =
        source.foreignAlbumId === undefined
          ? undefined
          : requireString(source.foreignAlbumId, `album ${identity.albumId} foreignAlbumId`);
      const entry: LidarrAlbumDeletePlanEntryV2 = {
        ...identity,
        ...(foreignAlbumId === undefined ? {} : { foreignAlbumId }),
        before: {
          monitored: requireBoolean(source.monitored, `album ${identity.albumId} monitored`),
          trackFileCount: requireNonNegativeInteger(
            source.trackFileCount,
            `album ${identity.albumId} trackFileCount`,
          ),
          sizeOnDisk: requireNonNegativeInteger(
            source.sizeOnDisk,
            `album ${identity.albumId} sizeOnDisk`,
          ),
        },
        after: { deleted: true },
        idempotencyKey: "",
      };
      return Object.freeze({
        ...entry,
        idempotencyKey: definition.idempotencyKey(origin, entry),
      });
    },
    hasChange(entry) {
      requireDeleteEntry(entry);
      // Every planned deletion mutates the library.
      return true;
    },
    summarize(entries) {
      const deleteEntries = entries.map(requireDeleteEntry);
      return Object.freeze({
        kind: operation.kind,
        albums: deleteEntries.length,
        withFiles: deleteEntries.filter((entry) => entry.before.trackFileCount > 0).length,
        totalTrackFiles: deleteEntries.reduce((sum, entry) => sum + entry.before.trackFileCount, 0),
        totalSizeOnDisk: deleteEntries.reduce((sum, entry) => sum + entry.before.sizeOnDisk, 0),
        deleteFiles: operation.deleteFiles,
        importListExclusions: operation.addImportListExclusion,
      });
    },
    payloadFor(entry) {
      const deleteEntry = requireDeleteEntry(entry);
      return Object.freeze({
        albumId: deleteEntry.albumId,
        deleteFiles: operation.deleteFiles,
        addImportListExclusion: operation.addImportListExclusion,
      });
    },
    idempotencyKey(origin, entry) {
      const deleteEntry = requireDeleteEntry(entry);
      return hashIdempotencyMaterial({
        origin,
        operation: operation.kind,
        albumId: deleteEntry.albumId,
        deleteFiles: operation.deleteFiles,
        addImportListExclusion: operation.addImportListExclusion,
        foreignAlbumId: deleteEntry.foreignAlbumId ?? null,
      });
    },
    classify(entry, current) {
      const deleteEntry = requireDeleteEntry(entry);
      // MISSING target == already deleted == satisfied (idempotent deletion).
      if (current === undefined) return "satisfied";
      // Fail-closed wrong-target guard: any observable identity/state drift
      // blocks the destructive dispatch.
      if (current.monitored !== deleteEntry.before.monitored) return "drifted";
      if (
        deleteEntry.foreignAlbumId !== undefined &&
        current.foreignAlbumId !== deleteEntry.foreignAlbumId
      ) {
        return "drifted";
      }
      return "ready";
    },
    verify(_entry, current) {
      // Absence is the verified postcondition of destruction.
      return current === undefined;
    },
    loadCurrentStates: loadAlbumCurrentStates,
    entryId: (entry) => entry.id,
    entryLabel: (entry) => `${entry.albumTitle} — ${entry.artistName}`,
    taskIdFragment: (entry) => `album:${entry.albumId}`,
    resultSortKey: (entry) => entry.albumId,
    staleFinding: (entry, reason) =>
      albumStaleFinding(entry, reason, "state changed after planning"),
    async execute(entry, client, signal) {
      const deleteEntry = requireDeleteEntry(entry);
      await client.deleteAlbum(
        deleteEntry.albumId,
        {
          deleteFiles: operation.deleteFiles,
          addImportListExclusion: operation.addImportListExclusion,
        },
        signal,
      );
    },
    executeDeferredPayload: executeDeferredAlbumDeletePayload,
    matchesDeferredIntent(entry, queuedOperation, queuedPayload) {
      return (
        queuedOperation === definition.deferredOperation &&
        exactPayloadMatch(definition.payloadFor(entry), queuedPayload)
      );
    },
  };
  return Object.freeze(definition);
}

/** Resolves the typed behavior owner for an allowlisted album plan operation. */
export function getLidarrAlbumMutationOperationDefinition(
  operation: LidarrAlbumMutationOperationV2,
): LidarrAlbumMutationOperationDefinition {
  switch (operation.kind) {
    case "album-edit":
      return createAlbumEditDefinition(operation);
    case "album-delete":
      return createAlbumDeleteDefinition(operation);
  }
}

/** Returns the explicit, allowlisted album deferred executors. */
export function createLidarrAlbumMutationExecutors(): ReadonlyMap<string, LidarrIntentExecutor> {
  return new Map<string, LidarrIntentExecutor>([
    [
      LIDARR_ALBUM_EDIT_OPERATION,
      Object.freeze({
        operation: LIDARR_ALBUM_EDIT_OPERATION,
        execute: executeDeferredAlbumEditPayload,
      }),
    ],
    [
      LIDARR_ALBUM_DELETE_OPERATION,
      Object.freeze({
        operation: LIDARR_ALBUM_DELETE_OPERATION,
        execute: executeDeferredAlbumDeletePayload,
      }),
    ],
  ]);
}

/** Exact allowlist validator for an untrusted album-edit operation. */
export function requireAlbumEditOperation(value: unknown): LidarrAlbumEditOperationV2 {
  const operation = requireRecord(value, "plan.operation");
  requireExactKeys(operation, "plan.operation", ["kind", "desiredAnyReleaseOk", "selectors"]);
  if (operation["kind"] !== "album-edit") {
    throw validationError("plan.operation.kind is invalid");
  }
  return {
    kind: "album-edit",
    desiredAnyReleaseOk: requireBoolean(
      operation["desiredAnyReleaseOk"],
      "plan.operation.desiredAnyReleaseOk",
    ),
    selectors: requireAlbumSelectors(operation["selectors"], "plan.operation.selectors"),
  };
}

/** Exact allowlist validator for an untrusted album-delete operation. */
export function requireAlbumDeleteOperation(value: unknown): LidarrAlbumDeleteOperationV2 {
  const operation = requireRecord(value, "plan.operation");
  requireExactKeys(operation, "plan.operation", [
    "kind",
    "deleteFiles",
    "addImportListExclusion",
    "includeMonitored",
    "selectors",
  ]);
  if (operation["kind"] !== "album-delete") {
    throw validationError("plan.operation.kind is invalid");
  }
  return {
    kind: "album-delete",
    deleteFiles: requireBoolean(operation["deleteFiles"], "plan.operation.deleteFiles"),
    addImportListExclusion: requireBoolean(
      operation["addImportListExclusion"],
      "plan.operation.addImportListExclusion",
    ),
    includeMonitored: requireBoolean(
      operation["includeMonitored"],
      "plan.operation.includeMonitored",
    ),
    selectors: requireAlbumSelectors(operation["selectors"], "plan.operation.selectors"),
  };
}

function requireAlbumEntryIdentity(entry: UnknownRecord, path: string): AlbumEntryIdentity {
  const id = requireString(entry["id"], `${path}.id`);
  const albumId = requirePositiveInteger(entry["albumId"], `${path}.albumId`);
  if (id !== `album:${albumId}`) throw validationError(`${path}.id does not match albumId`);
  return {
    id,
    albumId,
    albumTitle: requireString(entry["albumTitle"], `${path}.albumTitle`, true),
    artistId: requirePositiveInteger(entry["artistId"], `${path}.artistId`),
    artistName: requireString(entry["artistName"], `${path}.artistName`),
    ...(entry["albumType"] === undefined
      ? {}
      : { albumType: requireString(entry["albumType"], `${path}.albumType`) }),
  };
}

/** Exact allowlist validator for one untrusted album-edit plan entry. */
export function requireAlbumEditEntry(
  value: unknown,
  index: number,
  operation: LidarrAlbumEditOperationV2,
): LidarrAlbumEditPlanEntryV2 {
  const path = `plan.entries[${index}]`;
  const entry = requireRecord(value, path);
  requireExactKeys(
    entry,
    path,
    ["id", "albumId", "albumTitle", "artistId", "artistName", "before", "after", "idempotencyKey"],
    ["albumType"],
  );
  const identity = requireAlbumEntryIdentity(entry, path);
  const before = requireRecord(entry["before"], `${path}.before`);
  const after = requireRecord(entry["after"], `${path}.after`);
  requireExactKeys(before, `${path}.before`, ["anyReleaseOk"]);
  requireExactKeys(after, `${path}.after`, ["anyReleaseOk"]);
  const result: LidarrAlbumEditPlanEntryV2 = {
    ...identity,
    before: {
      anyReleaseOk: requireBoolean(before["anyReleaseOk"], `${path}.before.anyReleaseOk`),
    },
    after: {
      anyReleaseOk: requireBoolean(after["anyReleaseOk"], `${path}.after.anyReleaseOk`),
    },
    idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
  };
  if (result.after.anyReleaseOk !== operation.desiredAnyReleaseOk) {
    throw validationError(`${path}.after is inconsistent with plan.operation`);
  }
  return result;
}

/** Exact allowlist validator for one untrusted album-delete plan entry. */
export function requireAlbumDeleteEntry(
  value: unknown,
  index: number,
  _operation: LidarrAlbumDeleteOperationV2,
): LidarrAlbumDeletePlanEntryV2 {
  const path = `plan.entries[${index}]`;
  const entry = requireRecord(value, path);
  requireExactKeys(
    entry,
    path,
    ["id", "albumId", "albumTitle", "artistId", "artistName", "before", "after", "idempotencyKey"],
    ["albumType", "foreignAlbumId"],
  );
  const identity = requireAlbumEntryIdentity(entry, path);
  const foreignAlbumId =
    entry["foreignAlbumId"] === undefined
      ? undefined
      : requireString(entry["foreignAlbumId"], `${path}.foreignAlbumId`);
  const before = requireRecord(entry["before"], `${path}.before`);
  requireExactKeys(before, `${path}.before`, ["monitored", "trackFileCount", "sizeOnDisk"]);
  const after = requireRecord(entry["after"], `${path}.after`);
  requireExactKeys(after, `${path}.after`, ["deleted"]);
  if (after["deleted"] !== true) {
    throw validationError(`${path}.after must be exactly { deleted: true }`);
  }
  return {
    ...identity,
    ...(foreignAlbumId === undefined ? {} : { foreignAlbumId }),
    before: {
      monitored: requireBoolean(before["monitored"], `${path}.before.monitored`),
      trackFileCount: requireNonNegativeInteger(
        before["trackFileCount"],
        `${path}.before.trackFileCount`,
      ),
      sizeOnDisk: requireNonNegativeInteger(before["sizeOnDisk"], `${path}.before.sizeOnDisk`),
    },
    after: { deleted: true },
    idempotencyKey: requireString(entry["idempotencyKey"], `${path}.idempotencyKey`),
  };
}

/** Exact allowlist validator for an untrusted album selection context. */
export function requireLidarrAlbumPlanSelection(value: unknown): LidarrAlbumPlanSelectionV2 {
  const selection = requireRecord(value, "plan.selection");
  switch (selection["kind"]) {
    case "album-ids": {
      requireExactKeys(selection, "plan.selection", ["kind", "albumIds"]);
      return {
        kind: "album-ids",
        albumIds: requireSortedIds(selection["albumIds"], "plan.selection.albumIds"),
      };
    }
    case "album-filters": {
      requireExactKeys(
        selection,
        "plan.selection",
        ["kind", "selectors"],
        ["artistIds", "includeMonitored"],
      );
      const artistIds =
        selection["artistIds"] === undefined
          ? undefined
          : requireSortedIds(selection["artistIds"], "plan.selection.artistIds");
      const includeMonitored =
        selection["includeMonitored"] === undefined
          ? undefined
          : requireBoolean(selection["includeMonitored"], "plan.selection.includeMonitored");
      return {
        kind: "album-filters",
        ...(artistIds === undefined ? {} : { artistIds }),
        selectors: requireAlbumSelectors(selection["selectors"], "plan.selection.selectors"),
        ...(includeMonitored === undefined ? {} : { includeMonitored }),
      };
    }
    default:
      throw validationError("plan.selection.kind is invalid");
  }
}

/** Canonical key-order projection for one album selection context. */
export function canonicalizeLidarrAlbumPlanSelection(
  selection: LidarrAlbumPlanSelectionV2,
): LidarrAlbumPlanSelectionV2 {
  if (selection.kind === "album-ids") {
    return { kind: "album-ids", albumIds: [...selection.albumIds] };
  }
  return {
    kind: "album-filters",
    ...(selection.artistIds === undefined ? {} : { artistIds: [...selection.artistIds] }),
    selectors: [...selection.selectors],
    ...(selection.includeMonitored === undefined
      ? {}
      : { includeMonitored: selection.includeMonitored }),
  };
}

/** Canonical key-order projection for one album plan entry. */
export function canonicalizeLidarrAlbumMutationPlanEntry(
  operation: LidarrAlbumMutationOperationV2,
  entry: LidarrAlbumMutationPlanEntryV2,
): LidarrAlbumMutationPlanEntryV2 {
  if (operation.kind === "album-edit") {
    const editEntry = requireEditEntry(entry);
    return {
      id: editEntry.id,
      albumId: editEntry.albumId,
      albumTitle: editEntry.albumTitle,
      artistId: editEntry.artistId,
      artistName: editEntry.artistName,
      ...(editEntry.albumType === undefined ? {} : { albumType: editEntry.albumType }),
      before: { anyReleaseOk: editEntry.before.anyReleaseOk },
      after: { anyReleaseOk: editEntry.after.anyReleaseOk },
      idempotencyKey: editEntry.idempotencyKey,
    };
  }
  const deleteEntry = requireDeleteEntry(entry);
  return {
    id: deleteEntry.id,
    albumId: deleteEntry.albumId,
    albumTitle: deleteEntry.albumTitle,
    artistId: deleteEntry.artistId,
    artistName: deleteEntry.artistName,
    ...(deleteEntry.foreignAlbumId === undefined
      ? {}
      : { foreignAlbumId: deleteEntry.foreignAlbumId }),
    ...(deleteEntry.albumType === undefined ? {} : { albumType: deleteEntry.albumType }),
    before: {
      monitored: deleteEntry.before.monitored,
      trackFileCount: deleteEntry.before.trackFileCount,
      sizeOnDisk: deleteEntry.before.sizeOnDisk,
    },
    after: { deleted: true },
    idempotencyKey: deleteEntry.idempotencyKey,
  };
}

/** Canonical key-order projection for one album plan summary. */
export function canonicalizeLidarrAlbumPlanSummary(
  summary: LidarrAlbumPlanOperationSummaryV2,
): LidarrAlbumPlanOperationSummaryV2 {
  if (summary.kind === "album-edit") {
    return {
      kind: summary.kind,
      changedToTrue: summary.changedToTrue,
      changedToFalse: summary.changedToFalse,
    };
  }
  return {
    kind: summary.kind,
    albums: summary.albums,
    withFiles: summary.withFiles,
    totalTrackFiles: summary.totalTrackFiles,
    totalSizeOnDisk: summary.totalSizeOnDisk,
    deleteFiles: summary.deleteFiles,
    importListExclusions: summary.importListExclusions,
  };
}

/** Recomputes and enforces the album summary against validated entries. */
export function assertLidarrAlbumPlanSummary(
  value: unknown,
  operation: LidarrAlbumMutationOperationV2,
  entries: readonly LidarrAlbumMutationPlanEntryV2[],
): void {
  const summary = requireRecord(value, "plan.summary");
  if (operation.kind === "album-edit") {
    requireExactKeys(summary, "plan.summary", ["kind", "changedToTrue", "changedToFalse"]);
    if (summary["kind"] !== operation.kind) {
      throw validationError("plan.summary is inconsistent with plan.operation");
    }
    const editEntries = entries.map(requireEditEntry);
    const changedToTrue = editEntries.filter(
      (entry) => !entry.before.anyReleaseOk && entry.after.anyReleaseOk,
    ).length;
    const changedToFalse = editEntries.filter(
      (entry) => entry.before.anyReleaseOk && !entry.after.anyReleaseOk,
    ).length;
    if (
      requireNonNegativeInteger(
        summary["changedToTrue"],
        "plan.summary.changedToTrue",
        entries.length,
      ) !== changedToTrue ||
      requireNonNegativeInteger(
        summary["changedToFalse"],
        "plan.summary.changedToFalse",
        entries.length,
      ) !== changedToFalse
    ) {
      throw validationError("plan.summary counts are inconsistent");
    }
    return;
  }
  requireExactKeys(summary, "plan.summary", [
    "kind",
    "albums",
    "withFiles",
    "totalTrackFiles",
    "totalSizeOnDisk",
    "deleteFiles",
    "importListExclusions",
  ]);
  if (summary["kind"] !== operation.kind) {
    throw validationError("plan.summary is inconsistent with plan.operation");
  }
  const deleteEntries = entries.map(requireDeleteEntry);
  const withFiles = deleteEntries.filter((entry) => entry.before.trackFileCount > 0).length;
  const totalTrackFiles = deleteEntries.reduce(
    (sum, entry) => sum + entry.before.trackFileCount,
    0,
  );
  const totalSizeOnDisk = deleteEntries.reduce((sum, entry) => sum + entry.before.sizeOnDisk, 0);
  if (
    requireNonNegativeInteger(summary["albums"], "plan.summary.albums", entries.length) !==
      entries.length ||
    requireNonNegativeInteger(summary["withFiles"], "plan.summary.withFiles", entries.length) !==
      withFiles ||
    requireNonNegativeInteger(summary["totalTrackFiles"], "plan.summary.totalTrackFiles") !==
      totalTrackFiles ||
    requireNonNegativeInteger(summary["totalSizeOnDisk"], "plan.summary.totalSizeOnDisk") !==
      totalSizeOnDisk
  ) {
    throw validationError("plan.summary counts are inconsistent");
  }
  if (
    summary["deleteFiles"] !== operation.deleteFiles ||
    summary["importListExclusions"] !== operation.addImportListExclusion
  ) {
    throw validationError("plan.summary is inconsistent with plan.operation");
  }
}

/**
 * Builds, canonicalizes, validates, and checksum-seals one album-family v2
 * mutation plan. SEPARATE from `buildLidarrMutationPlanV2` because the artist
 * builder hard-codes artistId sort/dedupe; album plans sort and dedupe by
 * albumId. Seals via the engine's shared envelope/checksum helpers and the
 * exact `"rfmedia.lidarr-plan.v2"` version string.
 */
export function buildLidarrAlbumMutationPlanV2(
  input: BuildLidarrAlbumMutationPlanV2Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrAlbumMutationPlanV2 {
  const origin = canonicalizeLidarrPlanOrigin(input.origin);
  const maxBatch = requirePositiveInteger(input.maxBatch, "maxBatch", LIDARR_PLAN_MAX_BATCH);
  if (input.entries.length === 0) throw validationError("entries must not be empty");
  if (input.entries.length > maxBatch) {
    throw validationError(`entries exceed maxBatch (${input.entries.length} > ${maxBatch})`);
  }
  if (input.entries.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw validationError(`entries exceed the maximum of ${LIDARR_PLAN_MAX_ENTRIES}`);
  }
  const definition = getLidarrAlbumMutationOperationDefinition(input.operation);
  const operation = definition.canonicalize();
  const selection = canonicalizeLidarrAlbumPlanSelection(
    requireLidarrAlbumPlanSelection(input.selection),
  );
  const seen = new Set<number>();
  const entries = [...input.entries]
    .sort((left, right) => left.albumId - right.albumId)
    .map((source) => {
      const entry = definition.buildEntry(origin, source);
      if (seen.has(entry.albumId)) throw validationError(`duplicate album id ${entry.albumId}`);
      seen.add(entry.albumId);
      return entry;
    });
  const changed = entries.filter((entry) => definition.hasChange(entry)).length;
  const envelope = createLidarrPlanEnvelope(dependencies);
  const planWithoutSeal = {
    version: LIDARR_PLAN_VERSION_V2,
    id: envelope.id,
    createdAt: envelope.createdAt,
    createdBy: envelope.createdBy,
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
  } as LidarrAlbumMutationPlanV2;
  const plan: unknown = {
    ...planWithoutSeal,
    payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
  };
  assertLidarrAlbumMutationPlanV2(plan);
  return Object.freeze(plan);
}

/**
 * Builds the canonical v2 album facts, then seals those same facts into the
 * strict v3 envelope with deterministic cascade evidence.
 */
export function buildLidarrAlbumMutationPlanV3(
  input: BuildLidarrAlbumMutationPlanV3Input,
  dependencies: LidarrPlanBuildDependencies = {},
): LidarrAlbumMutationPlanV3 {
  const { cascadePolicy, ...legacyInput } = input;
  const legacy = buildLidarrAlbumMutationPlanV2(legacyInput, dependencies);
  const { version: _version, payloadChecksum: _payloadChecksum, ...seed } = legacy;
  return sealLidarrMutationPlanV3(seed, cascadePolicy);
}
