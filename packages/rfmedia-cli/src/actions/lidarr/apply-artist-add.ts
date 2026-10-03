/** Whole-plan orchestration for the bounded, non-idempotent artist-add lane. */

import { logWarn } from "../../lib/logger.js";
import type { LidarrExecutionContext } from "../../lib/lidarr/index.js";
import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import {
  appendLidarrPlanHistory,
  findLidarrArtistAddPossibleDispatchEvidence,
  isLidarrArtistAddNormalizationPendingHistoryRecord,
  isLidarrArtistAddNormalizationVerificationPendingHistoryRecord,
  readLidarrPlanHistory,
  selectLidarrResumeEntries,
} from "../../lib/lidarr/plan-engine.js";
import { getLidarrArtistAddOperationDefinition } from "../../lib/lidarr/plan-operation-definitions.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import type {
  LidarrApplyScanResult,
  LidarrArtistAddNormalizationPendingHistoryRecord,
  LidarrArtistAddNormalizationVerificationPendingHistoryRecord,
  LidarrArtistAddPlanApplyEntryResult,
  LidarrArtistAddPlanEntryV2,
  LidarrArtistAddPlanV2,
  LidarrArtistAddPlanV3,
  LidarrPlanApplyResult,
  LidarrPlanHistoryRecord,
} from "../../types/lidarr-plan.js";
import {
  classifyLidarrArtistAddTargetState,
  type LidarrArtistAddTargetClassification,
} from "./apply-artist-add-entry-execution.js";
import {
  collectLidarrApplyResourceReferences,
  preflightLidarrApplyResources,
} from "./apply-resources.js";
import { executeLidarrApplyEntry } from "./apply-entry-execution.js";

interface ArtistAddPreflight {
  readonly classification: LidarrArtistAddTargetClassification;
  readonly execution: LidarrExecutionMetadata;
}

type ArtistAddNormalizationHistoryRecord =
  | LidarrArtistAddNormalizationPendingHistoryRecord
  | LidarrArtistAddNormalizationVerificationPendingHistoryRecord;

type LidarrSpecializedApplyResult = Omit<LidarrPlanApplyResult, "cascadeAnalysis">;
type LidarrArtistAddPlan = LidarrArtistAddPlanV2 | LidarrArtistAddPlanV3;

export interface ExecuteLidarrArtistAddApplyArgs {
  readonly plan: LidarrArtistAddPlan;
  readonly planPath: string;
  readonly context: LidarrExecutionContext;
  readonly dryRun: boolean;
  readonly resumed: boolean;
  readonly historyPath?: string;
  readonly signal: AbortSignal;
  readonly activateClaim: () => Promise<() => Promise<void>>;
  readonly resolveScan: (dryRun: boolean) => Promise<LidarrApplyScanResult | undefined>;
}

async function readArtistTarget(
  args: Pick<ExecuteLidarrArtistAddApplyArgs, "plan" | "context" | "signal">,
  entry: LidarrArtistAddPlanEntryV2,
): Promise<ArtistAddPreflight> {
  const read = await resolveLidarrScheduler().runSingle(
    "local-only",
    {
      id: `lidarr-apply-artist-add-preflight-${args.plan.id}-${entry.foreignArtistId}`,
      operation: "lidarr apply artist-add preflight",
      idempotent: true,
      run: () => args.context.client.getArtistByForeignId(entry.foreignArtistId, args.signal),
    },
    { signal: args.signal },
  );
  return {
    classification: classifyLidarrArtistAddTargetState(entry, read.value),
    execution: read.execution,
  };
}

async function preflightFreshArtistAddResources(
  args: Pick<ExecuteLidarrArtistAddApplyArgs, "plan" | "planPath" | "context" | "signal">,
): Promise<void> {
  const definition = getLidarrArtistAddOperationDefinition(args.plan.operation);
  const resourcePreflight = await preflightLidarrApplyResources({
    planId: args.plan.id,
    references: collectLidarrApplyResourceReferences(args.plan, definition.referencedResources()),
    client: args.context.client,
    signal: args.signal,
  });
  const resourceFindings = [
    ...resourcePreflight.missing.map((reference) => {
      const label =
        reference.kind === "tag"
          ? reference.label
          : reference.kind === "root-folder"
            ? reference.path
            : reference.name;
      return `${reference.kind} ${reference.id} (${label}) no longer exists`;
    }),
    ...resourcePreflight.drifted.map((finding) => finding.message),
  ];
  if (resourceFindings.length > 0) {
    throw new LidarrPlanValidationError(
      `artist-add plan is stale: ${resourceFindings.join("; ")}`,
      args.planPath,
    );
  }
  resourcePreflight.resources.warnings.forEach((warning) => logWarn(warning));
}

