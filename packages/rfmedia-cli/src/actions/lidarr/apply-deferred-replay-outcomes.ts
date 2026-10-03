/** Durable apply-history outcomes produced while replaying Lidarr deferred intents. */

import { LidarrError } from "../../lib/lidarr/errors.js";
import type { LidarrReplayOutcome } from "../../lib/lidarr/deferred-queue.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type {
  LidarrAlbumMonitoringPlanEntry,
  LidarrPlanApplyEntryResult,
  LidarrPlanHistoryOutcome,
} from "../../types/lidarr-plan.js";
import {
  lidarrAlbumMutationFailure,
  persistLidarrAlbumMutationOutcome,
  persistLidarrAlbumMutationReconciliationOutcome,
  type LidarrAlbumMutationPersistenceContext,
  type LidarrAlbumMutationReconciliationResult,
} from "./apply-album-mutation-execution.js";
import type { LidarrApplyResourceContext } from "./apply-resources.js";
import {
  safeLidarrApplyErrorMessage,
  type AnyLidarrApplyPlanEntry,
  type LidarrApplyExecutionSupport,
  type LidarrApplyOperationDefinition,
  type LidarrApplyPlan,
  type LidarrApplyReconciliationResult,
  type LidarrClassifiedApplyTarget,
  type LidarrPersistedApplyOutcome,
} from "./apply-target-execution.js";

function isAlbumEntry(entry: AnyLidarrApplyPlanEntry): entry is LidarrAlbumMonitoringPlanEntry {
  return "albumId" in entry;
}

export interface LidarrDeferredReplayPersistenceContext {
  readonly plan: LidarrApplyPlan;
  readonly entry: AnyLidarrApplyPlanEntry;
  readonly definition: LidarrApplyOperationDefinition;
  readonly resources: LidarrApplyResourceContext;
  readonly historyPath?: string;
  readonly assertOwned: () => Promise<void>;
  readonly support: LidarrApplyExecutionSupport;
}

export interface LidarrDeferredReplayEntryResult {
  readonly result: LidarrPlanApplyEntryResult;
  readonly execution: LidarrExecutionMetadata;
  readonly stopAdmissions: boolean;
}

export interface LidarrArtistReplayResult {
  readonly execution: LidarrExecutionMetadata;
  readonly replayOutcome: LidarrReplayOutcome | undefined;
  readonly replayResolution: LidarrApplyReconciliationResult | undefined;
  readonly dispatchError: unknown;
}

function completedReplay(
  persisted: LidarrPersistedApplyOutcome,
  execution: LidarrExecutionMetadata,
  stopWhenNotDurable = false,
): LidarrDeferredReplayEntryResult {
  return {
    result: persisted.result,
    execution,
    stopAdmissions: stopWhenNotDurable && !persisted.durable,
  };
}

export async function persistRetryableClassificationFailure(
  context: LidarrDeferredReplayPersistenceContext,
  execution: LidarrExecutionMetadata,
  error: LidarrError,
): Promise<LidarrDeferredReplayEntryResult> {
  const persisted = await context.support.persistOutcome(
    context.plan,
    context.entry,
    "deferred",
    context.historyPath,
    context.definition,
    context.resources,
    error.code,
    error.message,
    false,
    context.assertOwned,
    isAlbumEntry(context.entry)
      ? undefined
      : {
          failure: context.support.buildFailure(context.plan, context.definition, context.entry, {
            code: error.code,
            stage: "resume",
            dispatchState: "not-dispatched",
            verificationState: "not-started",
            retryable: true,
            safeNextAction: "resume-plan",
          }),
        },
  );
  return completedReplay(persisted, execution);
}

export async function persistSatisfiedReplayOutcome(
  context: LidarrDeferredReplayPersistenceContext,
  live: LidarrClassifiedApplyTarget,
): Promise<LidarrDeferredReplayEntryResult> {
  const persisted = await context.support.persistOutcome(
    context.plan,
    context.entry,
    "satisfied",
    context.historyPath,
    context.definition,
    context.resources,
    undefined,
    undefined,
    false,
    context.assertOwned,
    isAlbumEntry(context.entry)
      ? undefined
      : {
          artistName: live.artist?.artistName ?? context.entry.artistName,
          observed: live.observed,
        },
  );
  return completedReplay(persisted, live.execution);
}

export async function persistAlbumReplayOutcome(
  context: LidarrDeferredReplayPersistenceContext,
  execution: LidarrExecutionMetadata,
  replayOutcome: LidarrReplayOutcome | undefined,
): Promise<LidarrDeferredReplayEntryResult> {
  const outcome: LidarrPlanHistoryOutcome =
    replayOutcome?.outcome === "succeeded"
      ? "succeeded"
      : replayOutcome?.outcome === "failed"
        ? "failed"
        : "deferred";
  const persisted = await context.support.persistOutcome(
    context.plan,
    context.entry,
    outcome,
    context.historyPath,
    context.definition,
    context.resources,
    replayOutcome?.errorCode,
    replayOutcome?.message,
    replayOutcome !== undefined && outcome === "succeeded",
    context.assertOwned,
  );
  return completedReplay(persisted, execution, replayOutcome !== undefined);
}

