/** Applies one reviewed Lidarr mutation plan with drift and replay protection. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { closeDatabase, initializeDatabase } from "../../lib/db.js";
import { resolveOptionalScanAdapter } from "../../lib/adapters/action-helpers.js";
import { LidarrPlanStaleError, LidarrPlanValidationError } from "../../lib/errors.js";
import { logWarn } from "../../lib/logger.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrExecutionContext,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import {
  getLidarrAlbumMutationOperationDefinition,
  type LidarrAlbumMutationOperationDefinition,
} from "../../lib/lidarr/plan-album-operations.js";
import {
  acquireLidarrPlanClaim,
  appendLidarrPlanHistory,
  getLidarrMutationOperationDefinition,
  hasLidarrArtistAddPossibleDispatchEvidence,
  hasLidarrArtistDeletePossibleDispatchEvidence,
  readLidarrPlanArtifact,
  readLidarrPlanHistory,
  selectLidarrResumeEntries,
  type LidarrAlbumMonitoringOperationDefinition,
  type LidarrMutationOperationDefinitionV2,
  type LidarrStoredMutationPlan,
} from "../../lib/lidarr/plan-engine.js";
import {
  getGlobalSignal,
  registerGlobalCleanup,
  unregisterGlobalCleanup,
} from "../../lib/signal-handler.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type {
  LidarrAlbumMonitoringPlanEntry,
  LidarrAlbumMutationPlanEntryV2,
  LidarrAlbumMutationPlanV2,
  LidarrAlbumMutationPlanV3,
  LidarrApplyScanResult,
  LidarrArtistAddPlanV2,
  LidarrArtistAddPlanV3,
  LidarrCascadeAnalysisEvidence,
  LidarrArtistDeleteObservedState,
  LidarrArtistDeletePlanEntry,
  LidarrMutationPlan,
  LidarrMutationPlanEntry,
  LidarrMutationPlanEntryV2,
  LidarrPlanApplyFailure,
  LidarrPlanApplyEntryResult,
  LidarrPlanApplyResult,
  LidarrPlanHistoryOutcome,
  LidarrPlanHistoryRecord,
  LidarrPlanTerminalHistoryOutcome,
  LidarrPlanObservedState,
  LidarrPlanResourceReference,
  LidarrPlanStalenessFinding,
  LidarrPlanTagReference,
  LidarrTrackFileFilterPlanEntryV2,
  LidarrTrackFileFilterPlanV2,
  LidarrTrackFileFilterPlanV3,
} from "../../types/lidarr-plan.js";
import { LIDARR_PLAN_VERSION_V3 } from "../../types/lidarr-plan.js";
import type { LidarrAlbum, LidarrArtist, LidarrProfile } from "../../types/lidarr.js";
import type { DbConnection } from "../../types/db.js";
import { executeLidarrArtistAddApply } from "./apply-artist-add.js";
import {
  executeLidarrAlbumMutationApplyMutations,
  notAttemptedLidarrAlbumMutationResults,
} from "./apply-album-mutation-execution.js";
import {
  collectLidarrApplyResourceReferences,
  preflightLidarrApplyResources,
  type LidarrApplyResourceContext as ResourceContext,
} from "./apply-resources.js";
import { reconcileLidarrDeferredEntries } from "./apply-deferred-replay.js";
import { executeLidarrApplyEntry } from "./apply-entry-execution.js";
import {
  executeLidarrApplyMutations,
  type LidarrApplyExecutionSupport,
} from "./apply-target-execution.js";
import { executeLidarrTrackFilterApply } from "./apply-track-filter-execution.js";

export {
  LIDARR_APPLY_RECONCILIATION_ATTEMPTS,
  LIDARR_APPLY_RECONCILIATION_DELAY_MS,
} from "./apply-target-execution.js";

export const TIER: LidarrTier = "local-only";

export interface LidarrApplyActionOptions {
  readonly planPath: string;
  readonly expectedPlanId?: string;
  readonly expectedPlanChecksum?: string;
  readonly dryRun: boolean;
  readonly approved: boolean;
  /** Explicit authorization for destructive tag set/clear operations. */
  readonly allowTagReplacement?: boolean;
  /** Explicit authorization for every real artist deletion. */
  readonly allowArtistDelete?: boolean;
  /** Explicit authorization for any real album-delete apply. */
  readonly allowAlbumDelete?: boolean;
  /** Additional explicit authorization when Lidarr will delete managed files. */
  readonly allowFileDelete?: boolean;
  /** Requests one best-effort full media-server scan after a qualifying deletion. */
  readonly plexScan?: boolean;
  readonly resume?: boolean;
  readonly historyPath?: string;
  /** Test/embedding override for the exclusive-claim directory. */
  readonly claimDirectory?: string;
  /** Test/embedding override for the resilience SQLite database. */
  readonly databasePath?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}

type LidarrPlan = Exclude<LidarrStoredMutationPlan, LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3>;
type LidarrOperationDefinition =
  | LidarrAlbumMonitoringOperationDefinition
  | LidarrMutationOperationDefinitionV2
  | LidarrAlbumMutationOperationDefinition;
type AnyLidarrPlanEntry = LidarrMutationPlanEntry | LidarrMutationPlanEntryV2;
type AnyLidarrPlanEntryExtended =
  | AnyLidarrPlanEntry
  | LidarrAlbumMutationPlanEntryV2
  | LidarrTrackFileFilterPlanEntryV2;

function isArtistAddPlan(
  plan: LidarrStoredMutationPlan,
): plan is LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3 {
  return plan.operation.kind === "artist-add";
}

function cascadeAnalysisEvidence(plan: LidarrStoredMutationPlan): LidarrCascadeAnalysisEvidence {
  return plan.version === LIDARR_PLAN_VERSION_V3
    ? Object.freeze({ status: "recorded", analysis: plan.cascadeAnalysis })
    : Object.freeze({ status: "not-recorded" });
}

function withCascadeAnalysis(
  result: Omit<LidarrPlanApplyResult, "cascadeAnalysis">,
  evidence: LidarrCascadeAnalysisEvidence,
): LidarrPlanApplyResult {
  return Object.freeze({ ...result, cascadeAnalysis: evidence });
}

/**
 * Album FAMILY guard: v1 album-monitoring AND v2 album-mutation entries all
 * carry `albumId`, so callers that must distinguish them route on
 * `plan.operation.kind` FIRST and use the narrower guards below.
 */
function isAlbumEntry(
  entry: AnyLidarrPlanEntryExtended,
): entry is
  | LidarrAlbumMonitoringPlanEntry
  | LidarrAlbumMutationPlanEntryV2
  | LidarrTrackFileFilterPlanEntryV2 {
  return "albumId" in entry;
}

