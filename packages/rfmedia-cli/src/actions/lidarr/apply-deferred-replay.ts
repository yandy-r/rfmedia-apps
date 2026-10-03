/** Exact deferred-intent replay and reconciliation for resumed Lidarr apply plans. */

import { LidarrPlanStaleError, LidarrPlanValidationError } from "../../lib/errors.js";
import {
  claimDeferredIntentForReplay,
  completeClaimedDeferredIntent,
  listDeferredIntents,
  replayDeferredIntents,
  restoreClaimedDeferredIntent,
} from "../../lib/lidarr/deferred-queue.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import { createLidarrMutationExecutorsWithAlbums } from "../../lib/lidarr/plan-engine.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type {
  LidarrDeferredIntent,
  LidarrIntentExecutor,
} from "../../lib/lidarr/deferred-queue.js";
import type { LidarrAlbumMutationOperationDefinition } from "../../lib/lidarr/plan-album-operations.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type { DbConnection } from "../../types/db.js";
import type {
  LidarrAlbumMutationPlanEntryV2,
  LidarrAlbumMutationPlanV2,
  LidarrPlanApplyEntryResult,
} from "../../types/lidarr-plan.js";
import {
  classifyLidarrAlbumMutationTarget,
  persistLidarrAlbumMutationOutcome,
  reconcileLidarrAlbumMutationTarget,
  staleLidarrAlbumMutationEntryResult,
  type LidarrAlbumMutationReconciliationResult,
} from "./apply-album-mutation-execution.js";
import {
  createLidarrReplayBreakers,
  replayLidarrDeferredEntry,
} from "./apply-deferred-replay-entry.js";
import {
  persistAlbumMutationReplayOutcome,
  persistAlbumMutationRetryableReplayFailure,
  type LidarrAlbumMutationReplayResult,
  type LidarrDeferredReplayEntryResult,
} from "./apply-deferred-replay-outcomes.js";
import { loadLidarrDeferredReplayQueue } from "./apply-deferred-replay-queue.js";
import type { LidarrApplyResourceContext } from "./apply-resources.js";
import { throwIfLidarrApplyCancelled } from "./apply-target-errors.js";
import { isLidarrDeferredApplyOperationDefinition } from "./apply-target-execution.js";
import type {
  AnyLidarrApplyPlanEntry,
  LidarrApplyExecutionBatchResult,
  LidarrApplyExecutionSupport,
  LidarrApplyOperationDefinition,
  LidarrApplyPlan,
} from "./apply-target-execution.js";

/** Replay arguments for the artist/v1 operation families. */
export interface LidarrArtistDeferredReconcileArgs {
  readonly database: DbConnection;
  readonly plan: LidarrApplyPlan;
  readonly planPath: string;
  readonly origin: string;
  readonly executable: readonly AnyLidarrApplyPlanEntry[];
  readonly client: LidarrClientApi;
  readonly definition: LidarrApplyOperationDefinition;
  readonly resources: LidarrApplyResourceContext;
  readonly historyPath?: string;
  readonly signal?: AbortSignal;
  readonly execution: LidarrExecutionMetadata;
  readonly assertOwned: () => Promise<void>;
  readonly support: LidarrApplyExecutionSupport;
}

/** Replay arguments for the album-family v2 mutation kinds. */
export interface LidarrAlbumMutationDeferredReconcileArgs {
  readonly database: DbConnection;
  readonly plan: LidarrAlbumMutationPlanV2;
  readonly planPath: string;
  readonly origin: string;
  readonly executable: readonly LidarrAlbumMutationPlanEntryV2[];
  readonly client: LidarrClientApi;
  readonly definition: LidarrAlbumMutationOperationDefinition;
  readonly historyPath?: string;
  readonly signal?: AbortSignal;
  readonly execution: LidarrExecutionMetadata;
  readonly assertOwned: () => Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof LidarrError && error.code === "not-found";
}

function isAlbumMutationReconcileArgs(
  args: LidarrArtistDeferredReconcileArgs | LidarrAlbumMutationDeferredReconcileArgs,
): args is LidarrAlbumMutationDeferredReconcileArgs {
  const kind = args.plan.operation.kind;
  return kind === "album-edit" || kind === "album-delete";
}

/** Replays exact queued intents before admitting remaining targets on resume. */
export async function reconcileLidarrDeferredEntries(
  args: LidarrAlbumMutationDeferredReconcileArgs,
): Promise<
  LidarrApplyExecutionBatchResult & { readonly remaining: LidarrAlbumMutationPlanEntryV2[] }
