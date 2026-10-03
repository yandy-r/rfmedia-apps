/** Typed dispatch and reconciliation-outcome persistence for one Lidarr artist target. */

import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrArtistDeletePlanEntry } from "../../types/lidarr-plan.js";
import { isLidarrApplyAbortError, safeLidarrApplyErrorMessage } from "./apply-target-errors.js";
import type {
  LidarrApplyEntryExecutionArgs,
  LidarrApplyEntryExecutionResult,
  LidarrApplyReconciliationResult,
  LidarrArtistApplyOperationDefinition,
  LidarrArtistApplyPlanEntry,
  LidarrClassifiedApplyTarget,
} from "./apply-target-types.js";

const TIER = "local-only";

export interface LidarrArtistDispatchResult {
  readonly execution: LidarrExecutionMetadata;
  readonly error: unknown;
  readonly possibleDispatchDurable: boolean;
}

type ArtistEntryArgs = LidarrApplyEntryExecutionArgs & {
  readonly entry: LidarrArtistApplyPlanEntry;
  readonly live: LidarrClassifiedApplyTarget;
};

function isArtistDeleteEntry(
  entry: LidarrArtistApplyPlanEntry,
): entry is LidarrArtistDeletePlanEntry {
  return "exists" in entry.after;
}

/** Dispatches one artist mutation and captures transport ambiguity for reconciliation. */
export async function dispatchLidarrArtistApplyEntry(
  args: ArtistEntryArgs,
  definition: LidarrArtistApplyOperationDefinition,
): Promise<LidarrArtistDispatchResult> {
  if (definition.kind === "artist-delete" && isArtistDeleteEntry(args.entry)) {
    try {
      await args.assertOwned();
      if (args.support.persistPossibleDispatch === undefined) {
        throw new Error("Artist deletion requires durable possible-dispatch persistence");
      }
      await args.support.persistPossibleDispatch(
        args.plan,
        args.entry,
        args.historyPath,
        args.assertOwned,
      );
      await args.assertOwned();
    } catch (error) {
      return {
        execution: args.live.execution,
        error,
        possibleDispatchDurable: false,
      };
    }
  }

  try {
    const applied = await resolveLidarrScheduler().runSingle(
      TIER,
      {
        id: `lidarr-apply-${args.plan.id}-${args.entry.artistId}`,
        operation: `lidarr apply ${definition.kind}`,
        idempotent: false,
        run: () => definition.execute(args.entry, args.client, args.signal),
      },
      { signal: args.signal },
    );
    return { execution: applied.execution, error: undefined, possibleDispatchDurable: true };
  } catch (error) {
    return { execution: args.live.execution, error, possibleDispatchDurable: true };
  }
}

/**
 * Builds a non-durable uncertainty result when the pre-dispatch history
 * boundary cannot be proven. No terminal history write is attempted because a
 * failed append may still have committed the possible-dispatch record.
 */
export function possibleDispatchPersistenceFailure(
  args: ArtistEntryArgs,
  error: unknown,
): LidarrApplyEntryExecutionResult {
  if (!isArtistDeleteEntry(args.entry)) {
    throw new Error("Possible-dispatch persistence is only valid for artist deletion");
  }
  const message = safeLidarrApplyErrorMessage(
    error,
    "Durable possible-dispatch evidence could not be established",
  );
  return {
    result: {
      entryId: args.entry.id,
      artistId: args.entry.artistId,
      artistName: args.live.artist?.artistName ?? args.entry.artistName,
      outcome: "uncertain",
      errorCode: "history-write-failed",
      message,
      before: {
        kind: "artist-delete",
        exists: true,
        evidence: args.entry.before,
      },
      after: { kind: "artist-delete", exists: false },
      observed: args.live.observed,
      failure: args.support.buildFailure(args.plan, args.definition, args.entry, {
        code: "history-write-failed",
        stage: "history",
        dispatchState: "not-dispatched",
        verificationState: "not-started",
        retryable: true,
        safeNextAction: "resume-plan",
      }),
    },
    execution: args.live.execution,
    stopAdmissions: true,
    safeNextAction: "resume-plan",
  };
}

async function persistVerifiedArtistOutcome(
  args: ArtistEntryArgs,
  reconciled: LidarrApplyReconciliationResult,
  dispatchError: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    "succeeded",
    args.historyPath,
    args.definition,
    args.resources,
    undefined,
    dispatchError instanceof LidarrError
      ? `Editor response was lost but targeted verification confirmed success: ${dispatchError.message}`
      : undefined,
    true,
    args.assertOwned,
    {
      artistName:
        reconciled.artist?.artistName ?? args.live.artist?.artistName ?? args.entry.artistName,
      observed: reconciled.observed,
    },
  );
  return {
    result: persisted.result,
    execution: reconciled.execution,
    stopAdmissions: !persisted.durable,
  };
}