/** v1 album-monitoring entries are the only album shapes with `after.monitored`. */
function isAlbumMonitoringEntry(
  entry: AnyLidarrPlanEntryExtended,
): entry is LidarrAlbumMonitoringPlanEntry {
  return "albumId" in entry && "monitored" in entry.after;
}

function requireAlbumMutationEntry(
  entry: AnyLidarrPlanEntryExtended,
): LidarrAlbumMutationPlanEntryV2 {
  if (!isAlbumEntry(entry) || isAlbumMonitoringEntry(entry) || isTrackFilterEntry(entry)) {
    throw new Error("Album mutation plan contains an incompatible entry");
  }
  return entry;
}

function isTrackFilterEntry(
  entry: AnyLidarrPlanEntryExtended,
): entry is LidarrTrackFileFilterPlanEntryV2 {
  return "deletedTrackFileIds" in entry.after;
}

/** Narrows one entry to the artist/v1 lanes; album v2 entries never belong there. */
function requireArtistLaneEntry(entry: AnyLidarrPlanEntryExtended): AnyLidarrPlanEntry {
  if (!isAlbumEntry(entry) || isAlbumMonitoringEntry(entry)) return entry;
  throw new Error("Artist operation plan contains an album mutation entry");
}

function isAlbumMutationPlan(
  plan: LidarrPlan,
): plan is LidarrAlbumMutationPlanV2 | LidarrAlbumMutationPlanV3 {
  return plan.operation.kind === "album-edit" || plan.operation.kind === "album-delete";
}

function isTrackFilterPlan(
  plan: LidarrPlan,
): plan is LidarrTrackFileFilterPlanV2 | LidarrTrackFileFilterPlanV3 {
  return plan.operation.kind === "track-file-filter";
}

/** Kind-first definition guard; the album kinds own an album-typed contract. */
function isAlbumMutationDefinition(
  definition: LidarrOperationDefinition,
): definition is LidarrAlbumMutationOperationDefinition {
  return definition.kind === "album-edit" || definition.kind === "album-delete";
}

function requireAlbumMutationPlan(plan: LidarrPlan): LidarrAlbumMutationPlanV2 {
  if (!isAlbumMutationPlan(plan)) {
    throw new Error("Album mutation apply requires an album mutation plan");
  }
  return plan as unknown as LidarrAlbumMutationPlanV2;
}

function requireArtistLanePlan(plan: LidarrPlan): LidarrMutationPlan {
  if (isAlbumMutationPlan(plan) || isTrackFilterPlan(plan)) {
    throw new Error("Artist operation preflight received an album mutation plan");
  }
  return plan as unknown as LidarrMutationPlan;
}

function isArtistDeleteEntry(
  entry: AnyLidarrPlanEntryExtended,
): entry is LidarrArtistDeletePlanEntry {
  return !isAlbumEntry(entry) && "exists" in entry.after;
}

/** Narrows the operation kind before overload resolution to preserve definition correlation. */
function resolveApplyOperationDefinition(plan: LidarrPlan): LidarrOperationDefinition {
  const operation = plan.operation;
  if (operation.kind === "track-file-filter") {
    throw new Error("Track-file filters use their dedicated non-deferable apply lane");
  }
  // KIND-FIRST ROUTING: album v2 kinds resolve to the album-typed definitions.
  if (operation.kind === "album-edit" || operation.kind === "album-delete") {
    return getLidarrAlbumMutationOperationDefinition(operation);
  }
  if (operation.kind === "album-monitoring") {
    return getLidarrMutationOperationDefinition(operation);
  }
  return getLidarrMutationOperationDefinition(operation);
}

const EMPTY_RESOURCE_CONTEXT: ResourceContext = Object.freeze({
  rootFolders: new Map(),
  qualityProfiles: new Map(),
  metadataProfiles: new Map(),
  tags: new Map(),
  warnings: Object.freeze([]),
});

interface PersistedOutcome {
  readonly result: LidarrPlanApplyEntryResult;
  readonly durable: boolean;
}

function buildFailure(
  plan: LidarrPlan,
  definition: LidarrOperationDefinition,
  entry: AnyLidarrPlanEntry,
  input: Omit<LidarrPlanApplyFailure, "operation" | "planId" | "planChecksum" | "targetIds">,
): LidarrPlanApplyFailure {
  if (definition.kind === "album-monitoring") {
    throw new Error("Album monitoring does not emit structured v2 failure evidence");
  }
  return Object.freeze({
    ...input,
    operation: definition.kind,
    planId: plan.id,
    planChecksum: plan.payloadChecksum,
    targetIds: Object.freeze([isAlbumEntry(entry) ? entry.albumId : entry.artistId]),
  });
}

function mergeMessage(warnings: readonly string[], message?: string): string | undefined {
  const parts = [...warnings, ...(message === undefined ? [] : [message])];
  return parts.length === 0 ? undefined : parts.join("; ");
}

function resolveTagReference(
  id: number,
  entry: AnyLidarrPlanEntry,
  resources: ResourceContext,
): LidarrPlanTagReference {
  const live = resources.tags.get(id);
  if (live !== undefined) return { id, label: live.label };
  if ("tags" in entry.before && "tags" in entry.after) {
    const planned = [...entry.before.tags, ...entry.after.tags].find((tag) => tag.id === id);
    if (planned !== undefined) return planned;
  }
  return { id, label: `Tag ${id}` };
}

function resolveProfileReference(
  reference: LidarrPlanResourceReference | undefined,
  profiles: ReadonlyMap<number, LidarrProfile>,
): LidarrPlanResourceReference | undefined {
  if (reference === undefined) return undefined;
  const live = profiles.get(reference.id);
  return live === undefined ? reference : { id: live.id, name: live.name };
}

function plannedState(
  entry: AnyLidarrPlanEntry,
  side: "before" | "after",
  resources: ResourceContext,
): LidarrPlanObservedState {
  if (isArtistDeleteEntry(entry)) {
    return side === "before"
      ? { kind: "artist-delete", exists: true, evidence: entry.before }
      : { kind: "artist-delete", exists: false };
  }
  const state = entry[side];
  if ("monitored" in state) {
    return { kind: "artist-monitoring", monitored: state.monitored };
  }
  if ("tags" in state) {
    return {
      kind: "artist-tag-mutation",
      tags: state.tags.map((tag) => resolveTagReference(tag.id, entry, resources)),
    };
  }
  const qualityProfile = resolveProfileReference(state.qualityProfile, resources.qualityProfiles);
  const metadataProfile = resolveProfileReference(
    state.metadataProfile,
    resources.metadataProfiles,
  );
  return {
    kind: "artist-profile-assignment",
    ...(qualityProfile === undefined ? {} : { qualityProfile }),
    ...(metadataProfile === undefined ? {} : { metadataProfile }),
  };
}