>;
export async function reconcileLidarrDeferredEntries(
  args: LidarrArtistDeferredReconcileArgs,
): Promise<LidarrApplyExecutionBatchResult & { readonly remaining: AnyLidarrApplyPlanEntry[] }>;
export async function reconcileLidarrDeferredEntries(
  args: LidarrArtistDeferredReconcileArgs | LidarrAlbumMutationDeferredReconcileArgs,
): Promise<
  LidarrApplyExecutionBatchResult & {
    readonly remaining: AnyLidarrApplyPlanEntry[] | LidarrAlbumMutationPlanEntryV2[];
  }
> {
  // KIND-FIRST ROUTING: album v2 entries also satisfy the `"albumId" in entry`
  // shape guard used by the artist/v1 queue loader, so replay routing keys on
  // `plan.operation.kind` before any structural narrowing.
  if (isAlbumMutationReconcileArgs(args)) {
    return reconcileAlbumMutationDeferredEntries(args);
  }
  const definition = args.definition;
  if (!isLidarrDeferredApplyOperationDefinition(definition)) {
    return {
      entries: [],
      execution: args.execution,
      stopAdmissions: false,
      remaining: [...args.executable],
    };
  }
  const { byKey, queued } = loadLidarrDeferredReplayQueue({ ...args, definition });
  const results: LidarrPlanApplyEntryResult[] = [];
  let execution = args.execution;
  const breakers = createLidarrReplayBreakers(args.database, args.origin);

  for (const intent of queued) {
    args.signal?.throwIfAborted();
    const entry = byKey.get(intent.idempotencyKey);
    if (entry === undefined) continue;
    const replayed = await replayLidarrDeferredEntry({
      ...args,
      definition,
      entry,
      intent,
      execution,
      breakers,
    });
    execution = replayed.execution;
    results.push(replayed.result);
    byKey.delete(intent.idempotencyKey);
    if (replayed.stopAdmissions) {
      return {
        entries: results,
        execution,
        stopAdmissions: true,
        remaining: args.executable.filter((candidate) => byKey.has(candidate.idempotencyKey)),
      };
    }
  }

  const queuedKeys = new Set(queued.map((intent) => intent.idempotencyKey));
  return {
    entries: results,
    execution,
    stopAdmissions: false,
    remaining: args.executable.filter((entry) => !queuedKeys.has(entry.idempotencyKey)),
  };
}

/** Album-family replay: exact-payload selection, claim, verify-backed replay. */
async function reconcileAlbumMutationDeferredEntries(
  args: LidarrAlbumMutationDeferredReconcileArgs,
): Promise<
  LidarrApplyExecutionBatchResult & { readonly remaining: LidarrAlbumMutationPlanEntryV2[] }
> {
  const byKey = new Map(args.executable.map((entry) => [entry.idempotencyKey, entry]));
  const claimedElsewhere = listDeferredIntents(args.database, {
    status: "in-progress",
    origin: args.origin,
    idempotencyKeys: [...byKey.keys()],
    limit: args.executable.length,
  });
  if (claimedElsewhere.length > 0) {
    throw new LidarrPlanValidationError(
      `deferred intent ${claimedElsewhere[0]!.id} is already claimed by another process`,
      args.planPath,
    );
  }
  const queued = listDeferredIntents(args.database, {
    status: "pending",
    origin: args.origin,
    idempotencyKeys: [...byKey.keys()],
    limit: args.executable.length,
  });
  for (const intent of queued) {
    const entry = byKey.get(intent.idempotencyKey);
    // Exact-payload revalidation: the queued operation and payload must
    // byte-match the sealed plan entry before any replay dispatch.
    if (
      entry === undefined ||
      !args.definition.matchesDeferredIntent(entry, intent.operation, intent.payload)
    ) {
      throw new LidarrPlanValidationError(
        `deferred intent ${intent.id} does not exactly match its plan entry`,
        args.planPath,
      );
    }
  }

  const results: LidarrPlanApplyEntryResult[] = [];
  let execution = args.execution;
  const breakers = createLidarrReplayBreakers(args.database, args.origin);
  for (const intent of queued) {
    args.signal?.throwIfAborted();
    const entry = byKey.get(intent.idempotencyKey);
    if (entry === undefined) continue;
    const replayed = await replayAlbumMutationDeferredEntry({
      ...args,
      entry,
      intent,
      execution,
      breakers,
    });
    execution = replayed.execution;
    results.push(replayed.result);
    byKey.delete(intent.idempotencyKey);
    if (replayed.stopAdmissions) {
      return {
        entries: results,
        execution,
        stopAdmissions: true,
        remaining: args.executable.filter((candidate) => byKey.has(candidate.idempotencyKey)),
      };
    }
  }

  const queuedKeys = new Set(queued.map((intent) => intent.idempotencyKey));
  return {
    entries: results,
    execution,
    stopAdmissions: false,
    remaining: args.executable.filter((entry) => !queuedKeys.has(entry.idempotencyKey)),
  };
}

