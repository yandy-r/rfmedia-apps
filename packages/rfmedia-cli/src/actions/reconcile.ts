import { buildReconciliationPlan, resolveReconciliationStrategy } from "../lib/reconciliation.js";
import type { ReconciliationFailureCode, ReconciliationResult } from "../types/reconciliation.js";
import { acquireReconciliation, throwIfCancelled } from "./reconcile/acquisition.js";
import {
  DEFAULT_RECONCILIATION_DEPENDENCIES,
  type ReconciliationActionDependencies,
  type ReconciliationActionOptions,
} from "./reconcile/contracts.js";
import {
  executeFreshReconciliationPlan,
  type ReconciliationPlanExecution,
} from "./reconcile/execution.js";
import { markRemainingCancelled } from "./reconcile/outcomes.js";
import {
  buildReconciliationResult,
  failedPostApply,
  makePostApply,
  planSignature,
  reportSignature,
  stalePlanOutcomes,
} from "./reconcile/results.js";

export {
  MAX_RECONCILIATION_FILE_CANDIDATES,
  ReconciliationAcquisitionError,
} from "./reconcile/acquisition.js";
export type {
  ReconciliationActionBaseOptions,
  ReconciliationActionDependencies,
  ReconciliationActionOptions,
  ReconciliationApplyActionOptions,
  ReconciliationScanActionOptions,
} from "./reconcile/contracts.js";

/**
 * Executes a read-only reconciliation scan or a preview-first authorized apply.
 *
 * The action emits no output. Callers render the returned versioned result.
 */
export async function executeReconciliation(
  options: ReconciliationActionOptions,
  dependencyOverrides: Partial<ReconciliationActionDependencies> = {},
): Promise<ReconciliationResult> {
  const dependencies = {
    ...DEFAULT_RECONCILIATION_DEPENDENCIES,
    ...dependencyOverrides,
  };
  throwIfCancelled(options.signal);

  if (options.mode === "scan") {
    const acquisition = await acquireReconciliation(options, dependencies);
    return buildReconciliationResult({
      acquisition,
      options,
      strategy: null,
      executed: false,
      executable: true,
      allowPartial: false,
    });
  }

  const strategy = resolveReconciliationStrategy(options);
  const initial = await acquireReconciliation(options, dependencies);
  const executing = options.execute === true;
  const allowPartial = executing && options.allowPartial === true;
  const initialPlan = buildReconciliationPlan(initial.report, strategy, allowPartial);

  if (!executing) {
    return buildReconciliationResult({
      acquisition: initial,
      options,
      strategy,
      executed: false,
      executable: initialPlan.executable,
      allowPartial: false,
      blockers: initialPlan.blockers,
      outcomes: initialPlan.outcomes,
    });
  }

  if (!initialPlan.executable) {
    return buildReconciliationResult({
      acquisition: initial,
      options,
      strategy,
      executed: true,
      executable: false,
      allowPartial,
      blockers: initialPlan.blockers,
      outcomes: initialPlan.outcomes,
    });
  }

  if (!options.yes) {
    if (options.machineOutput || !dependencies.isInteractive()) {
      throw new Error("Non-interactive or machine-output reconciliation execution requires --yes.");
    }
    const approved = await dependencies.confirm(
      `Apply ${initialPlan.outcomes.length} reconciliation target update(s)?`,
    );
    if (!approved) {
      return buildReconciliationResult({
        acquisition: initial,
        options,
        strategy,
        executed: true,
        executable: true,
        allowPartial,
        blockers: initialPlan.blockers,
        outcomes: initialPlan.outcomes,
        declined: true,
      });
    }
  }

  throwIfCancelled(options.signal);
  const fresh = await acquireReconciliation(options, dependencies);
  const freshStrategy = resolveReconciliationStrategy(options);
  const freshPlan = buildReconciliationPlan(fresh.report, freshStrategy, allowPartial);
  if (
    !freshPlan.executable ||
    reportSignature(initial) !== reportSignature(fresh) ||
    planSignature(initialPlan) !== planSignature(freshPlan)
  ) {
    const outcomes = stalePlanOutcomes(freshPlan.outcomes);
    return buildReconciliationResult({
      acquisition: fresh,
      options,
      strategy: freshStrategy,
      executed: true,
      executable: freshPlan.executable,
      allowPartial,
      blockers: freshPlan.blockers,
      outcomes,
      failureCodes: ["stale-evidence"],
      postApply: failedPostApply(["stale-evidence"], new Set()),
    });
  }

  let execution: ReconciliationPlanExecution;
  try {
    execution = await executeFreshReconciliationPlan(options, fresh, freshPlan, dependencies);
  } catch {
    const failureCode: ReconciliationFailureCode = options.signal?.aborted
      ? "cancelled"
      : "write-failed";
    const outcomes = [...freshPlan.outcomes];
    if (failureCode === "cancelled") markRemainingCancelled(outcomes);
    return buildReconciliationResult({
      acquisition: fresh,
      options,
      strategy: freshStrategy,
      executed: true,
      executable: true,
      allowPartial,
      blockers: freshPlan.blockers,
      outcomes,
      failureCodes: [failureCode],
      postApply:
        failureCode === "cancelled"
          ? makePostApply(fresh.report, freshPlan, new Set(), ["cancelled"])
          : failedPostApply([failureCode], new Set()),
    });
  }

  if (execution.failureCodes.includes("cancelled")) {
    return buildReconciliationResult({
      acquisition: fresh,
      options,
      strategy: freshStrategy,
      executed: true,
      executable: true,
      allowPartial,
      blockers: freshPlan.blockers,
      outcomes: execution.outcomes,
      failureCodes: execution.failureCodes,
      postApply: makePostApply(
        fresh.report,
        freshPlan,
        execution.touchedPaths,
        execution.failureCodes,
      ),
    });
  }

  try {
    const postAcquisition = await acquireReconciliation(options, dependencies);
    const postPlan = buildReconciliationPlan(postAcquisition.report, freshStrategy, true);
    const postApply = makePostApply(
      postAcquisition.report,
      postPlan,
      execution.touchedPaths,
      execution.failureCodes,
    );
    return buildReconciliationResult({
      acquisition: postAcquisition,
      options,
      strategy: freshStrategy,
      executed: true,
      executable: true,
      allowPartial,
      blockers: freshPlan.blockers,
      outcomes: execution.outcomes,
      failureCodes: execution.failureCodes,
      postApply,
    });
  } catch {
    if (options.signal?.aborted) {
      const outcomes = [...execution.outcomes];
      markRemainingCancelled(outcomes);
      const failureCodes = [...new Set([...execution.failureCodes, "cancelled" as const])];
      return buildReconciliationResult({
        acquisition: fresh,
        options,
        strategy: freshStrategy,
        executed: true,
        executable: true,
        allowPartial,
        blockers: freshPlan.blockers,
        outcomes,
        failureCodes,
        postApply: makePostApply(fresh.report, freshPlan, execution.touchedPaths, failureCodes),
      });
    }
    const failureCodes = [...new Set([...execution.failureCodes, "verification-failed" as const])];
    return buildReconciliationResult({
      acquisition: fresh,
      options,
      strategy: freshStrategy,
      executed: true,
      executable: true,
      allowPartial,
      blockers: freshPlan.blockers,
      outcomes: execution.outcomes,
      failureCodes,
      postApply: failedPostApply(failureCodes, execution.touchedPaths),
    });
  }
}
