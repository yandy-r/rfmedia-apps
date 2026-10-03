/** Replay and reconciliation for one claimed Lidarr deferred apply intent. */

import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import {
  createCircuitBreaker,
  createSqliteCircuitStore,
} from "../../lib/lidarr/circuit-breaker.js";
import {
  claimDeferredIntentForReplay,
  completeClaimedDeferredIntent,
  replayDeferredIntents,
  restoreClaimedDeferredIntent,
} from "../../lib/lidarr/deferred-queue.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import { createLidarrMutationExecutors } from "../../lib/lidarr/plan-engine.js";
import { resolveResiliencePolicy } from "../../lib/lidarr/resilience.js";
import { LidarrPlanStaleError, LidarrPlanValidationError } from "../../lib/errors.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type {
  LidarrDeferredIntent,
  LidarrIntentExecutor,
} from "../../lib/lidarr/deferred-queue.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type { DbConnection } from "../../types/db.js";
import type { LidarrAlbumMonitoringPlanEntry } from "../../types/lidarr-plan.js";
import {
  persistAlbumReplayOutcome,
  persistArtistReplayOutcome,
  persistRetryableClassificationFailure,
  persistSatisfiedReplayOutcome,
  type LidarrArtistReplayResult,
  type LidarrDeferredReplayEntryResult,
} from "./apply-deferred-replay-outcomes.js";
import type { LidarrApplyResourceContext } from "./apply-resources.js";
import {
  classifyLidarrApplyTarget,
  reconcileLidarrApplyTarget,
  throwIfLidarrApplyCancelled,
  type AnyLidarrApplyPlanEntry,
  type LidarrApplyExecutionSupport,
  type LidarrApplyPlan,
  type LidarrApplyReconciliationResult,
  type LidarrClassifiedApplyTarget,
  type LidarrDeferredApplyOperationDefinition,
  type LidarrDeferredArtistApplyOperationDefinition,
} from "./apply-target-execution.js";

function isAlbumEntry(entry: AnyLidarrApplyPlanEntry): entry is LidarrAlbumMonitoringPlanEntry {
  return "albumId" in entry;
}

export function createLidarrReplayBreakers(database: DbConnection, origin: string) {
  const resilience = resolveResiliencePolicy(getLoadedLidarrConfig().resilience);
  const store = createSqliteCircuitStore(database);
  const policy = {
    failureThreshold: resilience.failureThreshold,
    failureWindowMs: resilience.failureWindowSeconds * 1_000,
    cooldownMs: resilience.cooldownSeconds * 1_000,
  };
  return {
    lidarr: createCircuitBreaker({ store, origin, scope: "lidarr", policy }),
    metadata: createCircuitBreaker({ store, origin, scope: "metadata", policy }),
  };
}

interface ReplayEntryArgs {
  readonly database: DbConnection;
  readonly plan: LidarrApplyPlan;
  readonly planPath: string;
  readonly entry: AnyLidarrApplyPlanEntry;
  readonly intent: LidarrDeferredIntent;
  readonly client: LidarrClientApi;
  readonly definition: LidarrDeferredApplyOperationDefinition;
  readonly resources: LidarrApplyResourceContext;
  readonly historyPath?: string;
  readonly signal?: AbortSignal;
  readonly execution: LidarrExecutionMetadata;
  readonly breakers: ReturnType<typeof createLidarrReplayBreakers>;
  readonly assertOwned: () => Promise<void>;
  readonly support: LidarrApplyExecutionSupport;
}

async function replayClaimedIntent(
  args: ReplayEntryArgs,
  executors: ReadonlyMap<string, LidarrIntentExecutor>,
) {
  try {
    return await replayDeferredIntents(args.database, args.client, executors, args.breakers, {
      ids: [args.intent.id],
      claimedIds: [args.intent.id],
      limit: 1,
      signal: args.signal,
    });
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    throw error;
  }
}

async function classifyClaimedIntent(
  args: ReplayEntryArgs,
): Promise<LidarrClassifiedApplyTarget | LidarrDeferredReplayEntryResult> {
  try {
    return await classifyLidarrApplyTarget(
      args.plan,
      args.planPath,
      args.entry,
      args.client,
      args.definition,
      args.resources,
      args.support,
      args.signal,
    );
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    if (error instanceof LidarrPlanStaleError) {
      return {
        result: args.support.staleEntryResult(
          args.plan,
          args.definition,
          args.entry,
          error,
          args.resources,
        ),
        execution: args.execution,
        stopAdmissions: true,
      };
    }
    throwIfLidarrApplyCancelled(error, args.signal);
    if (!(error instanceof LidarrError) || !error.retryable) throw error;
    return persistRetryableClassificationFailure(args, args.execution, error);
  }
}

