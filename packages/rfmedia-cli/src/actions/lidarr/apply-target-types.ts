/** Shared contracts for Lidarr apply admission, execution, and persistence. */

import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type { LidarrPlanStaleError } from "../../lib/errors.js";
import type {
  LidarrAlbumMonitoringOperationDefinition,
  LidarrDeferableMutationOperationDefinitionV2,
  LidarrMutationOperationDefinitionV2,
} from "../../lib/lidarr/plan-engine.js";
import type { LidarrArtistAddOperationDefinition } from "../../lib/lidarr/plan-operation-definitions.js";
import type {
  LidarrExecutionMetadata,
  LidarrSchedulerPreflight,
} from "../../lib/lidarr/scheduler.js";
import type { DbConnection } from "../../types/db.js";
import type {
  LidarrAlbumMonitoringPlanEntry,
  LidarrArtistAddPlanApplyEntryResult,
  LidarrArtistAddPlanEntryV2,
  LidarrArtistAddPlanHistoryRecord,
  LidarrArtistAddNormalizationPendingHistoryRecord,
  LidarrArtistAddNormalizationVerificationPendingHistoryRecord,
  LidarrArtistAddPlanV2,
  LidarrArtistAddPlanV3,
  LidarrArtistAddPossibleDispatchHistoryRecord,
  LidarrArtistDeleteObservedState,
  LidarrArtistDeletePlanEntry,
  LidarrMutationPlan,
  LidarrMutationPlanEntry,
  LidarrMutationPlanEntryV2,
  LidarrPlanApplyFailure,
  LidarrPlanApplyEntryResult,
  LidarrPlanHistoryOutcome,
  LidarrPlanObservedState,
  LidarrPlanStalenessFinding,
} from "../../types/lidarr-plan.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import type { LidarrApplyResourceContext } from "./apply-resources.js";

export type LidarrApplyPlan = LidarrMutationPlan;
export type LidarrAlbumApplyOperationDefinition = LidarrAlbumMonitoringOperationDefinition;
export type LidarrArtistApplyOperationDefinition = LidarrMutationOperationDefinitionV2;
export type LidarrArtistAddApplyOperationDefinition = LidarrArtistAddOperationDefinition;
export type LidarrApplyOperationDefinition =
  | LidarrAlbumApplyOperationDefinition
  | LidarrArtistApplyOperationDefinition;
export type LidarrDeferredArtistApplyOperationDefinition =
  LidarrDeferableMutationOperationDefinitionV2;
export type LidarrDeferredApplyOperationDefinition =
  | LidarrAlbumApplyOperationDefinition
  | LidarrDeferredArtistApplyOperationDefinition;
export type AnyLidarrApplyPlanEntry = LidarrMutationPlanEntry | LidarrMutationPlanEntryV2;
export type LidarrArtistApplyPlanEntry = Exclude<
  AnyLidarrApplyPlanEntry,
  LidarrAlbumMonitoringPlanEntry
>;
export type LidarrArtistAddApplyPlan = LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3;
export type LidarrArtistAddApplyPlanEntry = LidarrArtistAddPlanEntryV2;

/** Narrows apply behavior to operations allowed to use the deferred-intent subsystem. */
export function isLidarrDeferredApplyOperationDefinition(
  definition: LidarrApplyOperationDefinition,
): definition is LidarrDeferredApplyOperationDefinition {
  return definition.kind === "album-monitoring" || definition.deferability.kind === "deferable";
}

export type LidarrClassifiedApplyTarget =
  | {
      readonly classification: "ready" | "satisfied";
      readonly presence: "present";
      readonly execution: LidarrExecutionMetadata;
      readonly artist: LidarrArtist;
      readonly observed: LidarrPlanObservedState;
    }
  | {
      readonly classification: "satisfied";
      readonly presence: "absent";
      readonly execution: LidarrExecutionMetadata;
      readonly artist?: never;
      readonly observed: Extract<LidarrArtistDeleteObservedState, { readonly exists: false }>;
      readonly attribution: "resume-possible-dispatch";
    }
  | {
      readonly classification: "ready" | "satisfied";
      readonly presence: "unstructured";
      readonly execution: LidarrExecutionMetadata;
      readonly artist?: never;
      readonly observed?: never;
    };

export interface LidarrPersistedApplyOutcome {
  readonly result: LidarrPlanApplyEntryResult;
  readonly durable: boolean;
}

export interface LidarrApplyExecutionBatchResult {
  readonly entries: readonly LidarrPlanApplyEntryResult[];
  readonly execution: LidarrExecutionMetadata;
  readonly stopAdmissions: boolean;
}

export type LidarrApplyReconciliationResult =
  | {
      readonly state: "verified";
      readonly presence: "present";
      readonly execution: LidarrExecutionMetadata;
      readonly artist: LidarrArtist;
      readonly observed: LidarrPlanObservedState;
      readonly error?: never;
    }
  | {
      readonly state: "verified";
      readonly presence: "absent";
      readonly execution: LidarrExecutionMetadata;
      readonly artist?: never;
      readonly observed: Extract<LidarrArtistDeleteObservedState, { readonly exists: false }>;
      readonly error?: never;
    }
  | {
      readonly state: "failed" | "inconclusive";
      readonly presence: "present" | "unobserved";
      readonly execution: LidarrExecutionMetadata;
      readonly artist?: LidarrArtist;
      readonly observed?: LidarrPlanObservedState;
      readonly error?: unknown;
    };