async function persistCancelledArtistReplay(
  context: LidarrDeferredReplayPersistenceContext,
  live: LidarrClassifiedApplyTarget,
  replay: LidarrArtistReplayResult,
): Promise<LidarrDeferredReplayEntryResult> {
  const message = "Mutation was dispatched before cancellation and could not be verified";
  const persisted = await context.support.persistOutcome(
    context.plan,
    context.entry,
    "uncertain",
    context.historyPath,
    context.definition,
    context.resources,
    "post-dispatch-cancelled",
    message,
    true,
    context.assertOwned,
    {
      artistName: live.artist?.artistName ?? context.entry.artistName,
      observed: replay.replayResolution?.observed,
      failure: context.support.buildFailure(context.plan, context.definition, context.entry, {
        code: "post-dispatch-cancelled",
        stage: "verification",
        dispatchState: "dispatch-unknown",
        verificationState: "inconclusive",
        retryable: true,
        safeNextAction: "resume-plan",
      }),
    },
  );
  return { ...completedReplay(persisted, replay.execution), stopAdmissions: true };
}

async function persistUnverifiedArtistReplay(
  context: LidarrDeferredReplayPersistenceContext,
  live: LidarrClassifiedApplyTarget,
  replay: LidarrArtistReplayResult,
): Promise<LidarrDeferredReplayEntryResult | undefined> {
  if (replay.replayResolution?.state === "failed") {
    const message = safeLidarrApplyErrorMessage(
      replay.replayResolution.error,
      "Managed postcondition verification failed",
    );
    const persisted = await context.support.persistOutcome(
      context.plan,
      context.entry,
      "failed",
      context.historyPath,
      context.definition,
      context.resources,
      "verification-failed",
      message,
      false,
      context.assertOwned,
      {
        artistName:
          replay.replayResolution.artist?.artistName ??
          live.artist?.artistName ??
          context.entry.artistName,
        observed: replay.replayResolution.observed,
        failure: context.support.buildFailure(context.plan, context.definition, context.entry, {
          code: "verification-failed",
          stage: "verification",
          dispatchState: "dispatched",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        }),
      },
    );
    return { ...completedReplay(persisted, replay.execution), stopAdmissions: true };
  }
  if (replay.replayResolution?.state !== "inconclusive") return undefined;
  const detail =
    replay.dispatchError instanceof LidarrError
      ? replay.dispatchError.message
      : "Post-dispatch state remained inconclusive";
  const persisted = await context.support.persistOutcome(
    context.plan,
    context.entry,
    "uncertain",
    context.historyPath,
    context.definition,
    context.resources,
    "verification-inconclusive",
    detail,
    true,
    context.assertOwned,
    {
      artistName:
        replay.replayResolution.artist?.artistName ??
        live.artist?.artistName ??
        context.entry.artistName,
      observed: replay.replayResolution.observed,
      failure: context.support.buildFailure(context.plan, context.definition, context.entry, {
        code: "verification-inconclusive",
        stage: "verification",
        dispatchState: "dispatch-unknown",
        verificationState: "inconclusive",
        retryable: true,
        safeNextAction: "resume-plan",
      }),
    },
  );
  return { ...completedReplay(persisted, replay.execution), stopAdmissions: true };
}

/** Replay evidence for one album-family deferred intent. */
export interface LidarrAlbumMutationReplayResult {
  readonly execution: LidarrExecutionMetadata;
  readonly replayOutcome: LidarrReplayOutcome | undefined;
  readonly replayResolution: LidarrAlbumMutationReconciliationResult | undefined;
  readonly dispatchError: unknown;
  /** Replay dispatch hit not-found for album-delete: already-deleted == success. */
  readonly alreadyDeleted: boolean;
}

/** Persists "deferred" when the pre-replay fresh read failed retryably. */
export async function persistAlbumMutationRetryableReplayFailure(
  context: LidarrAlbumMutationPersistenceContext,
  execution: LidarrExecutionMetadata,
  error: LidarrError,
): Promise<LidarrDeferredReplayEntryResult> {
  const persisted = await persistLidarrAlbumMutationOutcome(context, "deferred", {
    errorCode: error.code,
    message: error.message,
    failure: lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
      code: error.code,
      stage: "resume",
      dispatchState: "not-dispatched",
      verificationState: "not-started",
      retryable: true,
      safeNextAction: "resume-plan",
    }),
  });
  return { result: persisted.result, execution, stopAdmissions: false };
}

