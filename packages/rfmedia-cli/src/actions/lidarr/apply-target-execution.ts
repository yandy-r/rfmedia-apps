/** Sequential orchestration for per-target Lidarr plan application. */

import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type { DbConnection } from "../../types/db.js";
import type { LidarrPlanApplyEntryResult } from "../../types/lidarr-plan.js";
import type { LidarrApplyResourceContext } from "./apply-resources.js";
import { executeLidarrApplyEntry } from "./apply-entry-execution.js";
import type {
  AnyLidarrApplyPlanEntry,
  LidarrApplyExecutionBatchResult,
  LidarrApplyExecutionSupport,
  LidarrApplyOperationDefinition,
  LidarrApplyPlan,
} from "./apply-target-types.js";

export {
  classifyLidarrApplyTarget,
  isLidarrApplyAbortError,
  LIDARR_APPLY_RECONCILIATION_ATTEMPTS,
  LIDARR_APPLY_RECONCILIATION_DELAY_MS,
  reconcileLidarrApplyTarget,
  safeLidarrApplyErrorMessage,
  throwIfLidarrApplyCancelled,
} from "./apply-entry-execution.js";
export { isLidarrDeferredApplyOperationDefinition } from "./apply-target-types.js";
export type {
  AnyLidarrApplyPlanEntry,
  LidarrAlbumApplyOperationDefinition,
  LidarrApplyExecutionBatchResult,
  LidarrApplyExecutionSupport,
  LidarrApplyOperationDefinition,
  LidarrApplyPlan,
  LidarrPersistedApplyOutcome,
  LidarrApplyReconciliationResult,
  LidarrArtistApplyOperationDefinition,
  LidarrClassifiedApplyTarget,
  LidarrDeferredApplyOperationDefinition,
  LidarrDeferredArtistApplyOperationDefinition,
} from "./apply-target-types.js";

/**
 * Iterates reviewed targets sequentially and stops admitting new work when one
 * per-entry executor reports an uncertain, stale, or non-durable boundary.
 */
export async function executeLidarrApplyMutations(args: {
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
  readonly ensureDatabase: () => Promise<DbConnection>;
  readonly assertOwned: () => Promise<void>;
  readonly support: LidarrApplyExecutionSupport;
  readonly attributableAbsenceEntryIds?: ReadonlySet<string>;
}): Promise<LidarrApplyExecutionBatchResult> {
  const results: LidarrPlanApplyEntryResult[] = [];
  let execution = args.execution;

  for (const [index, entry] of args.executable.entries()) {
    args.signal?.throwIfAborted();
    const applied = await executeLidarrApplyEntry({
      ...args,
      entry,
      execution,
      attributableAbsence: args.attributableAbsenceEntryIds?.has(entry.id) === true,
    });
    results.push(applied.result);
    execution = applied.execution;

    if (applied.stopAdmissions) {
      results.push(
        ...args.support.notAttemptedResults(
          args.plan,
          args.definition,
          args.executable.slice(index + 1),
          args.resources,
          applied.safeNextAction,
        ),
      );
      return { entries: results, execution, stopAdmissions: true };
    }
  }

  return { entries: results, execution, stopAdmissions: false };
}