interface AlbumMutationReplayEntryArgs extends Omit<
  LidarrAlbumMutationDeferredReconcileArgs,
  "executable"
> {
  readonly entry: LidarrAlbumMutationPlanEntryV2;
  readonly intent: LidarrDeferredIntent;
  readonly breakers: ReturnType<typeof createLidarrReplayBreakers>;
}

/**
 * Replays one claimed album-family intent through an exact executor that
 * revalidates the payload, interprets not-found as already-deleted for
 * album-delete, and verifies the postcondition with bounded fresh reads.
 */
async function runAlbumMutationReplay(
  args: AlbumMutationReplayEntryArgs,
  execution: LidarrExecutionMetadata,
): Promise<LidarrAlbumMutationReplayResult> {
  let replayResolution: LidarrAlbumMutationReconciliationResult | undefined;
  let dispatchError: unknown;
  let alreadyDeleted = false;
  let latestExecution = execution;
  const exactExecutor: LidarrIntentExecutor = Object.freeze({
    operation: args.definition.deferredOperation,
    execute: async (
      payload: Readonly<Record<string, unknown>>,
      client: LidarrClientApi,
      signal?: AbortSignal,
    ): Promise<void> => {
      try {
        // executeDeferredPayload revalidates exact keys and sensitive keys.
        await args.definition.executeDeferredPayload(payload, client, signal);
      } catch (error) {
        if (isNotFound(error) && args.definition.kind === "album-delete") {
          // Already-deleted: replay dispatch hitting not-found is SUCCESS.
          alreadyDeleted = true;
        } else {
          dispatchError = error;
        }
      }
      const resolution = await reconcileLidarrAlbumMutationTarget({
        plan: args.plan,
        entry: args.entry,
        client,
        definition: args.definition,
        execution: latestExecution,
        signal,
      });
      replayResolution = resolution;
      latestExecution = resolution.execution;
      if (resolution.state === "verified") return;
      throw new Error(
        resolution.state === "failed"
          ? "Deferred mutation failed postcondition verification"
          : "Deferred mutation outcome is uncertain after bounded reconciliation",
      );
    },
  });
  const executors = new Map(createLidarrMutationExecutorsWithAlbums());
  executors.set(exactExecutor.operation, exactExecutor);
  let replay;
  try {
    replay = await replayDeferredIntents(args.database, args.client, executors, args.breakers, {
      ids: [args.intent.id],
      claimedIds: [args.intent.id],
      limit: 1,
      signal: args.signal,
    });
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    throw error;
  }
  return {
    execution: latestExecution,
    replayOutcome: replay.outcomes[0],
    replayResolution,
    dispatchError,
    alreadyDeleted,
  };
}

/** Claims, freshly classifies, and replays one exact album-family intent. */
async function replayAlbumMutationDeferredEntry(
  args: AlbumMutationReplayEntryArgs,
): Promise<LidarrDeferredReplayEntryResult> {
  await args.assertOwned();
  const claimed = claimDeferredIntentForReplay(args.database, args.intent.id);
  if (claimed === undefined) {
    throw new LidarrPlanValidationError(
      `deferred intent ${args.intent.id} was claimed by another process`,
      args.planPath,
    );
  }
  let live;
  try {
    live = await classifyLidarrAlbumMutationTarget({
      plan: args.plan,
      planPath: args.planPath,
      entry: args.entry,
      client: args.client,
      definition: args.definition,
      signal: args.signal,
    });
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    if (error instanceof LidarrPlanStaleError) {
      return {
        result: staleLidarrAlbumMutationEntryResult(args.plan, args.definition, args.entry, error),
        execution: args.execution,
        stopAdmissions: true,
      };
    }
    throwIfLidarrApplyCancelled(error, args.signal);
    if (!(error instanceof LidarrError) || !error.retryable) throw error;
    return persistAlbumMutationRetryableReplayFailure(args, args.execution, error);
  }
  if (live.classification === "satisfied") {
    // Missing delete target on resume: complete the intent without dispatch
    // and record the durable "satisfied" outcome.
    try {
      completeClaimedDeferredIntent(args.database, claimed);
    } catch (error) {
      restoreClaimedDeferredIntent(args.database, args.intent.id);
      throw error;
    }
    const persisted = await persistLidarrAlbumMutationOutcome(args, "satisfied", {});
    return { result: persisted.result, execution: live.execution, stopAdmissions: false };
  }

  try {
    await args.assertOwned();
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    throw error;
  }
  const replay = await runAlbumMutationReplay(args, live.execution);
  return persistAlbumMutationReplayOutcome(args, replay);
}