/**
 * Persists the terminal outcome of one album-family deferred replay. This is
 * where replay dispatch-error classification lives: an album-delete replay
 * hitting not-found is SUCCESS (already-deleted, recorded "satisfied").
 */
export async function persistAlbumMutationReplayOutcome(
  context: LidarrAlbumMutationPersistenceContext & { readonly signal?: AbortSignal },
  replay: LidarrAlbumMutationReplayResult,
): Promise<LidarrDeferredReplayEntryResult> {
  if (replay.replayOutcome?.outcome === "cancelled") {
    const persisted = await persistLidarrAlbumMutationOutcome(context, "uncertain", {
      errorCode: "post-dispatch-cancelled",
      message: "Mutation was dispatched before cancellation and could not be verified",
      remoteSucceeded: true,
      failure: lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
        code: "post-dispatch-cancelled",
        stage: "verification",
        dispatchState: "dispatch-unknown",
        verificationState: "inconclusive",
        retryable: true,
        safeNextAction: "resume-plan",
      }),
    });
    return { result: persisted.result, execution: replay.execution, stopAdmissions: true };
  }
  if (replay.replayResolution?.state === "verified" && replay.alreadyDeleted) {
    const persisted = await persistLidarrAlbumMutationOutcome(context, "satisfied", {
      errorCode: "not-found",
      message: "Album was already deleted",
      remoteSucceeded: true,
    });
    return {
      result: persisted.result,
      execution: replay.execution,
      stopAdmissions: !persisted.durable,
    };
  }
  if (replay.replayResolution !== undefined) {
    const outcome = await persistLidarrAlbumMutationReconciliationOutcome(
      context,
      { ...replay.replayResolution, execution: replay.execution },
      replay.dispatchError,
    );
    return {
      result: outcome.result,
      execution: outcome.execution,
      stopAdmissions: outcome.stopAdmissions,
    };
  }
  // The executor never dispatched (circuit open, not due, or no executor).
  const outcome: LidarrPlanHistoryOutcome =
    replay.replayOutcome?.outcome === "succeeded"
      ? "succeeded"
      : replay.replayOutcome?.outcome === "failed"
        ? "failed"
        : "deferred";
  const code =
    outcome === "failed"
      ? (replay.replayOutcome?.errorCode ?? "deferred-replay-failed")
      : outcome === "deferred"
        ? (replay.replayOutcome?.errorCode ?? "deferred-not-due")
        : undefined;
  const persisted = await persistLidarrAlbumMutationOutcome(context, outcome, {
    ...(code === undefined ? {} : { errorCode: code }),
    ...(replay.replayOutcome?.message === undefined
      ? {}
      : { message: replay.replayOutcome.message }),
    remoteSucceeded: outcome === "succeeded",
    ...(code === undefined
      ? {}
      : {
          failure: lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
            code,
            stage: "resume",
            dispatchState: "not-dispatched",
            verificationState: "not-started",
            retryable: outcome === "deferred",
            safeNextAction: outcome === "deferred" ? "resume-plan" : "review-failure-and-resume",
          }),
        }),
  });
  return completedReplay(persisted, replay.execution, true);
}

export async function persistArtistReplayOutcome(
  context: LidarrDeferredReplayPersistenceContext,
  live: LidarrClassifiedApplyTarget,
  replay: LidarrArtistReplayResult,
): Promise<LidarrDeferredReplayEntryResult> {
  if (replay.replayOutcome?.outcome === "cancelled") {
    return persistCancelledArtistReplay(context, live, replay);
  }
  const unverified = await persistUnverifiedArtistReplay(context, live, replay);
  if (unverified !== undefined) return unverified;

  const outcome: LidarrPlanHistoryOutcome =
    replay.replayOutcome?.outcome === "succeeded"
      ? "succeeded"
      : replay.replayOutcome?.outcome === "failed"
        ? "failed"
        : "deferred";
  const code =
    outcome === "failed"
      ? (replay.replayOutcome?.errorCode ?? "deferred-replay-failed")
      : outcome === "deferred"
        ? (replay.replayOutcome?.errorCode ?? "deferred-not-due")
        : undefined;
  const failure =
    code === undefined
      ? undefined
      : context.support.buildFailure(context.plan, context.definition, context.entry, {
          code,
          stage: "resume",
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          retryable: outcome === "deferred",
          safeNextAction: outcome === "deferred" ? "resume-plan" : "review-failure-and-resume",
        });
  const persisted = await context.support.persistOutcome(
    context.plan,
    context.entry,
    outcome,
    context.historyPath,
    context.definition,
    context.resources,
    code,
    replay.replayOutcome?.message,
    outcome === "succeeded",
    context.assertOwned,
    {
      artistName:
        replay.replayResolution?.artist?.artistName ??
        live.artist?.artistName ??
        context.entry.artistName,
      observed: replay.replayResolution?.observed ?? live.observed,
      failure,
    },
  );
  return completedReplay(persisted, replay.execution, true);
}