export interface LidarrApplyExecutionSupport {
  readonly observedState: (
    entry: AnyLidarrApplyPlanEntry,
    artist: LidarrArtist,
    definition: LidarrApplyOperationDefinition,
    resources: LidarrApplyResourceContext,
  ) => LidarrPlanObservedState;
  readonly staleFinding: (
    entry: AnyLidarrApplyPlanEntry,
    code: LidarrPlanStalenessFinding["code"],
    message?: string,
  ) => LidarrPlanStalenessFinding;
  readonly staleEntryResult: (
    plan: LidarrApplyPlan,
    definition: LidarrApplyOperationDefinition,
    entry: AnyLidarrApplyPlanEntry,
    error: LidarrPlanStaleError,
    resources: LidarrApplyResourceContext,
    observed?: LidarrPlanObservedState,
  ) => LidarrPlanApplyEntryResult;
  readonly notAttemptedResults: (
    plan: LidarrApplyPlan,
    definition: LidarrApplyOperationDefinition,
    entries: readonly AnyLidarrApplyPlanEntry[],
    resources: LidarrApplyResourceContext,
    safeNextAction?: LidarrPlanApplyFailure["safeNextAction"],
  ) => LidarrPlanApplyEntryResult[];
  readonly buildFailure: (
    plan: LidarrApplyPlan,
    definition: LidarrApplyOperationDefinition,
    entry: AnyLidarrApplyPlanEntry,
    input: Omit<LidarrPlanApplyFailure, "operation" | "planId" | "planChecksum" | "targetIds">,
  ) => LidarrPlanApplyFailure;
  readonly persistOutcome: (
    plan: LidarrApplyPlan,
    entry: AnyLidarrApplyPlanEntry,
    outcome: LidarrPlanHistoryOutcome,
    historyPath: string | undefined,
    definition: LidarrApplyOperationDefinition,
    resources: LidarrApplyResourceContext,
    errorCode?: string,
    message?: string,
    remoteSucceeded?: boolean,
    assertOwned?: () => Promise<void>,
    evidence?: {
      readonly artistName?: string;
      readonly observed?: LidarrPlanObservedState;
      readonly failure?: LidarrPlanApplyFailure;
    },
  ) => Promise<LidarrPersistedApplyOutcome>;
  readonly persistPossibleDispatch?: (
    plan: LidarrApplyPlan,
    entry: LidarrArtistDeletePlanEntry,
    historyPath: string | undefined,
    assertOwned: () => Promise<void>,
  ) => Promise<void>;
}

export interface LidarrApplyEntryExecutionResult {
  readonly result: LidarrPlanApplyEntryResult;
  readonly execution: LidarrExecutionMetadata;
  readonly stopAdmissions: boolean;
  readonly safeNextAction?: LidarrPlanApplyFailure["safeNextAction"];
}

export interface LidarrApplyEntryExecutionArgs {
  readonly plan: LidarrApplyPlan;
  readonly planPath: string;
  readonly origin: string;
  readonly entry: AnyLidarrApplyPlanEntry;
  readonly client: LidarrClientApi;
  readonly definition: LidarrApplyOperationDefinition;
  readonly resources: LidarrApplyResourceContext;
  readonly historyPath?: string;
  readonly signal?: AbortSignal;
  readonly execution: LidarrExecutionMetadata;
  readonly ensureDatabase: () => Promise<DbConnection>;
  readonly assertOwned: () => Promise<void>;
  readonly support: LidarrApplyExecutionSupport;
  /**
   * True only when resume history proves a possibly dispatched deletion for
   * this exact plan/checksum/entry/idempotency tuple. Absence is attributable;
   * presence must stop rather than automatically dispatch the delete again.
   */
  readonly attributableAbsence?: boolean;
}

export interface LidarrArtistAddApplyEntryExecutionResult {
  readonly result: LidarrArtistAddPlanApplyEntryResult;
  readonly execution: LidarrExecutionMetadata;
  readonly stopAdmissions: boolean;
}

export interface LidarrArtistAddApplyEntryExecutionArgs {
  readonly plan: LidarrArtistAddApplyPlan;
  readonly planPath: string;
  readonly entry: LidarrArtistAddApplyPlanEntry;
  readonly client: LidarrClientApi;
  readonly preflight: LidarrSchedulerPreflight;
  readonly execution: LidarrExecutionMetadata;
  readonly historyPath?: string;
  readonly signal?: AbortSignal;
  readonly assertOwned: () => Promise<void>;
  readonly resumePossibleDispatch: boolean;
  readonly resumePossibleDispatchLidarrId?: number;
  readonly resumeNormalizationHistory?:
    | LidarrArtistAddNormalizationPendingHistoryRecord
    | LidarrArtistAddNormalizationVerificationPendingHistoryRecord;
  readonly appendHistory: (
    record:
      | LidarrArtistAddPlanHistoryRecord
      | LidarrArtistAddPossibleDispatchHistoryRecord
      | LidarrArtistAddNormalizationPendingHistoryRecord
      | LidarrArtistAddNormalizationVerificationPendingHistoryRecord,
    historyPath?: string,
  ) => Promise<void>;
}