function observedState(
  entry: AnyLidarrPlanEntry,
  artist: LidarrArtist,
  definition: LidarrOperationDefinition,
  resources: ResourceContext,
): LidarrPlanObservedState {
  switch (definition.kind) {
    case "album-monitoring":
      throw new Error("Album monitoring does not emit structured v2 observed state");
    case "album-edit":
    case "album-delete":
      throw new Error("Album mutations do not observe artist state");
    case "artist-monitoring":
      return { kind: definition.kind, monitored: artist.monitored };
    case "artist-profile-assignment": {
      const operation = definition.operation;
      if (operation.kind !== definition.kind) {
        throw new Error("Profile operation definition is internally inconsistent");
      }
      const qualityProfile =
        operation.qualityProfile === undefined
          ? undefined
          : resolveProfileReference(
              {
                id: artist.qualityProfileId,
                name: operation.qualityProfile.name,
              },
              resources.qualityProfiles,
            );
      const metadataProfile =
        operation.metadataProfile === undefined
          ? undefined
          : resolveProfileReference(
              {
                id: artist.metadataProfileId,
                name: operation.metadataProfile.name,
              },
              resources.metadataProfiles,
            );
      return {
        kind: definition.kind,
        ...(qualityProfile === undefined ? {} : { qualityProfile }),
        ...(metadataProfile === undefined ? {} : { metadataProfile }),
      };
    }
    case "artist-tag-mutation":
      return {
        kind: definition.kind,
        tags: artist.tags.map((id) => resolveTagReference(id, entry, resources)),
      };
    case "artist-delete":
      return observedArtistDeleteState(artist);
  }
}

function observedArtistDeleteState(
  artist: LidarrArtist,
): Extract<LidarrArtistDeleteObservedState, { readonly exists: true }> {
  if (artist.path === undefined || artist.statistics === undefined) {
    throw new Error(`Artist ${artist.id} has incomplete deletion evidence`);
  }
  return {
    kind: "artist-delete",
    exists: true,
    evidence: {
      path: artist.path,
      albumCount: artist.statistics.albumCount,
      trackFileCount: artist.statistics.trackFileCount,
      sizeOnDisk: artist.statistics.sizeOnDisk,
    },
  };
}

function staleEntryResult(
  plan: LidarrPlan,
  definition: LidarrOperationDefinition,
  entry: AnyLidarrPlanEntry,
  error: LidarrPlanStaleError,
  resources: ResourceContext,
  observed?: LidarrPlanObservedState,
): LidarrPlanApplyEntryResult {
  const finding = error.findings.find((candidate) => candidate.entryId === entry.id);
  if (isAlbumEntry(entry)) {
    return entryResult(
      entry,
      "blocked-stale",
      finding?.code ?? "plan-stale",
      finding?.message ?? error.message,
    );
  }
  const failureCode =
    finding?.code === "album-missing" || finding?.code === "album-state-drift"
      ? "plan-stale"
      : (finding?.code ?? "plan-stale");
  return entryResult(
    entry,
    "blocked-stale",
    finding?.code ?? "plan-stale",
    finding?.message ?? error.message,
    {
      before: plannedState(entry, "before", resources),
      after: plannedState(entry, "after", resources),
      observed,
      warnings: resources.warnings,
      failure: buildFailure(plan, definition, entry, {
        code: failureCode,
        stage: "admission",
        dispatchState: "not-dispatched",
        verificationState: "not-started",
        retryable: false,
        safeNextAction: "review-staleness-and-replan",
      }),
    },
  );
}

function notAttemptedResults(
  plan: LidarrPlan,
  definition: LidarrOperationDefinition,
  entries: readonly AnyLidarrPlanEntry[],
  resources: ResourceContext,
  safeNextAction: LidarrPlanApplyFailure["safeNextAction"] = "resume-plan",
): LidarrPlanApplyEntryResult[] {
  return entries.map((entry) =>
    isAlbumEntry(entry)
      ? entryResult(
          entry,
          "not-attempted",
          "admission-stopped",
          "Not attempted after apply stopped",
        )
      : entryResult(
          entry,
          "not-attempted",
          "admission-stopped",
          "Not attempted after apply stopped",
          {
            before: plannedState(entry, "before", resources),
            after: plannedState(entry, "after", resources),
            warnings: resources.warnings,
            failure: buildFailure(plan, definition, entry, {
              code: "admission-stopped",
              stage: "admission",
              dispatchState: "not-dispatched",
              verificationState: "not-started",
              retryable: true,
              safeNextAction,
            }),
          },
        ),
  );
}

function historyRecord(
  plan: LidarrPlan,
  entry: AnyLidarrPlanEntry,
  outcome: LidarrPlanTerminalHistoryOutcome,
  errorCode?: string,
  message?: string,
): LidarrPlanHistoryRecord {
  if (isAlbumEntry(entry)) {
    return {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      albumId: entry.albumId,
      artistId: entry.artistId,
      recordedAt: new Date().toISOString(),
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(message === undefined ? {} : { message }),
    };
  }
  return {
    planId: plan.id,
    planChecksum: plan.payloadChecksum,
    entryId: entry.id,
    artistId: entry.artistId,
    recordedAt: new Date().toISOString(),
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(message === undefined ? {} : { message }),
  };
}

function requireTerminalHistoryOutcome(
  outcome: LidarrPlanHistoryOutcome,
): LidarrPlanTerminalHistoryOutcome {
  switch (outcome) {
    case "succeeded":
    case "satisfied":
    case "failed":
    case "deferred":
    case "uncertain":
      return outcome;
    case "possibly-dispatched":
    case "creation-verified-normalization-pending":
    case "normalization-verification-pending":
      throw new Error("Intermediate evidence requires its dedicated history writer");
  }
}

function entryResult(
  entry: AnyLidarrPlanEntryExtended,
  outcome: LidarrPlanApplyEntryResult["outcome"],
  errorCode?: string,
  message?: string,
  evidence: {
    readonly artistName?: string;
    readonly before?: LidarrPlanObservedState;
    readonly after?: LidarrPlanObservedState;
    readonly observed?: LidarrPlanObservedState;
    readonly warnings?: readonly string[];
    readonly failure?: LidarrPlanApplyFailure;
  } = {},
): LidarrPlanApplyEntryResult {
  if (isAlbumEntry(entry)) {
    return {
      entryId: entry.id,
      albumId: entry.albumId,
      albumTitle: entry.albumTitle,
      artistId: entry.artistId,
      artistName: entry.artistName,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(message === undefined ? {} : { message }),
    };
  }
  return {
    entryId: entry.id,
    artistId: entry.artistId,
    artistName: evidence.artistName ?? entry.artistName,
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(mergeMessage(evidence.warnings ?? [], message) === undefined
      ? {}
      : { message: mergeMessage(evidence.warnings ?? [], message) }),
    ...(evidence.before === undefined ? {} : { before: evidence.before }),
    ...(evidence.after === undefined ? {} : { after: evidence.after }),
    ...(evidence.observed === undefined ? {} : { observed: evidence.observed }),
    ...(evidence.failure === undefined ? {} : { failure: evidence.failure }),
  };
}

