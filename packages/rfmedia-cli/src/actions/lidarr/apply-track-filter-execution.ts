/** Exact, non-deferable apply lifecycle for `track-file-filter` plans. */

import { LidarrPlanStaleError, LidarrPlanValidationError } from "../../lib/errors.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import {
  acquireLidarrPlanClaim,
  appendLidarrPlanHistory,
  readLidarrPlanHistory,
} from "../../lib/lidarr/plan-engine.js";
import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type {
  LidarrAlbumPlanApplyEntryResult,
  LidarrAlbumPlanHistoryRecord,
  LidarrPlanApplyEntryResult,
  LidarrPlanApplyResult,
  LidarrPlanTerminalHistoryOutcome,
  LidarrTrackFileFilterPlanEntryV2,
  LidarrTrackFileFilterPlanV2,
} from "../../types/lidarr-plan.js";
import type { LidarrTrackFile } from "../../types/lidarr.js";

const VERIFY_ATTEMPTS = 3;

type LidarrSpecializedApplyResult = Omit<LidarrPlanApplyResult, "cascadeAnalysis">;

export interface LidarrTrackFilterApplyOptions {
  readonly dryRun: boolean;
  readonly resume?: boolean;
  readonly historyPath?: string;
  readonly claimDirectory?: string;
  readonly signal?: AbortSignal;
}

export interface LidarrTrackFilterApplyArgs {
  readonly plan: LidarrTrackFileFilterPlanV2;
  readonly planPath: string;
  readonly client: LidarrClientApi;
  readonly options: LidarrTrackFilterApplyOptions;
}

function entryResult(
  entry: LidarrTrackFileFilterPlanEntryV2,
  outcome: LidarrAlbumPlanApplyEntryResult["outcome"],
  errorCode?: string,
  message?: string,
): LidarrAlbumPlanApplyEntryResult {
  return Object.freeze({
    entryId: entry.id,
    albumId: entry.albumId,
    albumTitle: entry.albumTitle,
    artistId: entry.artistId,
    artistName: entry.artistName,
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(message === undefined ? {} : { message }),
  });
}

function summarize(entry: LidarrPlanApplyEntryResult): LidarrPlanApplyResult["summary"] {
  return {
    total: 1,
    succeeded: entry.outcome === "succeeded" ? 1 : 0,
    satisfied: entry.outcome === "satisfied" ? 1 : 0,
    failed: entry.outcome === "failed" ? 1 : 0,
    deferred: 0,
    uncertain: entry.outcome === "uncertain" ? 1 : 0,
    blockedStale: entry.outcome === "blocked-stale" ? 1 : 0,
    notAttempted: 0,
    skippedResume: entry.outcome === "skipped-resume" ? 1 : 0,
    wouldApply: entry.outcome === "would-apply" ? 1 : 0,
  };
}

function result(
  args: LidarrTrackFilterApplyArgs,
  entry: LidarrAlbumPlanApplyEntryResult,
  execution: LidarrExecutionMetadata | undefined,
): LidarrSpecializedApplyResult {
  const dryRun = args.options.dryRun;
  const failed = entry.outcome === "failed" || entry.outcome === "uncertain";
  return Object.freeze({
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    planPath: args.planPath,
    status: dryRun ? "checked" : failed ? "failed" : "completed",
    dryRun,
    resumed: args.options.resume === true,
    risk: args.plan.risk,
    summary: summarize(entry),
    entries: Object.freeze([entry]),
    ...(execution === undefined ? {} : { execution }),
  });
}

function exactStateMatches(
  entry: LidarrTrackFileFilterPlanEntryV2,
  current: readonly LidarrTrackFile[],
): boolean {
  if (current.length !== entry.before.deleteCandidates.length) return false;
  const byId = new Map(current.map((trackFile) => [trackFile.id, trackFile]));
  return entry.before.deleteCandidates.every((candidate) => {
    const trackFile = byId.get(candidate.trackFileId);
    return (
      trackFile !== undefined &&
      trackFile.albumId === entry.albumId &&
      trackFile.artistId === entry.artistId &&
      trackFile.path === candidate.path &&
      trackFile.size === candidate.size
    );
  });
}