async function persistSatisfiedIntent(
  args: ReplayEntryArgs,
  claimed: LidarrDeferredIntent,
  live: LidarrClassifiedApplyTarget,
): Promise<LidarrDeferredReplayEntryResult> {
  try {
    completeClaimedDeferredIntent(args.database, claimed);
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    throw error;
  }
  return persistSatisfiedReplayOutcome(args, live);
}

async function replayAlbumIntent(
  args: ReplayEntryArgs,
  execution: LidarrExecutionMetadata,
): Promise<LidarrDeferredReplayEntryResult> {
  const replay = await replayClaimedIntent(args, createLidarrMutationExecutors());
  const replayOutcome = replay.outcomes[0];
  if (replayOutcome?.outcome === "cancelled") {
    throw args.signal?.reason ?? new DOMException("Lidarr apply cancelled", "AbortError");
  }
  args.signal?.throwIfAborted();
  return persistAlbumReplayOutcome(args, execution, replayOutcome);
}

async function runArtistReplay(
  args: ReplayEntryArgs,
  execution: LidarrExecutionMetadata,
): Promise<LidarrArtistReplayResult> {
  const definition = requireDeferredArtistDefinition(args.definition);
  let replayResolution: LidarrApplyReconciliationResult | undefined;
  let dispatchError: unknown;
  let latestExecution = execution;
  const exactExecutor = Object.freeze({
    operation: definition.deferability.operation,
    execute: async (
      payload: Readonly<Record<string, unknown>>,
      client: LidarrClientApi,
      signal?: AbortSignal,
    ): Promise<void> => {
      try {
        await definition.executeDeferredPayload(payload, client, signal);
      } catch (error) {
        dispatchError = error;
      }
      replayResolution = await reconcileLidarrApplyTarget({
        plan: args.plan,
        entry: args.entry,
        client,
        definition,
        resources: args.resources,
        execution: latestExecution,
        support: args.support,
        signal,
      });
      latestExecution = replayResolution.execution;
      if (replayResolution.state === "verified") return;
      throw new Error(
        replayResolution.state === "failed"
          ? "Deferred mutation failed postcondition verification"
          : "Deferred mutation outcome is uncertain after bounded reconciliation",
      );
    },
  });
  const executors = new Map(createLidarrMutationExecutors());
  executors.set(exactExecutor.operation, exactExecutor);
  const replay = await replayClaimedIntent(args, executors);
  return {
    execution: latestExecution,
    replayOutcome: replay.outcomes[0],
    replayResolution,
    dispatchError,
  };
}

function requireDeferredArtistDefinition(
  definition: LidarrDeferredApplyOperationDefinition,
): LidarrDeferredArtistApplyOperationDefinition {
  if (definition.kind === "album-monitoring") {
    throw new Error("Album operation definition cannot replay an artist intent");
  }
  return definition;
}

/** Claims, classifies, and replays one exact deferred intent. */
export async function replayLidarrDeferredEntry(
  args: ReplayEntryArgs,
): Promise<LidarrDeferredReplayEntryResult> {
  await args.assertOwned();
  const claimed = claimDeferredIntentForReplay(args.database, args.intent.id);
  if (claimed === undefined) {
    throw new LidarrPlanValidationError(
      `deferred intent ${args.intent.id} was claimed by another process`,
      args.planPath,
    );
  }
  const classified = await classifyClaimedIntent(args);
  if ("result" in classified) return classified;
  if (classified.classification === "satisfied") {
    return persistSatisfiedIntent(args, claimed, classified);
  }

  try {
    await args.assertOwned();
  } catch (error) {
    restoreClaimedDeferredIntent(args.database, args.intent.id);
    throw error;
  }
  if (isAlbumEntry(args.entry)) {
    return replayAlbumIntent(args, classified.execution);
  }
  const replay = await runArtistReplay(args, classified.execution);
  return persistArtistReplayOutcome(args, classified, replay);
}