function staleFinding(
  entry: AnyLidarrPlanEntry,
  code: LidarrPlanStalenessFinding["code"],
  message?: string,
): LidarrPlanStalenessFinding {
  if (isAlbumEntry(entry)) {
    const reason = code === "album-missing" ? "missing" : "drift";
    return getLidarrMutationOperationDefinition({
      kind: "album-monitoring",
      desiredMonitored: entry.after.monitored,
      selectors: [],
    }).staleFinding(entry, reason);
  }
  return {
    code,
    entryId: entry.id,
    artistId: entry.artistId,
    message:
      message ??
      (code === "artist-missing"
        ? `Artist ${entry.artistId} no longer exists`
        : `Artist ${entry.artistId} managed state changed after planning`),
  };
}

/**
 * Selects entries not durably succeeded or satisfied. Album mutation plans are
 * outside `selectLidarrResumeEntries`'s declared overloads, so the identical
 * latest-outcome filter is applied to them here (kind-first, never by shape).
 */
function selectApplyResumeEntries(
  plan: LidarrPlan,
  history: readonly LidarrPlanHistoryRecord[],
): AnyLidarrPlanEntryExtended[] {
  if (isAlbumMutationPlan(plan) || isTrackFilterPlan(plan)) {
    const latest = new Map<string, LidarrPlanHistoryOutcome>();
    for (const record of history) {
      if (record.planId === plan.id && record.planChecksum === plan.payloadChecksum) {
        latest.set(record.entryId, record.outcome);
      }
    }
    return plan.entries.filter((entry) => {
      const outcome = latest.get(entry.id);
      return outcome !== "succeeded" && outcome !== "satisfied";
    });
  }
  return selectLidarrResumeEntries(
    plan as unknown as LidarrMutationPlan,
    history,
  ) as AnyLidarrPlanEntryExtended[];
}

async function runApplyRead<T>(
  id: string,
  operation: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ readonly value: T; readonly execution: LidarrExecutionMetadata }> {
  return resolveLidarrScheduler().runSingle(
    TIER,
    { id, operation, idempotent: true, run },
    { signal },
  );
}