async function readTargets(
  plan: LidarrTrackFileFilterPlanV2,
  entry: LidarrTrackFileFilterPlanEntryV2,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<{
  readonly files: readonly LidarrTrackFile[];
  readonly execution: LidarrExecutionMetadata;
}> {
  const scheduled = await resolveLidarrScheduler().runSingle("local-only", {
    id: `lidarr-apply-track-filter-read-${plan.id}`,
    operation: "lidarr apply trackfile check",
    idempotent: true,
    run: () =>
      client.listTrackFiles({
        trackFileIds: entry.after.deletedTrackFileIds,
        ...(signal === undefined ? {} : { signal }),
      }),
  });
  return { files: scheduled.value, execution: scheduled.execution };
}

async function persist(
  plan: LidarrTrackFileFilterPlanV2,
  entry: LidarrTrackFileFilterPlanEntryV2,
  outcome: LidarrPlanTerminalHistoryOutcome,
  historyPath: string | undefined,
  errorCode?: string,
  message?: string,
): Promise<void> {
  const record: LidarrAlbumPlanHistoryRecord = {
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
  await appendLidarrPlanHistory(record, historyPath);
}

async function verifyAbsent(
  plan: LidarrTrackFileFilterPlanV2,
  entry: LidarrTrackFileFilterPlanEntryV2,
  client: LidarrClientApi,
): Promise<{
  readonly absent: boolean;
  readonly execution?: LidarrExecutionMetadata;
  readonly error?: unknown;
}> {
  let execution: LidarrExecutionMetadata | undefined;
  let error: unknown;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    try {
      const read = await readTargets(plan, entry, client);
      execution = read.execution;
      if (read.files.length === 0) return { absent: true, execution };
    } catch (caught) {
      error = caught;
    }
  }
  return {
    absent: false,
    ...(execution === undefined ? {} : { execution }),
    ...(error === undefined ? {} : { error }),
  };
}

/** Applies one exact trackfile-filter plan without deferred intent support. */
export async function executeLidarrTrackFilterApply(
  args: LidarrTrackFilterApplyArgs,
): Promise<LidarrSpecializedApplyResult> {
  const entry = args.plan.entries[0];
  const history = await readLidarrPlanHistory(
    args.plan.id,
    args.plan.payloadChecksum,
    args.options.historyPath,
  );
  if (history.length > 0 && args.options.resume !== true) {
    throw new LidarrPlanValidationError(
      "this plan has prior history; use --resume to continue safely",
      args.planPath,
    );
  }
  const prior = [...history].reverse().find((record) => record.entryId === entry.id);
  if (
    args.options.resume === true &&
    prior !== undefined &&
    (prior.outcome === "succeeded" || prior.outcome === "satisfied")
  ) {
    return result(args, entryResult(entry, "skipped-resume"), undefined);
  }
  args.options.signal?.throwIfAborted();
  if (args.options.dryRun) {
    const admission = await readTargets(args.plan, entry, args.client, args.options.signal);
    const attributableAbsence = args.options.resume === true && admission.files.length === 0;
    if (!attributableAbsence && !exactStateMatches(entry, admission.files)) {
      throw new LidarrPlanStaleError(
        [
          {
            code: admission.files.length === 0 ? "album-missing" : "album-state-drift",
            entryId: entry.id,
            albumId: entry.albumId,
            message: "Planned trackfile path, size, parent, or presence changed",
          },
        ],
        args.planPath,
      );
    }
    return result(
      args,
      entryResult(entry, attributableAbsence ? "satisfied" : "would-apply"),
      admission.execution,
    );
  }

  const claim = await acquireLidarrPlanClaim(args.plan.id, {
    claimDirectory: args.options.claimDirectory,
  });
  try {
    await claim.assertOwned();
    const admission = await readTargets(args.plan, entry, args.client, args.options.signal);
    const attributableAbsence = args.options.resume === true && admission.files.length === 0;
    if (!attributableAbsence && !exactStateMatches(entry, admission.files)) {
      throw new LidarrPlanStaleError(
        [
          {
            code: admission.files.length === 0 ? "album-missing" : "album-state-drift",
            entryId: entry.id,
            albumId: entry.albumId,
            message: "Planned trackfile path, size, parent, or presence changed",
          },
        ],
        args.planPath,
      );
    }
    if (attributableAbsence) {
      await claim.assertOwned();
      await persist(args.plan, entry, "satisfied", args.options.historyPath);
      return result(args, entryResult(entry, "satisfied"), admission.execution);
    }
    args.options.signal?.throwIfAborted();
    await claim.assertOwned();
    let dispatchError: unknown;
    let execution = admission.execution;
    try {
      const dispatched = await resolveLidarrScheduler().runSingle("local-only", {
        id: `lidarr-apply-track-filter-${args.plan.id}`,
        operation: "lidarr apply trackfile filter",
        idempotent: false,
        run: () =>
          args.client.bulkDeleteTrackFiles(entry.after.deletedTrackFileIds, args.options.signal),
      });
      execution = dispatched.execution;
    } catch (error) {
      dispatchError = error;
    }

    const verified = await verifyAbsent(args.plan, entry, args.client);
    execution = verified.execution ?? execution;
    let outcome: LidarrPlanTerminalHistoryOutcome;
    let errorCode: string | undefined;
    let message: string | undefined;
    if (verified.absent) {
      outcome = "succeeded";
      if (dispatchError !== undefined) {
        message = "Delete response failed, but fresh reads verified every target absent";
      }
    } else if (dispatchError === undefined && verified.error === undefined) {
      outcome = "failed";
      errorCode = "verification-failed";
      message = "One or more planned trackfiles remain after deletion";
    } else {
      outcome = "uncertain";
      errorCode = "verification-inconclusive";
      message = "Deletion may have dispatched and absence could not be verified";
    }
    try {
      await claim.assertOwned();
      await persist(args.plan, entry, outcome, args.options.historyPath, errorCode, message);
    } catch (historyError) {
      if (verified.absent) {
        return result(
          args,
          entryResult(
            entry,
            "uncertain",
            "history-write-failed",
            "Remote deletion verified, but durable history failed; resume is required",
          ),
          execution,
        );
      }
      throw historyError;
    }
    return result(args, entryResult(entry, outcome, errorCode, message), execution);
  } finally {
    await claim.release();
  }
}