async function preflightFreshArtistAddEntry(
  args: Pick<ExecuteLidarrArtistAddApplyArgs, "plan" | "planPath" | "context" | "signal">,
  entry: LidarrArtistAddPlanEntryV2,
): Promise<ArtistAddPreflight> {
  const target = await readArtistTarget(args, entry);
  if (target.classification.state === "drifted") {
    throw new LidarrPlanValidationError(
      `artist-add plan is stale: ${target.classification.message}`,
      args.planPath,
    );
  }
  return target;
}

function summary(total: number, entries: readonly LidarrArtistAddPlanApplyEntryResult[]) {
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

function status(
  entries: readonly LidarrArtistAddPlanApplyEntryResult[],
): LidarrPlanApplyResult["status"] {
  if (
    entries.some(
      (entry) =>
        "stage" in entry &&
        (entry.stage === "creation-verified-normalization-pending" ||
          entry.stage === "normalization-verification-pending"),
    )
  ) {
    return "partial";
  }
  const failed = entries.filter((entry) =>
    ["failed", "deferred", "uncertain", "blocked-stale", "not-attempted"].includes(entry.outcome),
  ).length;
  if (failed === 0) return "completed";
  return failed === entries.length ? "failed" : "partial";
}

function pendingResumeExecution(plan: LidarrArtistAddPlan): LidarrExecutionMetadata {
  return {
    taskId: `lidarr-apply-artist-add-resume-${plan.id}`,
    operation: "lidarr apply artist-add reconciliation",
    lane: "local-only",
    outcome: "failed",
    attempts: 0,
    failureType: "unknown",
  };
}

function completedResumeExecution(plan: LidarrArtistAddPlan): LidarrExecutionMetadata {
  return {
    taskId: `lidarr-apply-artist-add-resume-${plan.id}`,
    operation: "lidarr apply artist-add reconciliation",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 0,
  };
}

function skippedResumeResult(
  entry: LidarrArtistAddPlanEntryV2,
): LidarrArtistAddPlanApplyEntryResult {
  return {
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    artistName: entry.artistName,
    outcome: "skipped-resume",
    ...("postAddUnmonitorSelectors" in entry.after ? { stage: "completed" as const } : {}),
  };
}

function notAttemptedResult(
  plan: LidarrArtistAddPlan,
  entry: LidarrArtistAddPlanEntryV2,
  safeNextAction: "resume-plan" | "review-failure-and-resume" | "review-staleness-and-replan",
): LidarrArtistAddPlanApplyEntryResult {
  return {
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    artistName: entry.artistName,
    outcome: "not-attempted",
    ...("postAddUnmonitorSelectors" in entry.after ? { stage: "create-pending" as const } : {}),
    errorCode: "admission-stopped",
    message: "Not attempted after apply stopped",
    failure: {
      code: "admission-stopped",
      stage: "admission",
      operation: "artist-add",
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      targetForeignArtistIds: [entry.foreignArtistId],
      dispatchState: "not-dispatched",
      verificationState: "not-started",
      retryable: true,
      safeNextAction,
    },
  };
}

function possibleDispatchDryRunResult(
  args: ExecuteLidarrArtistAddApplyArgs,
  entry: LidarrArtistAddPlanEntryV2,
  preflight: ArtistAddPreflight,
): LidarrArtistAddPlanApplyEntryResult {
  if (preflight.classification.state === "satisfied") {
    return {
      entryId: entry.id,
      foreignArtistId: entry.foreignArtistId,
      artistName: entry.artistName,
      outcome: "satisfied",
      lidarrId: preflight.classification.artist.id,
      ...("postAddUnmonitorSelectors" in entry.after ? { stage: "completed" as const } : {}),
    };
  }
  const message =
    preflight.classification.state === "drifted"
      ? preflight.classification.message
      : `Artist ${entry.foreignArtistId} remains absent after a possibly dispatched create; refusing automatic resend`;
  return {
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    artistName: entry.artistName,
    outcome: "uncertain",
    ...("postAddUnmonitorSelectors" in entry.after ? { stage: "create-pending" as const } : {}),
    ...(preflight.classification.artist === undefined
      ? {}
      : { lidarrId: preflight.classification.artist.id }),
    errorCode: "possible-dispatch-pending",
    message,
    failure: {
      code: "possible-dispatch-pending",
      stage: "resume",
      operation: "artist-add",
      planId: args.plan.id,
      planChecksum: args.plan.payloadChecksum,
      targetForeignArtistIds: [entry.foreignArtistId],
      dispatchState: "dispatch-unknown",
      verificationState: "inconclusive",
      retryable: true,
      safeNextAction: "resume-plan",
    },
  };
}

function freshDryRunResult(
  entry: LidarrArtistAddPlanEntryV2,
  preflight: ArtistAddPreflight,
): LidarrArtistAddPlanApplyEntryResult {
  if (preflight.classification.state === "satisfied") {
    return {
      entryId: entry.id,
      foreignArtistId: entry.foreignArtistId,
      artistName: entry.artistName,
      outcome: "satisfied",
      lidarrId: preflight.classification.artist.id,
      ...("postAddUnmonitorSelectors" in entry.after ? { stage: "completed" as const } : {}),
    };
  }
  return {
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    artistName: entry.artistName,
    outcome: "would-apply",
    ...("postAddUnmonitorSelectors" in entry.after ? { stage: "create-pending" as const } : {}),
  };
}

function latestNormalizationHistory(
  history: readonly LidarrPlanHistoryRecord[],
): ReadonlyMap<string, ArtistAddNormalizationHistoryRecord> {
  const latest = new Map<string, LidarrPlanHistoryRecord>();
  for (const record of history) latest.set(record.entryId, record);
  const normalization = new Map<string, ArtistAddNormalizationHistoryRecord>();
  for (const [entryId, record] of latest) {
    if (
      isLidarrArtistAddNormalizationPendingHistoryRecord(record) ||
      isLidarrArtistAddNormalizationVerificationPendingHistoryRecord(record)
    ) {
      normalization.set(entryId, record);
    }
  }
  return normalization;
}

function normalizationDryRunResult(
  args: ExecuteLidarrArtistAddApplyArgs,
  entry: LidarrArtistAddPlanEntryV2,
  preflight: ArtistAddPreflight,
  history: ArtistAddNormalizationHistoryRecord,
): LidarrArtistAddPlanApplyEntryResult {
  const artist =
    preflight.classification.state === "ready" ? undefined : preflight.classification.artist;
  const message =
    preflight.classification.state === "satisfied"
      ? "Artist creation is verified; reviewed album normalization remains pending"
      : preflight.classification.state === "drifted"
        ? preflight.classification.message
        : `Artist ${entry.foreignArtistId} is absent despite verified creation history; resume must reconcile before any resend`;
  return {
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    artistName: entry.artistName,
    outcome: "uncertain",
    stage: history.outcome,
    lidarrId: artist?.id ?? history.lidarrId,
    errorCode:
      preflight.classification.state === "satisfied"
        ? "verification-inconclusive"
        : "possible-dispatch-pending",
    message,
    failure: {
      code:
        preflight.classification.state === "satisfied"
          ? "verification-inconclusive"
          : "possible-dispatch-pending",
      stage: "resume",
      operation: "artist-add",
      planId: args.plan.id,
      planChecksum: args.plan.payloadChecksum,
      targetForeignArtistIds: [entry.foreignArtistId],
      dispatchState:
        history.outcome === "normalization-verification-pending"
          ? "dispatch-unknown"
          : "dispatched",
      verificationState: "inconclusive",
      retryable: true,
      safeNextAction: "resume-plan",
    },
  };
}

function orderedEntryResults(
  plan: LidarrArtistAddPlan,
  pendingEntryIds: ReadonlySet<string>,
  appliedResults: ReadonlyMap<string, LidarrArtistAddPlanApplyEntryResult>,
  admissionStop?: {
    readonly safeNextAction:
      | "resume-plan"
      | "review-failure-and-resume"
      | "review-staleness-and-replan";
  },
): LidarrArtistAddPlanApplyEntryResult[] {
  return plan.entries.map((entry) => {
    const result = appliedResults.get(entry.id);
    if (result !== undefined) return result;
    if (!pendingEntryIds.has(entry.id)) return skippedResumeResult(entry);
    if (admissionStop !== undefined) {
      return notAttemptedResult(plan, entry, admissionStop.safeNextAction);
    }
    throw new Error(`Missing artist-add apply result for ${entry.id}`);
  });
}

/** Executes the complete artist-add history, admission, claim, dispatch, and result workflow. */
export async function executeLidarrArtistAddApply(
  args: ExecuteLidarrArtistAddApplyArgs,
): Promise<LidarrSpecializedApplyResult> {
  const history = await readLidarrPlanHistory(
    args.plan.id,
    args.plan.payloadChecksum,
    args.historyPath,
  );
  if (history.length > 0 && !args.resumed) {
    throw new LidarrPlanValidationError(
      "this plan has prior history; use --resume to continue safely",
      args.planPath,
    );
  }
  const pending = args.resumed
    ? selectLidarrResumeEntries(args.plan, history)
    : [...args.plan.entries];
  const pendingEntryIds = new Set(pending.map((entry) => entry.id));
  const normalizationHistoryByEntry = latestNormalizationHistory(history);
  const possibleDispatchHistoryByEntry = new Map(
    args.resumed
      ? pending
          .map(
            (entry) =>
              [
                entry.id,
                findLidarrArtistAddPossibleDispatchEvidence(args.plan, entry, history),
              ] as const,
          )
          .filter(
            (candidate): candidate is readonly [string, NonNullable<(typeof candidate)[1]>] =>
              candidate[1] !== undefined,
          )
      : [],
  );
  const resumableEntryIds = new Set([
    ...possibleDispatchHistoryByEntry.keys(),
    ...normalizationHistoryByEntry.keys(),
  ]);
  const appliedResults = new Map<string, LidarrArtistAddPlanApplyEntryResult>();
  let execution =
    pending.length === 0 ? completedResumeExecution(args.plan) : pendingResumeExecution(args.plan);
  let admissionStop:
    | {
        readonly safeNextAction:
          | "resume-plan"
          | "review-failure-and-resume"
          | "review-staleness-and-replan";
      }
    | undefined;

  if (args.dryRun) {
    let freshResourcesPreflighted = false;
    for (const entry of pending) {
      const normalizationHistory = normalizationHistoryByEntry.get(entry.id);
      const resumable = resumableEntryIds.has(entry.id);
      if (!resumable && !freshResourcesPreflighted) {
        await preflightFreshArtistAddResources(args);
        freshResourcesPreflighted = true;
      }
      const preflight = resumable
        ? await readArtistTarget(args, entry)
        : await preflightFreshArtistAddEntry(args, entry);
      execution = preflight.execution;
      const result =
        normalizationHistory !== undefined
          ? normalizationDryRunResult(args, entry, preflight, normalizationHistory)
          : possibleDispatchHistoryByEntry.has(entry.id)
            ? possibleDispatchDryRunResult(args, entry, preflight)
            : freshDryRunResult(entry, preflight);
      appliedResults.set(entry.id, result);
      if (result.outcome === "uncertain") {
        admissionStop = { safeNextAction: "resume-plan" };
        break;
      }
    }
    const entries = orderedEntryResults(args.plan, pendingEntryIds, appliedResults, admissionStop);
    const scan = await args.resolveScan(true);
    return {
      planId: args.plan.id,
      planPath: args.planPath,
      status: "checked",
      dryRun: true,
      resumed: args.resumed,
      planChecksum: args.plan.payloadChecksum,
      risk: args.plan.risk,
      summary: summary(args.plan.entries.length, entries),
      entries,
      execution,
      ...(scan === undefined ? {} : { scan }),
    };
  }

  let assertOwned: (() => Promise<void>) | undefined;
  let freshResourcesPreflighted = false;
  for (const entry of pending) {
    const normalizationHistory = normalizationHistoryByEntry.get(entry.id);
    const possibleDispatchHistory = possibleDispatchHistoryByEntry.get(entry.id);
    const resumable = possibleDispatchHistory !== undefined || normalizationHistory !== undefined;
    if (!resumable) {
      if (!freshResourcesPreflighted) {
        await preflightFreshArtistAddResources(args);
        freshResourcesPreflighted = true;
      }
      const preflight = await preflightFreshArtistAddEntry(args, entry);
      execution = preflight.execution;
    }
    assertOwned ??= await args.activateClaim();
    args.signal.throwIfAborted();
    const applied = await executeLidarrApplyEntry({
      plan: args.plan,
      planPath: args.planPath,
      entry,
      client: args.context.client,
      preflight: args.context.preflight,
      execution,
      historyPath: args.historyPath,
      signal: args.signal,
      assertOwned,
      resumePossibleDispatch: possibleDispatchHistory !== undefined,
      resumePossibleDispatchLidarrId: possibleDispatchHistory?.lidarrId,
      resumeNormalizationHistory: normalizationHistory,
      appendHistory: appendLidarrPlanHistory,
    });
    appliedResults.set(entry.id, applied.result);
    execution = applied.execution;
    if (applied.stopAdmissions) {
      admissionStop = {
        safeNextAction: applied.result.failure?.safeNextAction ?? "resume-plan",
      };
      break;
    }
  }

  const entries = orderedEntryResults(args.plan, pendingEntryIds, appliedResults, admissionStop);
  const scan = await args.resolveScan(false);
  return {
    planId: args.plan.id,
    planChecksum: args.plan.payloadChecksum,
    planPath: args.planPath,
    status: status(entries),
    dryRun: false,
    resumed: args.resumed,
    risk: args.plan.risk,
    summary: summary(args.plan.entries.length, entries),
    entries,
    execution,
    ...(scan === undefined ? {} : { scan }),
  };
}