async function persistFailedArtistOutcome(
  args: ArtistEntryArgs,
  reconciled: LidarrApplyReconciliationResult,
  dispatchError: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
  const detail = safeLidarrApplyErrorMessage(
    reconciled.error,
    "Managed postcondition verification failed",
  );
  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    "failed",
    args.historyPath,
    args.definition,
    args.resources,
    "verification-failed",
    detail,
    false,
    args.assertOwned,
    {
      artistName:
        reconciled.artist?.artistName ?? args.live.artist?.artistName ?? args.entry.artistName,
      observed: reconciled.observed,
      failure: args.support.buildFailure(args.plan, args.definition, args.entry, {
        code: "verification-failed",
        stage: "verification",
        dispatchState: dispatchError === undefined ? "dispatched" : "dispatch-unknown",
        verificationState: "failed",
        retryable: false,
        safeNextAction: "review-failure-and-resume",
      }),
    },
  );
  return {
    result: persisted.result,
    execution: reconciled.execution,
    stopAdmissions: true,
  };
}

async function persistNonRetryableDispatchOutcome(
  args: ArtistEntryArgs,
  reconciled: LidarrApplyReconciliationResult,
  dispatchError: LidarrError,
): Promise<LidarrApplyEntryExecutionResult> {
  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    "failed",
    args.historyPath,
    args.definition,
    args.resources,
    dispatchError.code,
    dispatchError.message,
    false,
    args.assertOwned,
    {
      artistName:
        reconciled.artist?.artistName ?? args.live.artist?.artistName ?? args.entry.artistName,
      observed: reconciled.observed,
      failure: args.support.buildFailure(args.plan, args.definition, args.entry, {
        code: dispatchError.code,
        stage: "dispatch",
        dispatchState: "dispatched",
        verificationState: "failed",
        retryable: false,
        safeNextAction: "review-failure-and-resume",
      }),
    },
  );
  return {
    result: persisted.result,
    execution: reconciled.execution,
    stopAdmissions: true,
  };
}

async function persistInconclusiveArtistOutcome(
  args: ArtistEntryArgs,
  reconciled: LidarrApplyReconciliationResult,
  dispatchError: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
  const code = isLidarrApplyAbortError(dispatchError ?? reconciled.error, args.signal)
    ? "post-dispatch-cancelled"
    : "verification-inconclusive";
  const detail =
    dispatchError instanceof LidarrError
      ? dispatchError.message
      : safeLidarrApplyErrorMessage(
          reconciled.error,
          "Post-dispatch state remained inconclusive after bounded reconciliation",
        );
  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    "uncertain",
    args.historyPath,
    args.definition,
    args.resources,
    code,
    detail,
    true,
    args.assertOwned,
    {
      artistName:
        reconciled.artist?.artistName ?? args.live.artist?.artistName ?? args.entry.artistName,
      observed: reconciled.observed,
      failure: args.support.buildFailure(args.plan, args.definition, args.entry, {
        code,
        stage: "verification",
        dispatchState: dispatchError === undefined ? "dispatched" : "dispatch-unknown",
        verificationState: "inconclusive",
        retryable: true,
        safeNextAction: "resume-plan",
      }),
    },
  );
  return {
    result: persisted.result,
    execution: reconciled.execution,
    stopAdmissions: true,
  };
}

/** Persists the exact result selected by bounded post-dispatch reconciliation. */
export async function persistLidarrArtistReconciliationOutcome(
  args: ArtistEntryArgs,
  reconciled: LidarrApplyReconciliationResult,
  dispatchError: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
  if (reconciled.state === "failed") {
    return persistFailedArtistOutcome(args, reconciled, dispatchError);
  }
  if (
    dispatchError instanceof LidarrError &&
    !dispatchError.retryable &&
    !isLidarrApplyAbortError(dispatchError, args.signal)
  ) {
    return persistNonRetryableDispatchOutcome(args, reconciled, dispatchError);
  }
  switch (reconciled.state) {
    case "verified":
      return persistVerifiedArtistOutcome(args, reconciled, dispatchError);
    case "inconclusive":
      return persistInconclusiveArtistOutcome(args, reconciled, dispatchError);
  }
}