async function preflightPlan(args: {
  readonly plan: LidarrPlan;
  readonly planPath: string;
  readonly pending: readonly AnyLidarrPlanEntryExtended[];
  readonly client: LidarrClientApi;
  readonly definition: LidarrOperationDefinition;
  readonly attributableAbsenceEntryIds: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly resources: ResourceContext;
  readonly artists: ReadonlyMap<number, LidarrArtist>;
  readonly albumStates: ReadonlyMap<string, { readonly monitored: boolean }>;
  readonly albumMutationStates: ReadonlyMap<string, LidarrAlbum>;
  readonly execution: LidarrExecutionMetadata;
}> {
  const findings: LidarrPlanStalenessFinding[] = [];
  const representative = args.pending[0] ?? args.plan.entries[0];
  if (representative === undefined) {
    throw new LidarrPlanValidationError("plan has no entries", args.planPath);
  }
  // KIND-FIRST ROUTING: album v2 entries also satisfy the `"albumId" in entry`
  // shape guard used by the v1 album-monitoring branch below, so the album
  // mutation kinds must dispatch before any structural narrowing.
  if (isAlbumMutationDefinition(args.definition)) {
    const albumDefinition = args.definition;
    const albumEntries = args.pending.map(requireAlbumMutationEntry);
    const read = await runApplyRead(
      `lidarr-apply-read-${args.plan.id}`,
      "lidarr apply preflight",
      () => albumDefinition.loadCurrentStates(args.client, albumEntries, args.signal),
      args.signal,
    );
    for (const entry of albumEntries) {
      const current = read.value.get(albumDefinition.entryId(entry));
      // Absent album == "satisfied" for DELETE ONLY (classify handles it);
      // absent for edit and present-with-drift classify "drifted" fail-closed.
      if (albumDefinition.classify(entry, current) === "drifted") {
        findings.push(
          albumDefinition.staleFinding(entry, current === undefined ? "missing" : "drift"),
        );
      }
    }
    if (findings.length > 0) throw new LidarrPlanStaleError(findings, args.planPath);
    return {
      resources: EMPTY_RESOURCE_CONTEXT,
      artists: new Map(),
      albumStates: new Map(),
      albumMutationStates: read.value,
      execution: read.execution,
    };
  }
  if (args.definition.kind === "album-monitoring") {
    const albumDefinition = args.definition;
    const albumEntries: LidarrAlbumMonitoringPlanEntry[] = [];
    for (const entry of args.pending) {
      if (!isAlbumMonitoringEntry(entry)) {
        throw new LidarrPlanValidationError(
          "album-monitoring plan contains a non-album entry",
          args.planPath,
        );
      }
      albumEntries.push(entry);
    }
    const read = await runApplyRead(
      `lidarr-apply-read-${args.plan.id}`,
      "lidarr apply preflight",
      () => albumDefinition.loadCurrentStates(args.client, albumEntries, args.signal),
      args.signal,
    );
    for (const entry of albumEntries) {
      const current = read.value.get(albumDefinition.entryId(entry));
      if (current === undefined) {
        findings.push(albumDefinition.staleFinding(entry, "missing"));
      } else if (albumDefinition.classify(entry, current) === "drifted") {
        findings.push(albumDefinition.staleFinding(entry, "drift"));
      }
    }
    if (findings.length > 0) throw new LidarrPlanStaleError(findings, args.planPath);
    return {
      resources: EMPTY_RESOURCE_CONTEXT,
      artists: new Map(),
      albumStates: read.value,
      albumMutationStates: new Map(),
      execution: read.execution,
    };
  }

  const artistRepresentative = requireArtistLaneEntry(representative);
  const references = collectLidarrApplyResourceReferences(
    requireArtistLanePlan(args.plan),
    args.definition.referencedResources(),
  );
  const resourcePreflight = await preflightLidarrApplyResources({
    planId: args.plan.id,
    references,
    client: args.client,
    signal: args.signal,
  });
  for (const reference of resourcePreflight.missing) {
    const plannedName =
      reference.kind === "tag"
        ? reference.label
        : reference.kind === "root-folder"
          ? reference.path
          : reference.name;
    findings.push(
      staleFinding(
        artistRepresentative,
        "resource-missing",
        `${reference.kind} ${reference.id} (${plannedName}) no longer exists`,
      ),
    );
  }

  const artistRead = await runApplyRead(
    `lidarr-apply-read-${args.plan.id}`,
    "lidarr apply artist preflight",
    () => args.client.listArtists(args.signal),
    args.signal,
  );
  const artists = new Map(artistRead.value.map((artist) => [artist.id, artist]));
  for (const pendingEntry of args.pending) {
    const entry = requireArtistLaneEntry(pendingEntry);
    const artist = artists.get(entry.artistId);
    if (artist === undefined) {
      if (!args.attributableAbsenceEntryIds.has(entry.id)) {
        findings.push(staleFinding(entry, "artist-missing"));
      }
      continue;
    }
    let current: LidarrArtist | LidarrArtistDeleteObservedState = artist;
    if (args.definition.kind === "artist-delete" && isArtistDeleteEntry(entry)) {
      try {
        current = observedArtistDeleteState(artist);
      } catch {
        findings.push(
          staleFinding(
            entry,
            "artist-state-drift",
            `Artist ${entry.artistId} deletion evidence changed after planning`,
          ),
        );
        continue;
      }
    }
    const classification = args.definition.classifyLive(entry, current);
    if (classification.state === "drifted") {
      findings.push(staleFinding(entry, "artist-state-drift", classification.message));
    }
  }
  if (findings.length > 0) throw new LidarrPlanStaleError(findings, args.planPath);
  resourcePreflight.resources.warnings.forEach((warning) => logWarn(warning));
  return {
    resources: resourcePreflight.resources,
    artists,
    albumStates: new Map(),
    albumMutationStates: new Map(),
    execution: artistRead.execution,
  };
}

async function persistOutcome(
  plan: LidarrPlan,
  entry: AnyLidarrPlanEntry,
  outcome: LidarrPlanHistoryOutcome,
  historyPath: string | undefined,
  definition: LidarrOperationDefinition,
  resources: ResourceContext,
  errorCode?: string,
  message?: string,
  remoteSucceeded = false,
  assertOwned?: () => Promise<void>,
  evidence: {
    readonly artistName?: string;
    readonly observed?: LidarrPlanObservedState;
    readonly failure?: LidarrPlanApplyFailure;
  } = {},
): Promise<PersistedOutcome> {
  const terminalOutcome = requireTerminalHistoryOutcome(outcome);
  const resultEvidence = {
    artistName: evidence.artistName,
    before: plannedState(entry, "before", resources),
    after: plannedState(entry, "after", resources),
    observed: evidence.observed,
    warnings: resources.warnings,
    failure: evidence.failure,
  } as const;
  try {
    await assertOwned?.();
    await appendLidarrPlanHistory(
      historyRecord(plan, entry, terminalOutcome, errorCode, message),
      historyPath,
    );
    return {
      result: entryResult(entry, terminalOutcome, errorCode, message, resultEvidence),
      durable: true,
    };
  } catch (error) {
    if (!remoteSucceeded) throw error;
    if (isAlbumEntry(entry)) {
      return {
        result: entryResult(
          entry,
          "uncertain",
          "history-write-failed",
          "Remote mutation succeeded but durable history failed; resume is required",
        ),
        durable: false,
      };
    }
    return {
      result: entryResult(
        entry,
        "uncertain",
        "history-write-failed",
        "Remote mutation succeeded but durable history failed; resume is required",
        {
          ...resultEvidence,
          failure: buildFailure(plan, definition, entry, {
            code: "history-write-failed",
            stage: "history",
            dispatchState: "dispatched",
            verificationState: "verified",
            retryable: true,
            safeNextAction: "resume-plan",
          }),
        },
      ),
      durable: false,
    };
  }
}

async function persistPossibleDispatch(
  plan: LidarrPlan,
  entry: LidarrArtistDeletePlanEntry,
  historyPath: string | undefined,
  assertOwned: () => Promise<void>,
): Promise<void> {
  await assertOwned();
  await appendLidarrPlanHistory(
    {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      artistId: entry.artistId,
      recordedAt: new Date().toISOString(),
      outcome: "possibly-dispatched",
      idempotencyKey: entry.idempotencyKey,
    },
    historyPath,
  );
  await assertOwned();
}

const executionSupport: LidarrApplyExecutionSupport = Object.freeze({
  observedState,
  staleFinding,
  staleEntryResult,
  notAttemptedResults,
  buildFailure,
  persistOutcome,
  persistPossibleDispatch,
});

async function resolveApplyScan(
  requested: boolean | undefined,
  eligible: boolean,
  dryRun: boolean,
): Promise<LidarrApplyScanResult | undefined> {
  if (requested !== true) return undefined;
  if (dryRun) {
    return {
      requested: true,
      attempted: false,
      status: "skipped",
      message: "Dry-run does not trigger a media-server scan",
    };
  }
  if (!eligible) {
    return {
      requested: true,
      attempted: false,
      status: "skipped",
      message: "No newly succeeded file deletion had non-zero reviewed file impact",
    };
  }
  const { adapter } = resolveOptionalScanAdapter({ plexScan: true });
  if (adapter === undefined || !adapter.capabilities.scan) {
    return {
      requested: true,
      attempted: false,
      status: "unavailable",
      message: "Media-server scan capability is unavailable",
    };
  }
  try {
    const scan = await adapter.scan.trigger();
    return {
      requested: true,
      attempted: true,
      status: scan.success ? "succeeded" : "failed",
      message: scan.message,
    };
  } catch (error) {
    return {
      requested: true,
      attempted: true,
      status: "failed",
      message: error instanceof Error ? error.message : "Media-server scan failed",
    };
  }
}

function hasQualifyingDeleteSuccess(
  plan: LidarrPlan,
  entries: readonly LidarrPlanApplyEntryResult[],
): boolean {
  if (plan.operation.kind !== "artist-delete" || !plan.operation.deleteFiles) return false;
  const succeeded = new Set(
    entries.filter((entry) => entry.outcome === "succeeded").map((entry) => entry.entryId),
  );
  return plan.entries.some(
    (entry) =>
      isArtistDeleteEntry(entry) &&
      succeeded.has(entry.id) &&
      (entry.before.trackFileCount > 0 || entry.before.sizeOnDisk > 0),
  );
}

function summarize(total: number, entries: readonly LidarrPlanApplyEntryResult[]) {
  return {
    total,
    succeeded: entries.filter((entry) => entry.outcome === "succeeded").length,
    satisfied: entries.filter((entry) => entry.outcome === "satisfied").length,
    failed: entries.filter((entry) => entry.outcome === "failed").length,
    deferred: entries.filter((entry) => entry.outcome === "deferred").length,
    uncertain: entries.filter((entry) => entry.outcome === "uncertain").length,
    blockedStale: entries.filter((entry) => entry.outcome === "blocked-stale").length,
    notAttempted: entries.filter((entry) => entry.outcome === "not-attempted").length,
    skippedResume: entries.filter((entry) => entry.outcome === "skipped-resume").length,
    wouldApply: entries.filter((entry) => entry.outcome === "would-apply").length,
  };
}

function resultStatus(
  dryRun: boolean,
  entries: readonly LidarrPlanApplyEntryResult[],
): LidarrPlanApplyResult["status"] {
  if (dryRun) return "checked";
  const failed = entries.filter((entry) =>
    ["failed", "deferred", "uncertain", "blocked-stale", "not-attempted"].includes(entry.outcome),
  ).length;
  if (failed === 0) return "completed";
  return failed === entries.length ? "failed" : "partial";
}

/** Sorts results by the reviewed target identity for the operation kind. */
function sortEntryResults(
  plan: LidarrPlan,
  definition: LidarrOperationDefinition,
  entries: LidarrPlanApplyEntryResult[],
): void {
  // KIND-FIRST ROUTING: album v2 entries also satisfy the album shape guard.
  if (isAlbumMutationDefinition(definition)) {
    const albumDefinition = definition;
    const sortKeys = new Map(
      plan.entries.map((entry) => {
        const albumEntry = requireAlbumMutationEntry(entry);
        return [albumEntry.id, albumDefinition.resultSortKey(albumEntry)] as const;
      }),
    );
    entries.sort(
      (left, right) => (sortKeys.get(left.entryId) ?? 0) - (sortKeys.get(right.entryId) ?? 0),
    );
    return;
  }
  if (definition.kind === "album-monitoring") {
    const sortKeys = new Map(
      plan.entries.map((entry) => {
        if (!isAlbumMonitoringEntry(entry)) {
          throw new LidarrPlanValidationError("album-monitoring plan contains a non-album entry");
        }
        return [entry.id, definition.resultSortKey(entry)] as const;
      }),
    );
    entries.sort(
      (left, right) => (sortKeys.get(left.entryId) ?? 0) - (sortKeys.get(right.entryId) ?? 0),
    );
    return;
  }
  entries.sort((left, right) => {
    if (!("artistId" in left) || !("artistId" in right)) {
      throw new Error("Numeric artist operation produced a foreign-ID result");
    }
    return left.artistId - right.artistId;
  });
}

/** Validates live state, then applies exact reviewed mutations one at a time. */
export async function executeLidarrApply(
  options: LidarrApplyActionOptions,
): Promise<LidarrPlanApplyResult> {
  if (!options.dryRun && !options.approved) {
    throw new LidarrPlanValidationError("real apply requires explicit approval", options.planPath);
  }
  const planPath = resolve(options.planPath);
  const plan = await readLidarrPlanArtifact(planPath);
  const cascadeEvidence = cascadeAnalysisEvidence(plan);
  if (options.expectedPlanId !== undefined && options.expectedPlanId !== plan.id) {
    throw new LidarrPlanValidationError(
      `plan id mismatch (${plan.id} != ${options.expectedPlanId})`,
      planPath,
    );
  }
  if (
    options.expectedPlanChecksum !== undefined &&
    options.expectedPlanChecksum !== plan.payloadChecksum
  ) {
    throw new LidarrPlanValidationError(
      `plan checksum mismatch (${plan.payloadChecksum} != ${options.expectedPlanChecksum})`,
      planPath,
    );
  }
  if (
    !options.dryRun &&
    plan.operation.kind === "artist-delete" &&
    options.allowArtistDelete !== true
  ) {
    throw new LidarrPlanValidationError(
      "real artist deletion requires explicit --allow-artist-delete authorization",
      planPath,
    );
  }
  if (
    !options.dryRun &&
    plan.operation.kind === "artist-delete" &&
    plan.operation.deleteFiles &&
    options.allowFileDelete !== true
  ) {
    throw new LidarrPlanValidationError(
      "file-deleting artist plans also require explicit --allow-file-delete authorization",
      planPath,
    );
  }
  if (
    !options.dryRun &&
    plan.operation.kind === "artist-tag-mutation" &&
    (plan.operation.mode === "set" || plan.operation.mode === "clear") &&
    options.allowTagReplacement !== true
  ) {
    throw new LidarrPlanValidationError(
      "real tag replacement apply requires explicit authorization",
      planPath,
    );
  }
  // Fail-closed AUTHORIZATION (distinct from --yes approval): any real
  // album-delete apply needs --allow-album-delete, and a sealed
  // deleteFiles=true plan ADDITIONALLY needs --allow-file-delete. The
  // destruction mode was decided at plan time and is never re-decidable here.
  if (!options.dryRun && plan.operation.kind === "album-delete") {
    if (options.allowAlbumDelete !== true) {
      throw new LidarrPlanValidationError(
        "real album deletion apply requires explicit authorization",
        planPath,
      );
    }
    if (plan.operation.deleteFiles && options.allowFileDelete !== true) {
      throw new LidarrPlanValidationError(
        "real file deletion apply requires explicit authorization",
        planPath,
      );
    }
  }
  if (
    !options.dryRun &&
    plan.operation.kind === "track-file-filter" &&
    options.allowFileDelete !== true
  ) {
    throw new LidarrPlanValidationError(
      "real trackfile deletion requires explicit --allow-file-delete authorization",
      planPath,
    );
  }
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  if (plan.target.origin !== origin) {
    throw new LidarrPlanValidationError(
      `target origin mismatch (${plan.target.origin} != ${origin})`,
      planPath,
    );
  }

  const localAbortController = new AbortController();
  const globalSignal = getGlobalSignal();
  const forwardGlobalAbort = () => localAbortController.abort(globalSignal.reason);
  const forwardCallerAbort = () => localAbortController.abort(options.signal?.reason);
  if (globalSignal.aborted) forwardGlobalAbort();
  else globalSignal.addEventListener("abort", forwardGlobalAbort, { once: true });
  if (options.signal?.aborted === true) forwardCallerAbort();
  else options.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const signal = localAbortController.signal;

  const cleanupHandlerName = `lidarr-apply-${plan.id}-${randomUUID()}`;
  let resolveActionSettled: (() => void) | undefined;
  const actionSettled = new Promise<void>((resolve) => {
    resolveActionSettled = resolve;
  });
  let claim: Awaited<ReturnType<typeof acquireLidarrPlanClaim>> | undefined;
  let cleanupRegistered = false;
  try {
    signal.throwIfAborted();
    if (isArtistAddPlan(plan)) {
      const context = resolveRequiredLidarrExecutionContext(overrides, {
        tier: "metadata-dependent",
        retryAttemptsOverride: 0,
      });
      return withCascadeAnalysis(
        await executeLidarrArtistAddApply({
          plan,
          planPath,
          context,
          dryRun: options.dryRun,
          resumed: options.resume === true,
          historyPath: options.historyPath,
          signal,
          activateClaim: async () => {
            registerGlobalCleanup({
              priority: 10,
              name: cleanupHandlerName,
              cleanup: async () => {
                if (!signal.aborted) localAbortController.abort();
                await actionSettled;
              },
            });
            cleanupRegistered = true;
            claim = await acquireLidarrPlanClaim(plan.id, {
              claimDirectory: options.claimDirectory,
            });
            return () => {
              if (claim === undefined) {
                throw new LidarrPlanValidationError(
                  "real apply requires an exclusive claim",
                  planPath,
                );
              }
              return claim.assertOwned();
            };
          },
          resolveScan: (dryRun) => resolveApplyScan(options.plexScan, false, dryRun),
        }),
        cascadeEvidence,
      );
    }
    if (isTrackFilterPlan(plan)) {
      const client = resolveRequiredLidarrClient(overrides, {
        tier: TIER,
        retryAttemptsOverride: 0,
      });
      return withCascadeAnalysis(
        await executeLidarrTrackFilterApply({
          plan: plan as unknown as LidarrTrackFileFilterPlanV2,
          planPath,
          client,
          options: {
            dryRun: options.dryRun,
            resume: options.resume,
            historyPath: options.historyPath,
            claimDirectory: options.claimDirectory,
            signal,
          },
        }),
        cascadeEvidence,
      );
    }
    const definition = resolveApplyOperationDefinition(plan);
    const history = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, options.historyPath);
    if (history.length > 0 && options.resume !== true) {
      throw new LidarrPlanValidationError(
        "this plan has prior history; use --resume to continue safely",
        planPath,
      );
    }
    const pending: AnyLidarrPlanEntryExtended[] =
      options.resume === true ? selectApplyResumeEntries(plan, history) : [...plan.entries];
    const attributableAbsenceEntryIds = new Set<string>();
    if (
      options.resume === true &&
      !isAlbumMutationPlan(plan) &&
      "selection" in plan &&
      plan.operation.kind === "artist-delete"
    ) {
      for (const entry of pending) {
        if (
          !isAlbumEntry(entry) &&
          hasLidarrArtistDeletePossibleDispatchEvidence(plan, entry, history)
        ) {
          attributableAbsenceEntryIds.add(entry.id);
        }
      }
    }
    const pendingIds = new Set(pending.map((entry) => entry.id));
    const client = resolveRequiredLidarrClient(overrides, {
      tier: TIER,
      retryAttemptsOverride: 0,
    });
    const preflight = await preflightPlan({
      plan,
      planPath,
      pending,
      client,
      definition,
      attributableAbsenceEntryIds,
      signal,
    });
    const executable: AnyLidarrPlanEntryExtended[] = [];
    const satisfied: AnyLidarrPlanEntryExtended[] = [];
    // KIND-FIRST ROUTING: album v2 entries also satisfy the `"albumId" in
    // entry` shape guard, so the album mutation kinds classify before any
    // structural narrowing can misroute them into the v1 album path.
    if (isAlbumMutationDefinition(definition)) {
      for (const entry of pending) {
        const albumEntry = requireAlbumMutationEntry(entry);
        const current = preflight.albumMutationStates.get(definition.entryId(albumEntry));
        switch (definition.classify(albumEntry, current)) {
          case "satisfied":
            satisfied.push(albumEntry);
            break;
          case "ready":
            executable.push(albumEntry);
            break;
          case "drifted":
            throw new Error("Preflight returned a drifted album");
        }
      }
    } else {
      for (const entry of pending) {
        if (isAlbumEntry(entry)) {
          if (definition.kind !== "album-monitoring") {
            throw new Error("Artist operation plan contains an album entry");
          }
          if (!isAlbumMonitoringEntry(entry)) {
            throw new Error("Album monitoring plan contains an album mutation entry");
          }
          const current = preflight.albumStates.get(definition.entryId(entry));
          if (current === undefined) throw new Error("Preflight omitted a validated album");
          switch (definition.classify(entry, current)) {
            case "satisfied":
              satisfied.push(entry);
              break;
            case "ready":
              executable.push(entry);
              break;
            case "drifted":
              throw new Error("Preflight returned a drifted album");
          }
          continue;
        }
        if (definition.kind === "album-monitoring") {
          throw new Error("Album operation plan contains an artist entry");
        }
        const artist = preflight.artists.get(entry.artistId);
        if (artist === undefined) {
          if (attributableAbsenceEntryIds.has(entry.id)) {
            satisfied.push(entry);
            continue;
          }
          throw new Error("Preflight omitted a validated artist");
        }
        const current =
          definition.kind === "artist-delete" && isArtistDeleteEntry(entry)
            ? observedArtistDeleteState(artist)
            : artist;
        switch (definition.classify(entry, current)) {
          case "satisfied":
            satisfied.push(entry);
            break;
          case "ready":
            executable.push(entry);
            break;
          case "drifted":
            throw new Error("Preflight returned a drifted artist");
        }
      }
    }

    const entries: LidarrPlanApplyEntryResult[] = plan.entries
      .filter((entry: AnyLidarrPlanEntryExtended) => !pendingIds.has(entry.id))
      .map((entry: AnyLidarrPlanEntryExtended) =>
        isAlbumEntry(entry)
          ? entryResult(entry, "skipped-resume")
          : entryResult(entry, "skipped-resume", undefined, undefined, {
              before: plannedState(entry, "before", preflight.resources),
              after: plannedState(entry, "after", preflight.resources),
              warnings: preflight.resources.warnings,
            }),
      );
    if (options.dryRun) {
      entries.push(
        ...satisfied.map((entry) => {
          if (isAlbumEntry(entry)) {
            return entryResult(entry, "satisfied");
          }
          const artist = preflight.artists.get(entry.artistId);
          if (artist === undefined && attributableAbsenceEntryIds.has(entry.id)) {
            return entryResult(entry, "satisfied", undefined, undefined, {
              before: plannedState(entry, "before", preflight.resources),
              after: plannedState(entry, "after", preflight.resources),
              observed: { kind: "artist-delete", exists: false },
              warnings: preflight.resources.warnings,
            });
          }
          if (artist === undefined) throw new Error("Preflight omitted a satisfied artist");
          return entryResult(entry, "satisfied", undefined, undefined, {
            artistName: artist.artistName,
            before: plannedState(entry, "before", preflight.resources),
            after: plannedState(entry, "after", preflight.resources),
            observed: observedState(entry, artist, definition, preflight.resources),
            warnings: preflight.resources.warnings,
          });
        }),
        ...executable.map((entry) => {
          if (isAlbumEntry(entry)) {
            return entryResult(entry, "would-apply");
          }
          const artist = preflight.artists.get(entry.artistId);
          if (artist === undefined) throw new Error("Preflight omitted an executable artist");
          if (
            definition.kind === "artist-delete" &&
            isArtistDeleteEntry(entry) &&
            attributableAbsenceEntryIds.has(entry.id)
          ) {
            return entryResult(
              entry,
              "uncertain",
              "possible-dispatch-pending",
              `Artist ${entry.artistId} remains present after a possibly dispatched deletion; refusing automatic resend`,
              {
                artistName: artist.artistName,
                before: plannedState(entry, "before", preflight.resources),
                after: plannedState(entry, "after", preflight.resources),
                observed: observedState(entry, artist, definition, preflight.resources),
                warnings: preflight.resources.warnings,
                failure: buildFailure(plan, definition, entry, {
                  code: "possible-dispatch-pending",
                  stage: "admission",
                  dispatchState: "dispatch-unknown",
                  verificationState: "inconclusive",
                  retryable: true,
                  safeNextAction: "resume-plan",
                }),
              },
            );
          }
          return entryResult(entry, "would-apply", undefined, undefined, {
            artistName: artist.artistName,
            before: plannedState(entry, "before", preflight.resources),
            after: plannedState(entry, "after", preflight.resources),
            observed: observedState(entry, artist, definition, preflight.resources),
            warnings: preflight.resources.warnings,
          });
        }),
      );
      sortEntryResults(plan, definition, entries);
      const scan = await resolveApplyScan(options.plexScan, false, true);
      return {
        planId: plan.id,
        planPath,
        status: "checked",
        dryRun: true,
        resumed: options.resume === true,
        planChecksum: plan.payloadChecksum,
        risk: plan.risk,
        cascadeAnalysis: cascadeEvidence,
        summary: summarize(plan.entries.length, entries),
        entries,
        execution: preflight.execution,
        ...(scan === undefined ? {} : { scan }),
      };
    }

    registerGlobalCleanup({
      priority: 10,
      name: cleanupHandlerName,
      cleanup: async () => {
        if (!signal.aborted) localAbortController.abort();
        await actionSettled;
      },
    });
    cleanupRegistered = true;
    claim = await acquireLidarrPlanClaim(plan.id, { claimDirectory: options.claimDirectory });
    signal.throwIfAborted();

    let execution: LidarrExecutionMetadata = preflight.execution;
    let database: DbConnection | undefined;
    const ensureDatabase = async (): Promise<DbConnection> => {
      database ??= await initializeDatabase(options.databasePath);
      return database;
    };
    const assertOwned = (): Promise<void> => {
      if (claim === undefined) {
        throw new LidarrPlanValidationError("real apply requires an exclusive claim", planPath);
      }
      return claim.assertOwned();
    };
    try {
      // KIND-FIRST ROUTING: album v2 entries also satisfy the album shape
      // guard, so real execution forks on `plan.operation.kind` before any of
      // the shared artist/v1 machinery can misroute them.
      if (isAlbumMutationDefinition(definition)) {
        const albumPlan = requireAlbumMutationPlan(plan);
        const albumDefinition = definition;
        let albumExecutable = pending.map(requireAlbumMutationEntry);

        let stopAdmissions = false;
        if (options.resume === true && albumExecutable.length > 0) {
          const reconciled = await reconcileLidarrDeferredEntries({
            database: await ensureDatabase(),
            plan: albumPlan,
            planPath,
            origin,
            executable: albumExecutable,
            client,
            definition: albumDefinition,
            historyPath: options.historyPath,
            signal,
            execution,
            assertOwned,
          });
          entries.push(...reconciled.entries);
          albumExecutable = reconciled.remaining;
          execution = reconciled.execution;
          stopAdmissions = reconciled.stopAdmissions;
          if (stopAdmissions) {
            entries.push(
              ...notAttemptedLidarrAlbumMutationResults(
                albumPlan,
                albumDefinition,
                albumExecutable,
              ),
            );
          }
        }

        if (!stopAdmissions) {
          const applied = await executeLidarrAlbumMutationApplyMutations({
            plan: albumPlan,
            planPath,
            origin,
            executable: albumExecutable,
            client,
            definition: albumDefinition,
            historyPath: options.historyPath,
            signal,
            execution,
            ensureDatabase,
            assertOwned,
          });
          entries.push(...applied.entries);
          execution = applied.execution;
        }
      } else {
        let laneExecutable: AnyLidarrPlanEntry[] = pending.map(requireArtistLaneEntry);

        let stopAdmissions = false;
        if (
          options.resume === true &&
          laneExecutable.length > 0 &&
          definition.kind !== "artist-delete"
        ) {
          const reconciled = await reconcileLidarrDeferredEntries({
            database: await ensureDatabase(),
            plan: requireArtistLanePlan(plan),
            planPath,
            origin,
            executable: laneExecutable,
            client,
            definition,
            resources: preflight.resources,
            historyPath: options.historyPath,
            signal,
            execution,
            assertOwned,
            support: executionSupport,
          });
          entries.push(...reconciled.entries);
          laneExecutable = reconciled.remaining;
          execution = reconciled.execution;
          stopAdmissions = reconciled.stopAdmissions;
          if (stopAdmissions) {
            entries.push(
              ...notAttemptedResults(plan, definition, laneExecutable, preflight.resources),
            );
          }
        }

        if (!stopAdmissions) {
          const applied = await executeLidarrApplyMutations({
            plan: requireArtistLanePlan(plan),
            planPath,
            origin,
            executable: laneExecutable,
            client,
            definition,
            resources: preflight.resources,
            historyPath: options.historyPath,
            signal,
            execution,
            ensureDatabase,
            assertOwned,
            support: executionSupport,
            attributableAbsenceEntryIds,
          });
          entries.push(...applied.entries);
          execution = applied.execution;
        }
      }
    } finally {
      if (database !== undefined) closeDatabase(database);
    }
    sortEntryResults(plan, definition, entries);
    const scan = await resolveApplyScan(
      options.plexScan,
      hasQualifyingDeleteSuccess(plan, entries),
      false,
    );
    return {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      planPath,
      status: resultStatus(false, entries),
      dryRun: false,
      resumed: options.resume === true,
      risk: plan.risk,
      cascadeAnalysis: cascadeEvidence,
      summary: summarize(plan.entries.length, entries),
      entries,
      execution,
      ...(scan === undefined ? {} : { scan }),
    };
  } finally {
    try {
      await claim?.release();
    } finally {
      resolveActionSettled?.();
      if (cleanupRegistered) unregisterGlobalCleanup(cleanupHandlerName);
      globalSignal.removeEventListener("abort", forwardGlobalAbort);
      options.signal?.removeEventListener("abort", forwardCallerAbort);
    }
  }
}
