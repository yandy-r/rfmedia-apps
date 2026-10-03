/** Non-idempotent dispatch and exact-MBID reconciliation for one artist-add entry. */

import { posix, win32 } from "node:path";

import { LIDARR_ALBUM_IDS_CHUNK_SIZE, resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import {
  matchesAlbumTypeSelectors,
  parseAlbumTypeSelectors,
} from "../../lib/lidarr/album-types.js";
import {
  readLidarrExecutionMetadata,
  type LidarrExecutionMetadata,
} from "../../lib/lidarr/scheduler.js";
import type {
  LidarrArtistAddPlanApplyEntryResult,
  LidarrArtistAddExtendedPlanEntryV2,
  LidarrArtistAddPlanEntryV2,
  LidarrArtistAddPlanHistoryRecord,
  LidarrArtistAddPlanApplyFailure,
  LidarrArtistAddPlanApplyStage,
  LidarrArtistAddNormalizationPendingHistoryRecord,
  LidarrArtistAddNormalizationVerificationPendingHistoryRecord,
  LidarrArtistAddPossibleDispatchHistoryRecord,
  LidarrPlanApplyFailureCode,
  LidarrPlanApplyFailureStage,
  LidarrPlanApplyOutcome,
  LidarrPlanApplyVerificationState,
} from "../../types/lidarr-plan.js";
import { LIDARR_PLAN_MAX_ENTRIES } from "../../types/lidarr-plan.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import { isLidarrApplyAbortError, safeLidarrApplyErrorMessage } from "./apply-target-errors.js";
import type {
  LidarrArtistAddApplyEntryExecutionArgs,
  LidarrArtistAddApplyEntryExecutionResult,
} from "./apply-target-types.js";

const READ_TIER = "local-only";
const DISPATCH_TIER = "metadata-dependent";

function isExtendedEntry(
  entry: LidarrArtistAddPlanEntryV2,
): entry is LidarrArtistAddExtendedPlanEntryV2 {
  return "postAddUnmonitorSelectors" in entry.after;
}

export type LidarrArtistAddTargetClassification =
  | {
      readonly state: "ready";
      readonly artist?: never;
      readonly message?: never;
    }
  | {
      readonly state: "satisfied";
      readonly artist: LidarrArtist;
      readonly message?: never;
    }
  | {
      readonly state: "drifted";
      readonly artist: LidarrArtist;
      readonly message: string;
    };

function isPathInRoot(path: string | undefined, rootFolderPath: string): boolean {
  if (path === undefined) return false;
  const windows = /^(?:[a-z]:[\\/]|\\\\)/iu.test(rootFolderPath) || rootFolderPath.includes("\\");
  if (
    windows
      ? rootFolderPath.includes("/") || path.includes("/")
      : rootFolderPath.includes("\\") || path.includes("\\")
  ) {
    return false;
  }
  const pathApi = windows ? win32 : posix;
  if (rootFolderPath.split(pathApi.sep).includes("..") || path.split(pathApi.sep).includes("..")) {
    return false;
  }
  const root = pathApi.normalize(rootFolderPath);
  const candidate = pathApi.normalize(path);
  if (pathApi.isAbsolute(root) !== pathApi.isAbsolute(candidate)) return false;
  const relative = pathApi.relative(root, candidate);
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`))
  );
}

/**
 * Classifies exact-MBID absence or the complete observable sealed add policy.
 *
 * @param entry - Reviewed foreign-ID add target.
 * @param artist - Fresh exact-MBID result, or `undefined` for absence.
 * @returns Ready absence, satisfied desired presence, or conflicting drift.
 */
export function classifyLidarrArtistAddTargetState(
  entry: LidarrArtistAddPlanEntryV2,
  artist: LidarrArtist | undefined,
): LidarrArtistAddTargetClassification {
  if (artist === undefined) return { state: "ready" };
  const mismatches = [
    ...(artist.foreignArtistId === entry.foreignArtistId ? [] : ["MusicBrainz identity"]),
    ...(artist.monitored === entry.after.monitored ? [] : ["monitored policy"]),
    ...(artist.monitorNewItems === entry.after.monitorNewItems
      ? []
      : ["new-item monitoring policy"]),
    ...(artist.qualityProfileId === entry.after.qualityProfile.id ? [] : ["quality profile"]),
    ...(artist.metadataProfileId === entry.after.metadataProfile.id ? [] : ["metadata profile"]),
    ...(isPathInRoot(artist.path, entry.after.rootFolder.path) ? [] : ["root folder"]),
  ];
  return mismatches.length === 0
    ? { state: "satisfied", artist }
    : {
        state: "drifted",
        artist,
        message: `Artist ${entry.foreignArtistId} exists with conflicting ${mismatches.join(", ")}`,
      };
}

async function readArtistAddTarget(
  args: Pick<LidarrArtistAddApplyEntryExecutionArgs, "plan" | "entry" | "client" | "signal">,
  phase: "target check" | "reconciliation",
): Promise<{
  readonly classification: LidarrArtistAddTargetClassification;
  readonly execution: LidarrExecutionMetadata;
}> {
  const read = await resolveLidarrScheduler().runSingle(
    READ_TIER,
    {
      id: `lidarr-apply-artist-add-${phase === "target check" ? "read" : "verify"}-${args.plan.id}-${args.entry.foreignArtistId}`,
      operation: `lidarr apply artist-add ${phase}`,
      idempotent: true,
      run: () => args.client.getArtistByForeignId(args.entry.foreignArtistId, args.signal),
    },
    { signal: args.signal },
  );
  return {
    classification: classifyLidarrArtistAddTargetState(args.entry, read.value),
    execution: read.execution,
  };
}

function buildFailure(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  input: {
    readonly code: LidarrPlanApplyFailureCode;
    readonly stage: LidarrPlanApplyFailureStage;
    readonly dispatchState: LidarrArtistAddPlanApplyFailure["dispatchState"];
    readonly verificationState: LidarrPlanApplyVerificationState;
    readonly retryable: boolean;
    readonly safeNextAction: LidarrArtistAddPlanApplyFailure["safeNextAction"];
  },
): LidarrArtistAddPlanApplyFailure {
  return {
    ...input,
    operation: "artist-add",
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    targetForeignArtistIds: [args.entry.foreignArtistId],
  };
}

function entryResult(
  entry: LidarrArtistAddPlanEntryV2,
  outcome: LidarrPlanApplyOutcome,
  input: {
    readonly stage?: LidarrArtistAddPlanApplyStage;
    readonly lidarrId?: number;
    readonly errorCode?: string;
    readonly message?: string;
    readonly failure?: LidarrArtistAddPlanApplyFailure;
  } = {},
): LidarrArtistAddPlanApplyEntryResult {
  const base = {
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    artistName: entry.artistName,
    outcome,
    ...(input.lidarrId === undefined ? {} : { lidarrId: input.lidarrId }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  };
  return isExtendedEntry(entry)
    ? {
        ...base,
        stage:
          input.stage ??
          (outcome === "succeeded" || outcome === "satisfied" ? "completed" : "create-pending"),
      }
    : base;
}

function terminalHistory(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  outcome: LidarrArtistAddPlanHistoryRecord["outcome"],
  errorCode?: string,
  message?: string,
): LidarrArtistAddPlanHistoryRecord {
  return {
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    entryId: args.entry.id,
    foreignArtistId: args.entry.foreignArtistId,
    recordedAt: new Date().toISOString(),
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(message === undefined ? {} : { message }),
  };
}

async function persistTerminal(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  outcome: LidarrArtistAddPlanHistoryRecord["outcome"],
  input: {
    readonly lidarrId?: number;
    readonly errorCode?: string;
    readonly message?: string;
    readonly failure?: LidarrArtistAddPlanApplyFailure;
    readonly remoteSucceeded?: boolean;
    readonly stage?: LidarrArtistAddPlanApplyStage;
    readonly historyFailureStage?: LidarrArtistAddPlanApplyStage;
  } = {},
): Promise<LidarrArtistAddApplyEntryExecutionResult> {
  try {
    await args.assertOwned();
    await args.appendHistory(
      terminalHistory(args, outcome, input.errorCode, input.message),
      args.historyPath,
    );
    return {
      result: entryResult(args.entry, outcome, input),
      execution: args.execution,
      stopAdmissions: outcome === "uncertain",
    };
  } catch (error) {
    if (input.remoteSucceeded !== true) throw error;
    return {
      result: entryResult(args.entry, "uncertain", {
        stage: input.historyFailureStage,
        lidarrId: input.lidarrId,
        errorCode: "history-write-failed",
        message: "Remote artist creation succeeded but durable history failed; resume is required",
        failure: buildFailure(args, {
          code: "history-write-failed",
          stage: "history",
          dispatchState: "dispatched",
          verificationState: "verified",
          retryable: true,
          safeNextAction: "resume-plan",
        }),
      }),
      execution: args.execution,
      stopAdmissions: true,
    };
  }
}

async function persistPossibleDispatch(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  lidarrId?: number,
): Promise<void> {
  const record: LidarrArtistAddPossibleDispatchHistoryRecord = {
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    entryId: args.entry.id,
    foreignArtistId: args.entry.foreignArtistId,
    ...(lidarrId === undefined ? {} : { lidarrId }),
    recordedAt: new Date().toISOString(),
    outcome: "possibly-dispatched",
    idempotencyKey: args.entry.idempotencyKey,
  };
  await args.appendHistory(record, args.historyPath);
}

function normalizationPendingRecord(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  lidarrId: number,
): LidarrArtistAddNormalizationPendingHistoryRecord {
  return {
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    entryId: args.entry.id,
    foreignArtistId: args.entry.foreignArtistId,
    lidarrId,
    recordedAt: new Date().toISOString(),
    outcome: "creation-verified-normalization-pending",
    idempotencyKey: args.entry.idempotencyKey,
  };
}

function normalizationVerificationPendingRecord(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  lidarrId: number,
  albumIds: readonly number[],
): LidarrArtistAddNormalizationVerificationPendingHistoryRecord {
  return {
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    entryId: args.entry.id,
    foreignArtistId: args.entry.foreignArtistId,
    lidarrId,
    recordedAt: new Date().toISOString(),
    outcome: "normalization-verification-pending",
    albumIds,
    idempotencyKey: args.entry.idempotencyKey,
  };
}

function normalizationIncomplete(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  execution: LidarrExecutionMetadata,
  lidarrId: number,
  stage: Extract<
    LidarrArtistAddPlanApplyStage,
    "creation-verified-normalization-pending" | "normalization-verification-pending"
  >,
  input: {
    readonly code: LidarrPlanApplyFailureCode;
    readonly failureStage: LidarrPlanApplyFailureStage;
    readonly message: string;
    readonly verificationState: LidarrPlanApplyVerificationState;
    readonly dispatchState?: LidarrArtistAddPlanApplyFailure["dispatchState"];
  },
): LidarrArtistAddApplyEntryExecutionResult {
  return {
    result: entryResult(args.entry, "uncertain", {
      stage,
      lidarrId,
      errorCode: input.code,
      message: input.message,
      failure: buildFailure(args, {
        code: input.code,
        stage: input.failureStage,
        dispatchState: input.dispatchState ?? "dispatched",
        verificationState: input.verificationState,
        retryable: true,
        safeNextAction: "resume-plan",
      }),
    }),
    execution,
    stopAdmissions: true,
  };
}

async function readArtistAlbums(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  lidarrId: number,
  phase: "normalize" | "verify",
): Promise<{
  readonly albums: Awaited<
    ReturnType<LidarrArtistAddApplyEntryExecutionArgs["client"]["listAlbums"]>
  >;
  readonly execution: LidarrExecutionMetadata;
}> {
  const read = await resolveLidarrScheduler().runSingle(
    READ_TIER,
    {
      id: `lidarr-apply-artist-add-albums-${phase}-${args.plan.id}-${args.entry.foreignArtistId}`,
      operation: `lidarr apply artist-add album ${phase}`,
      idempotent: true,
      run: () => args.client.listAlbums({ artistId: lidarrId, signal: args.signal }),
    },
    { signal: args.signal },
  );
  return { albums: read.value, execution: read.execution };
}

function invalidArtistScopedAlbums(
  albums: Awaited<ReturnType<LidarrArtistAddApplyEntryExecutionArgs["client"]["listAlbums"]>>,
  lidarrId: number,
): string | undefined {
  if (albums.length > LIDARR_PLAN_MAX_ENTRIES) {
    return `Artist-scoped album response exceeds the ${LIDARR_PLAN_MAX_ENTRIES}-album safety bound`;
  }
  const albumIds = albums.map((album) => album.id);
  if (
    albumIds.some((albumId) => !Number.isSafeInteger(albumId) || albumId <= 0) ||
    new Set(albumIds).size !== albumIds.length
  ) {
    return "Artist-scoped album response must contain unique positive album IDs";
  }
  if (albums.some((album) => album.artistId !== lidarrId)) {
    return `Artist-scoped album response contains an album outside Lidarr artist ${lidarrId}`;
  }
  return undefined;
}

async function normalizeExtendedArtist(
  args: LidarrArtistAddApplyEntryExecutionArgs & {
    readonly entry: LidarrArtistAddExtendedPlanEntryV2;
  },
  execution: LidarrExecutionMetadata,
  lidarrId: number,
  outcome: "succeeded" | "satisfied",
  message?: string,
): Promise<LidarrArtistAddApplyEntryExecutionResult> {
  if (args.entry.after.postAddUnmonitorSelectors.length === 0) {
    const persisted = await persistTerminal({ ...args, execution }, outcome, {
      stage: "completed",
      lidarrId,
      message,
      remoteSucceeded: true,
    });
    return { ...persisted, execution };
  }
  const selectors = parseAlbumTypeSelectors(args.entry.after.postAddUnmonitorSelectors.join(","));

  try {
    await args.assertOwned();
    await args.appendHistory(normalizationPendingRecord(args, lidarrId), args.historyPath);
  } catch (error) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      "creation-verified-normalization-pending",
      {
        code: "history-write-failed",
        failureStage: "history",
        message: safeLidarrApplyErrorMessage(
          error,
          "Artist creation was verified but normalization progress could not be persisted",
        ),
        verificationState: "not-started",
      },
    );
  }

  let current: Awaited<ReturnType<typeof readArtistAlbums>>;
  try {
    current = await readArtistAlbums(args, lidarrId, "normalize");
  } catch (error) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      "creation-verified-normalization-pending",
      {
        code: isLidarrApplyAbortError(error, args.signal)
          ? "post-dispatch-cancelled"
          : "verification-inconclusive",
        failureStage: "verification",
        message: safeLidarrApplyErrorMessage(
          error,
          "Artist creation was verified but artist-scoped albums could not be read",
        ),
        verificationState: "inconclusive",
      },
    );
  }

  execution = current.execution;
  const currentAlbumError = invalidArtistScopedAlbums(current.albums, lidarrId);
  if (currentAlbumError !== undefined) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      "creation-verified-normalization-pending",
      {
        code: "verification-failed",
        failureStage: "verification",
        message: currentAlbumError,
        verificationState: "failed",
      },
    );
  }
  if (current.albums.length === 0) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      "creation-verified-normalization-pending",
      {
        code: "verification-inconclusive",
        failureStage: "verification",
        message:
          "Artist creation was verified but Lidarr has not populated artist-scoped albums; resume is required",
        verificationState: "inconclusive",
      },
    );
  }

  const monitoredIds = current.albums
    .filter((album) => album.monitored && matchesAlbumTypeSelectors(album, selectors))
    .map((album) => album.id)
    .sort((left, right) => left - right);

  for (let index = 0; index < monitoredIds.length; index += LIDARR_ALBUM_IDS_CHUNK_SIZE) {
    const albumIds = monitoredIds.slice(index, index + LIDARR_ALBUM_IDS_CHUNK_SIZE);
    try {
      await args.assertOwned();
      await args.appendHistory(
        normalizationVerificationPendingRecord(args, lidarrId, albumIds),
        args.historyPath,
      );
    } catch (error) {
      return normalizationIncomplete(
        args,
        execution,
        lidarrId,
        "creation-verified-normalization-pending",
        {
          code: "history-write-failed",
          failureStage: "history",
          message: safeLidarrApplyErrorMessage(
            error,
            "Normalization verification evidence could not be persisted before album mutation",
          ),
          verificationState: "not-started",
        },
      );
    }

    try {
      const updated = await resolveLidarrScheduler().runSingle(
        DISPATCH_TIER,
        {
          id: `lidarr-apply-artist-add-albums-update-${args.plan.id}-${args.entry.foreignArtistId}-${index / LIDARR_ALBUM_IDS_CHUNK_SIZE}`,
          operation: "lidarr apply artist-add album normalization",
          idempotent: false,
          run: () => args.client.setAlbumsMonitored(albumIds, false, args.signal),
        },
        { signal: args.signal, preflight: args.preflight },
      );
      execution = updated.execution;
    } catch (error) {
      const failedExecution = readLidarrExecutionMetadata(error) ?? execution;
      return normalizationIncomplete(
        args,
        failedExecution,
        lidarrId,
        "normalization-verification-pending",
        {
          code: isLidarrApplyAbortError(error, args.signal)
            ? "post-dispatch-cancelled"
            : "verification-inconclusive",
          failureStage: "verification",
          message: safeLidarrApplyErrorMessage(
            error,
            "Album normalization may have been dispatched and requires fresh verification",
          ),
          verificationState: "inconclusive",
          dispatchState: "dispatch-unknown",
        },
      );
    }
  }

  let verified: Awaited<ReturnType<typeof readArtistAlbums>>;
  try {
    verified = await readArtistAlbums(args, lidarrId, "verify");
  } catch (error) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      monitoredIds.length === 0
        ? "creation-verified-normalization-pending"
        : "normalization-verification-pending",
      {
        code: isLidarrApplyAbortError(error, args.signal)
          ? "post-dispatch-cancelled"
          : "verification-inconclusive",
        failureStage: "verification",
        message: safeLidarrApplyErrorMessage(
          error,
          "Album normalization could not be verified by a fresh artist-scoped read",
        ),
        verificationState: "inconclusive",
      },
    );
  }
  execution = verified.execution;
  const verifiedAlbumError = invalidArtistScopedAlbums(verified.albums, lidarrId);
  if (verifiedAlbumError !== undefined) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      monitoredIds.length === 0
        ? "creation-verified-normalization-pending"
        : "normalization-verification-pending",
      {
        code: "verification-failed",
        failureStage: "verification",
        message: verifiedAlbumError,
        verificationState: "failed",
      },
    );
  }
  if (verified.albums.length === 0) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      monitoredIds.length === 0
        ? "creation-verified-normalization-pending"
        : "normalization-verification-pending",
      {
        code: "verification-inconclusive",
        failureStage: "verification",
        message:
          "Artist-scoped albums were empty during normalization verification; resume is required",
        verificationState: "inconclusive",
      },
    );
  }
  const remaining = verified.albums.filter(
    (album) => album.monitored && matchesAlbumTypeSelectors(album, selectors),
  );
  if (remaining.length > 0) {
    return normalizationIncomplete(
      args,
      execution,
      lidarrId,
      "normalization-verification-pending",
      {
        code: "verification-failed",
        failureStage: "verification",
        message: `${remaining.length} matching album(s) remain monitored after normalization`,
        verificationState: "failed",
      },
    );
  }

  const persisted = await persistTerminal({ ...args, execution }, outcome, {
    stage: "completed",
    historyFailureStage:
      monitoredIds.length === 0
        ? "creation-verified-normalization-pending"
        : "normalization-verification-pending",
    lidarrId,
    message,
    remoteSucceeded: true,
  });
  return { ...persisted, execution };
}

function preDispatchFailureResult(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  code: LidarrPlanApplyFailureCode,
  message: string,
  stage: LidarrPlanApplyFailureStage,
  dispatchState: LidarrArtistAddPlanApplyFailure["dispatchState"],
  verificationState: LidarrPlanApplyVerificationState,
  lidarrId?: number,
): LidarrArtistAddPlanApplyEntryResult {
  return entryResult(args.entry, "failed", {
    lidarrId,
    errorCode: code,
    message,
    failure: buildFailure(args, {
      code,
      stage,
      dispatchState,
      verificationState,
      retryable: true,
      safeNextAction: "resume-plan",
    }),
  });
}

async function reconcileAfterPossibleDispatch(
  args: LidarrArtistAddApplyEntryExecutionArgs,
  execution: LidarrExecutionMetadata,
  dispatchError: unknown,
  resumed: boolean,
  expectedLidarrId?: number,
): Promise<LidarrArtistAddApplyEntryExecutionResult> {
  const normalizationHistory = args.resumeNormalizationHistory;
  let read: Awaited<ReturnType<typeof readArtistAddTarget>>;
  try {
    read = await readArtistAddTarget(args, "reconciliation");
  } catch (error) {
    const failedExecution = readLidarrExecutionMetadata(error) ?? execution;
    const code = isLidarrApplyAbortError(dispatchError ?? error, args.signal)
      ? "post-dispatch-cancelled"
      : "verification-inconclusive";
    const message = safeLidarrApplyErrorMessage(
      dispatchError ?? error,
      "Artist creation state remained inconclusive after exact-MBID reconciliation",
    );
    if (normalizationHistory !== undefined) {
      return normalizationIncomplete(
        args,
        failedExecution,
        normalizationHistory.lidarrId,
        normalizationHistory.outcome,
        {
          code,
          failureStage: "resume",
          message,
          verificationState: "inconclusive",
          dispatchState:
            normalizationHistory.outcome === "normalization-verification-pending"
              ? "dispatch-unknown"
              : "dispatched",
        },
      );
    }
    const persisted = await persistTerminal({ ...args, execution: failedExecution }, "uncertain", {
      errorCode: code,
      message,
      failure: buildFailure(args, {
        code,
        stage: resumed ? "resume" : "verification",
        dispatchState: "dispatch-unknown",
        verificationState: "inconclusive",
        retryable: true,
        safeNextAction: "resume-plan",
      }),
      remoteSucceeded: true,
    });
    return { ...persisted, execution: failedExecution };
  }

  if (read.classification.state === "satisfied") {
    if (expectedLidarrId !== undefined && read.classification.artist.id !== expectedLidarrId) {
      const message =
        `Artist ${args.entry.foreignArtistId} now resolves to Lidarr artist ` +
        `${read.classification.artist.id}, not durable artist ${expectedLidarrId}`;
      if (normalizationHistory !== undefined) {
        return normalizationIncomplete(
          args,
          read.execution,
          normalizationHistory.lidarrId,
          normalizationHistory.outcome,
          {
            code: "artist-state-drift",
            failureStage: "resume",
            message,
            verificationState: "failed",
            dispatchState:
              normalizationHistory.outcome === "normalization-verification-pending"
                ? "dispatch-unknown"
                : "dispatched",
          },
        );
      }
      return {
        result: entryResult(args.entry, "uncertain", {
          stage: "create-pending",
          lidarrId: expectedLidarrId,
          errorCode: "artist-state-drift",
          message,
          failure: buildFailure(args, {
            code: "artist-state-drift",
            stage: resumed ? "resume" : "verification",
            dispatchState: "dispatched",
            verificationState: "failed",
            retryable: true,
            safeNextAction: "resume-plan",
          }),
        }),
        execution: read.execution,
        stopAdmissions: true,
      };
    }
    if (
      normalizationHistory !== undefined &&
      read.classification.artist.id !== normalizationHistory.lidarrId
    ) {
      return normalizationIncomplete(
        args,
        read.execution,
        normalizationHistory.lidarrId,
        normalizationHistory.outcome,
        {
          code: "artist-state-drift",
          failureStage: "resume",
          message:
            `Artist ${args.entry.foreignArtistId} now resolves to Lidarr artist ` +
            `${read.classification.artist.id}, not durable artist ${normalizationHistory.lidarrId}`,
          verificationState: "failed",
          dispatchState:
            normalizationHistory.outcome === "normalization-verification-pending"
              ? "dispatch-unknown"
              : "dispatched",
        },
      );
    }
    if (
      isExtendedEntry(args.entry) &&
      expectedLidarrId === undefined &&
      normalizationHistory === undefined
    ) {
      const message =
        "Artist creation may have succeeded, but durable history does not identify the created " +
        "Lidarr artist; album normalization is blocked";
      return {
        result: entryResult(args.entry, "uncertain", {
          stage: "create-pending",
          errorCode: "verification-inconclusive",
          message,
          failure: buildFailure(args, {
            code: "verification-inconclusive",
            stage: resumed ? "resume" : "verification",
            dispatchState: "dispatch-unknown",
            verificationState: "inconclusive",
            retryable: false,
            safeNextAction: "review-staleness-and-replan",
          }),
        }),
        execution: read.execution,
        stopAdmissions: true,
      };
    }
    const message =
      dispatchError === undefined
        ? undefined
        : `Artist-create response was lost but exact-MBID reconciliation confirmed success: ${safeLidarrApplyErrorMessage(
            dispatchError,
            "dispatch outcome was ambiguous",
          )}`;
    if (isExtendedEntry(args.entry)) {
      return normalizeExtendedArtist(
        { ...args, entry: args.entry },
        read.execution,
        read.classification.artist.id,
        resumed ? "satisfied" : "succeeded",
        message,
      );
    }
    const persisted = await persistTerminal(
      { ...args, execution: read.execution },
      resumed ? "satisfied" : "succeeded",
      {
        lidarrId: read.classification.artist.id,
        message,
        remoteSucceeded: true,
      },
    );
    return { ...persisted, execution: read.execution };
  }

  const message =
    read.classification.state === "drifted"
      ? read.classification.message
      : `Artist ${args.entry.foreignArtistId} is still absent after a possibly dispatched create`;
  const code = "verification-inconclusive";
  if (normalizationHistory !== undefined) {
    return normalizationIncomplete(
      args,
      read.execution,
      normalizationHistory.lidarrId,
      normalizationHistory.outcome,
      {
        code:
          read.classification.state === "drifted"
            ? "artist-state-drift"
            : "verification-inconclusive",
        failureStage: "resume",
        message,
        verificationState: read.classification.state === "drifted" ? "failed" : "inconclusive",
        dispatchState:
          normalizationHistory.outcome === "normalization-verification-pending"
            ? "dispatch-unknown"
            : "dispatched",
      },
    );
  }
  const persisted = await persistTerminal({ ...args, execution: read.execution }, "uncertain", {
    errorCode: code,
    message,
    failure: buildFailure(args, {
      code,
      stage: resumed ? "resume" : "verification",
      dispatchState: "dispatch-unknown",
      verificationState: "inconclusive",
      retryable: true,
      safeNextAction: "resume-plan",
    }),
    remoteSucceeded: true,
  });
  return { ...persisted, execution: read.execution };
}

/**
 * Revalidates, dispatches at most once, and reconciles one artist-add entry.
 *
 * @param args - Sealed add plan, exact target, history boundary, claim guard,
 *   client, and resume attribution.
 * @returns One durable result plus the latest scheduler execution metadata.
 */
export async function executeLidarrArtistAddApplyEntry(
  args: LidarrArtistAddApplyEntryExecutionArgs,
): Promise<LidarrArtistAddApplyEntryExecutionResult> {
  args.signal?.throwIfAborted();
  if (args.resumePossibleDispatch || args.resumeNormalizationHistory !== undefined) {
    return reconcileAfterPossibleDispatch(
      args,
      args.execution,
      undefined,
      true,
      args.resumeNormalizationHistory?.lidarrId ?? args.resumePossibleDispatchLidarrId,
    );
  }

  let live: Awaited<ReturnType<typeof readArtistAddTarget>>;
  try {
    live = await readArtistAddTarget(args, "target check");
  } catch (error) {
    if (isLidarrApplyAbortError(error, args.signal)) throw error;
    const message = safeLidarrApplyErrorMessage(
      error,
      "Artist-add target state could not be established",
    );
    const persisted = await persistTerminal(args, "failed", {
      errorCode: "target-read-failed",
      message,
      failure: buildFailure(args, {
        code: "target-read-failed",
        stage: "admission",
        dispatchState: "not-dispatched",
        verificationState: "not-started",
        retryable: false,
        safeNextAction: "review-failure-and-resume",
      }),
    });
    return persisted;
  }

  if (live.classification.state === "satisfied") {
    const persisted = await persistTerminal({ ...args, execution: live.execution }, "satisfied", {
      lidarrId: live.classification.artist.id,
    });
    return { ...persisted, execution: live.execution };
  }
  if (live.classification.state === "drifted") {
    return {
      result: entryResult(args.entry, "blocked-stale", {
        lidarrId: live.classification.artist.id,
        errorCode: "artist-state-drift",
        message: live.classification.message,
        failure: buildFailure(args, {
          code: "artist-state-drift",
          stage: "admission",
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          retryable: false,
          safeNextAction: "review-staleness-and-replan",
        }),
      }),
      execution: live.execution,
      stopAdmissions: true,
    };
  }

  let execution = live.execution;
  let markerPersisted = false;
  const dispatchBoundary: {
    phase: "prepare" | "claim" | "history" | "dispatch" | "identity-history";
  } = { phase: "prepare" };
  let dispatchError: unknown;
  let createdLidarrId: number | undefined;
  try {
    const dispatched = await resolveLidarrScheduler().runSingle(
      DISPATCH_TIER,
      {
        id: `lidarr-apply-artist-add-${args.plan.id}-${args.entry.foreignArtistId}`,
        operation: "lidarr apply artist-add",
        idempotent: false,
        run: async ({ signal }) => {
          const prepared = await args.client.prepareArtistAdd(
            {
              artistName: args.entry.artistName,
              foreignArtistId: args.entry.foreignArtistId,
              rootFolderPath: args.entry.after.rootFolder.path,
              qualityProfileId: args.entry.after.qualityProfile.id,
              metadataProfileId: args.entry.after.metadataProfile.id,
              monitored: args.entry.after.monitored,
              monitorNewItems: "none",
              searchForMissingAlbums: false,
            },
            signal,
          );
          signal?.throwIfAborted();
          dispatchBoundary.phase = "claim";
          await args.assertOwned();
          dispatchBoundary.phase = "history";
          await persistPossibleDispatch(args);
          markerPersisted = true;
          dispatchBoundary.phase = "dispatch";
          // Once the durable marker exists, cancellation can no longer safely
          // prevent request initiation. Reconciliation owns any ambiguity.
          const created = await args.client.addArtist(prepared);
          createdLidarrId = created.id;
          dispatchBoundary.phase = "identity-history";
          await persistPossibleDispatch(args, createdLidarrId);
          return created;
        },
      },
      { signal: args.signal, preflight: args.preflight },
    );
    execution = dispatched.execution;
  } catch (error) {
    execution = readLidarrExecutionMetadata(error) ?? execution;
    if (dispatchBoundary.phase === "identity-history") {
      return {
        result: entryResult(args.entry, "uncertain", {
          stage: "create-pending",
          lidarrId: createdLidarrId,
          errorCode: "history-write-failed",
          message: safeLidarrApplyErrorMessage(
            error,
            "Artist creation succeeded but its returned Lidarr identity could not be persisted",
          ),
          failure: buildFailure(args, {
            code: "history-write-failed",
            stage: "history",
            dispatchState: "dispatched",
            verificationState: "not-started",
            retryable: true,
            safeNextAction: "resume-plan",
          }),
        }),
        execution,
        stopAdmissions: true,
      };
    } else if (markerPersisted) {
      dispatchError = error;
    } else if (isLidarrApplyAbortError(error, args.signal)) {
      throw error;
    } else if (dispatchBoundary.phase === "history") {
      return {
        result: preDispatchFailureResult(
          args,
          "history-write-failed",
          safeLidarrApplyErrorMessage(
            error,
            "Durable artist-add possible-dispatch evidence could not be established",
          ),
          "history",
          "not-dispatched",
          "not-started",
        ),
        execution,
        stopAdmissions: true,
      };
    } else {
      const message = safeLidarrApplyErrorMessage(
        error,
        dispatchBoundary.phase === "claim"
          ? "Exclusive artist-add claim was lost before dispatch"
          : "Artist-add health or authoritative identity could not be established",
      );
      try {
        return await persistTerminal({ ...args, execution }, "failed", {
          errorCode: "target-read-failed",
          message,
          failure: buildFailure(args, {
            code: "target-read-failed",
            stage: "admission",
            dispatchState: "not-dispatched",
            verificationState: "not-started",
            retryable: true,
            safeNextAction: "review-failure-and-resume",
          }),
        });
      } catch {
        return {
          result: preDispatchFailureResult(
            args,
            "target-read-failed",
            message,
            "admission",
            "not-dispatched",
            "not-started",
          ),
          execution,
          stopAdmissions: true,
        };
      }
    }
  }

  return reconcileAfterPossibleDispatch(args, execution, dispatchError, false, createdLidarrId);
}
