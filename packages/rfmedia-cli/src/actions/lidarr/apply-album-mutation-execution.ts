/**
 * Per-entry lifecycle for the album-family v2 apply kinds (`album-edit` /
 * `album-delete`): fresh-read admission, sequential dispatch, deferral of
 * retryable failures, bounded post-dispatch verification, and durable history.
 *
 * PARALLEL lane beside the artist/v1 executors (design §4): album mutation
 * entries also satisfy the `"albumId" in entry` shape guard used by the v1
 * album-monitoring lane, so every routing decision into this module is keyed
 * on `plan.operation.kind` and the album-typed operation definition — never on
 * entry shape.
 */

import { LidarrPlanStaleError } from "../../lib/errors.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import { enqueueDeferredIntent } from "../../lib/lidarr/deferred-queue.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import { appendLidarrPlanHistory } from "../../lib/lidarr/plan-engine.js";
import { resolveResiliencePolicy } from "../../lib/lidarr/resilience.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type { LidarrAlbumMutationOperationDefinition } from "../../lib/lidarr/plan-album-operations.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import type { DbConnection } from "../../types/db.js";
import type {
  LidarrAlbumMutationPlanEntryV2,
  LidarrAlbumMutationPlanV2,
  LidarrAlbumPlanApplyEntryResult,
  LidarrAlbumPlanHistoryRecord,
  LidarrPlanApplyFailure,
  LidarrPlanApplyEntryResult,
  LidarrPlanTerminalHistoryOutcome,
} from "../../types/lidarr-plan.js";
import type { LidarrAlbum } from "../../types/lidarr.js";
import {
  isLidarrApplyAbortError,
  safeLidarrApplyErrorMessage,
  throwIfLidarrApplyCancelled,
} from "./apply-target-errors.js";
// CIRCULARITY GUARD: apply-entry-execution.js statically imports this module's
// per-entry executor for its kind-first dispatch while this module imports the
// dispatcher and the shared reconciliation constants back. The cycle is safe
// only because BOTH modules reference the other's bindings exclusively inside
// function bodies — never during module evaluation — so no ESM
// temporal-dead-zone read can occur regardless of load order. Keep it that
// way: no top-level calls across this boundary.
import {
  LIDARR_APPLY_RECONCILIATION_ATTEMPTS,
  LIDARR_APPLY_RECONCILIATION_DELAY_MS,
  executeLidarrApplyEntry,
} from "./apply-entry-execution.js";
import type { LidarrApplyEntryExecutionResult } from "./apply-target-types.js";

const TIER = "local-only";

/** Shared persistence context for one album-family apply or replay target. */
export interface LidarrAlbumMutationPersistenceContext {
  readonly plan: LidarrAlbumMutationPlanV2;
  readonly entry: LidarrAlbumMutationPlanEntryV2;
  readonly definition: LidarrAlbumMutationOperationDefinition;
  readonly historyPath?: string;
  readonly assertOwned: () => Promise<void>;
}

/** Full argument set for one reviewed album-family apply target. */
export interface LidarrAlbumMutationApplyEntryArgs extends LidarrAlbumMutationPersistenceContext {
  readonly planPath: string;
  readonly origin: string;
  readonly client: LidarrClientApi;
  readonly signal?: AbortSignal;
  readonly execution: LidarrExecutionMetadata;
  readonly ensureDatabase: () => Promise<DbConnection>;
}

/** Fresh-read admission classification for one album-family target. */
export interface LidarrClassifiedAlbumMutationTarget {
  readonly classification: "ready" | "satisfied";
  readonly current?: LidarrAlbum;
  readonly execution: LidarrExecutionMetadata;
}

/** Bounded post-dispatch verification result for one album-family target. */
export interface LidarrAlbumMutationReconciliationResult {
  readonly state: "verified" | "failed" | "inconclusive";
  readonly execution: LidarrExecutionMetadata;
  readonly current?: LidarrAlbum;
  readonly error?: unknown;
}

interface PersistedAlbumMutationOutcome {
  readonly result: LidarrPlanApplyEntryResult;
  readonly durable: boolean;
}

function isNotFound(error: unknown): boolean {
  return error instanceof LidarrError && error.code === "not-found";
}

/** Builds structured, credential-free failure evidence for one album target. */
export function lidarrAlbumMutationFailure(
  plan: LidarrAlbumMutationPlanV2,
  definition: LidarrAlbumMutationOperationDefinition,
  entry: LidarrAlbumMutationPlanEntryV2,
  input: Omit<LidarrPlanApplyFailure, "operation" | "planId" | "planChecksum" | "targetIds">,
): LidarrPlanApplyFailure {
  return Object.freeze({
    ...input,
    operation: definition.kind,
    planId: plan.id,
    planChecksum: plan.payloadChecksum,
    targetIds: Object.freeze([entry.albumId]),
  });
}

function albumEntryResult(
  entry: LidarrAlbumMutationPlanEntryV2,
  outcome: LidarrAlbumPlanApplyEntryResult["outcome"],
  errorCode?: string,
  message?: string,
  failure?: LidarrPlanApplyFailure,
): LidarrAlbumPlanApplyEntryResult {
  return {
    entryId: entry.id,
    albumId: entry.albumId,
    albumTitle: entry.albumTitle,
    artistId: entry.artistId,
    artistName: entry.artistName,
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(message === undefined ? {} : { message }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function albumHistoryRecord(
  plan: LidarrAlbumMutationPlanV2,
  entry: LidarrAlbumMutationPlanEntryV2,
  outcome: LidarrPlanTerminalHistoryOutcome,
  errorCode?: string,
  message?: string,
): LidarrAlbumPlanHistoryRecord {
  return {
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
}

/**
 * Persists one durable album history record and builds its entry result.
 * A history-write failure after remote success is the existing uncertain +
 * stop-admissions invariant; before remote success it propagates.
 */
export async function persistLidarrAlbumMutationOutcome(
  context: LidarrAlbumMutationPersistenceContext,
  outcome: LidarrPlanTerminalHistoryOutcome,
  evidence: {
    readonly errorCode?: string;
    readonly message?: string;
    readonly remoteSucceeded?: boolean;
    readonly failure?: LidarrPlanApplyFailure;
  },
): Promise<PersistedAlbumMutationOutcome> {
  try {
    await context.assertOwned();
    await appendLidarrPlanHistory(
      albumHistoryRecord(
        context.plan,
        context.entry,
        outcome,
        evidence.errorCode,
        evidence.message,
      ),
      context.historyPath,
    );
    return {
      result: albumEntryResult(
        context.entry,
        outcome,
        evidence.errorCode,
        evidence.message,
        evidence.failure,
      ),
      durable: true,
    };
  } catch (error) {
    if (evidence.remoteSucceeded !== true) throw error;
    return {
      result: albumEntryResult(
        context.entry,
        "uncertain",
        "history-write-failed",
        "Remote mutation succeeded but durable history failed; resume is required",
        lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
          code: "history-write-failed",
          stage: "history",
          dispatchState: "dispatched",
          verificationState: "verified",
          retryable: true,
          safeNextAction: "resume-plan",
        }),
      ),
      durable: false,
    };
  }
}

/** Builds the blocked-stale result for one album target with failure evidence. */
export function staleLidarrAlbumMutationEntryResult(
  plan: LidarrAlbumMutationPlanV2,
  definition: LidarrAlbumMutationOperationDefinition,
  entry: LidarrAlbumMutationPlanEntryV2,
  error: LidarrPlanStaleError,
): LidarrPlanApplyEntryResult {
  const finding = error.findings.find((candidate) => candidate.entryId === entry.id);
  return albumEntryResult(
    entry,
    "blocked-stale",
    finding?.code ?? "plan-stale",
    finding?.message ?? error.message,
    lidarrAlbumMutationFailure(plan, definition, entry, {
      code: "plan-stale",
      stage: "admission",
      dispatchState: "not-dispatched",
      verificationState: "not-started",
      retryable: false,
      safeNextAction: "review-staleness-and-replan",
    }),
  );
}

/** Builds not-attempted results with failure evidence after admissions stop. */
export function notAttemptedLidarrAlbumMutationResults(
  plan: LidarrAlbumMutationPlanV2,
  definition: LidarrAlbumMutationOperationDefinition,
  entries: readonly LidarrAlbumMutationPlanEntryV2[],
  safeNextAction: LidarrPlanApplyFailure["safeNextAction"] = "resume-plan",
): LidarrPlanApplyEntryResult[] {
  return entries.map((entry) =>
    albumEntryResult(
      entry,
      "not-attempted",
      "admission-stopped",
      "Not attempted after apply stopped",
      lidarrAlbumMutationFailure(plan, definition, entry, {
        code: "admission-stopped",
        stage: "admission",
        dispatchState: "not-dispatched",
        verificationState: "not-started",
        retryable: true,
        safeNextAction,
      }),
    ),
  );
}

async function runAlbumApplyRead<T>(
  id: string,
  operation: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ readonly value: T; readonly execution: LidarrExecutionMetadata }> {
  return resolveLidarrScheduler().runSingle(
    TIER,
    { id, operation, idempotent: true, run },
    { signal },
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      rejectDelay(signal?.reason ?? new DOMException("Lidarr apply cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Re-reads and classifies one album target immediately before admission.
 * A missing delete target classifies "satisfied" (idempotent deletion); drift
 * throws {@link LidarrPlanStaleError} so nothing is dispatched.
 */
export async function classifyLidarrAlbumMutationTarget(args: {
  readonly plan: LidarrAlbumMutationPlanV2;
  readonly planPath: string;
  readonly entry: LidarrAlbumMutationPlanEntryV2;
  readonly client: LidarrClientApi;
  readonly definition: LidarrAlbumMutationOperationDefinition;
  readonly signal?: AbortSignal;
}): Promise<LidarrClassifiedAlbumMutationTarget> {
  args.signal?.throwIfAborted();
  const read = await runAlbumApplyRead(
    `lidarr-apply-read-${args.plan.id}-${args.definition.taskIdFragment(args.entry)}`,
    "lidarr apply target check",
    () => args.definition.loadCurrentStates(args.client, [args.entry], args.signal),
    args.signal,
  );
  const current = read.value.get(args.definition.entryId(args.entry));
  const classification = args.definition.classify(args.entry, current);
  if (classification === "drifted") {
    throw new LidarrPlanStaleError(
      [args.definition.staleFinding(args.entry, current === undefined ? "missing" : "drift")],
      args.planPath,
    );
  }
  return {
    classification,
    ...(current === undefined ? {} : { current }),
    execution: read.execution,
  };
}

/**
 * Performs bounded fresh reads to classify one post-dispatch album outcome:
 * ABSENCE is the expected postcondition for delete, the new `anyReleaseOk`
 * value for edit. A delete target still present after every attempt is a
 * definite verification failure, never a false success.
 */
export async function reconcileLidarrAlbumMutationTarget(args: {
  readonly plan: LidarrAlbumMutationPlanV2;
  readonly entry: LidarrAlbumMutationPlanEntryV2;
  readonly client: LidarrClientApi;
  readonly definition: LidarrAlbumMutationOperationDefinition;
  readonly execution: LidarrExecutionMetadata;
  readonly signal?: AbortSignal;
}): Promise<LidarrAlbumMutationReconciliationResult> {
  let execution = args.execution;
  let latestError: unknown;
  let latestRead: { readonly current: LidarrAlbum | undefined } | undefined;
  for (let attempt = 1; attempt <= LIDARR_APPLY_RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (args.signal?.aborted === true) {
      return { state: "inconclusive", execution, error: args.signal.reason };
    }
    try {
      const read = await runAlbumApplyRead(
        `lidarr-apply-verify-${args.plan.id}-${args.definition.taskIdFragment(args.entry)}-${attempt}`,
        "lidarr apply targeted verification",
        () => args.definition.loadCurrentStates(args.client, [args.entry], args.signal),
        args.signal,
      );
      execution = read.execution;
      const current = read.value.get(args.definition.entryId(args.entry));
      latestRead = { current };
      if (args.definition.verify(args.entry, current)) {
        return { state: "verified", execution, ...(current === undefined ? {} : { current }) };
      }
      if (
        args.definition.kind === "album-edit" &&
        args.definition.classify(args.entry, current) === "drifted"
      ) {
        return {
          state: "failed",
          execution,
          ...(current === undefined ? {} : { current }),
          error: new Error(
            `Album ${args.entry.albumId} release policy drifted during verification`,
          ),
        };
      }
    } catch (error) {
      latestError = error;
      if (isLidarrApplyAbortError(error, args.signal)) {
        return { state: "inconclusive", execution, error };
      }
    }
    if (attempt < LIDARR_APPLY_RECONCILIATION_ATTEMPTS) {
      try {
        await abortableDelay(LIDARR_APPLY_RECONCILIATION_DELAY_MS, args.signal);
      } catch (error) {
        return { state: "inconclusive", execution, error };
      }
    }
  }
  if (
    args.definition.kind === "album-delete" &&
    latestRead !== undefined &&
    latestRead.current !== undefined
  ) {
    return {
      state: "failed",
      execution,
      current: latestRead.current,
      error: new Error(
        `Album ${args.entry.albumId} is still present after deletion was dispatched`,
      ),
    };
  }
  return { state: "inconclusive", execution, error: latestError };
}

/** Persists the exact result selected by bounded post-dispatch reconciliation. */
export async function persistLidarrAlbumMutationReconciliationOutcome(
  context: LidarrAlbumMutationPersistenceContext & { readonly signal?: AbortSignal },
  reconciled: LidarrAlbumMutationReconciliationResult,
  dispatchError?: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
  switch (reconciled.state) {
    case "verified": {
      const persisted = await persistLidarrAlbumMutationOutcome(context, "succeeded", {
        ...(dispatchError instanceof LidarrError
          ? {
              message: `Editor response was lost but targeted verification confirmed success: ${dispatchError.message}`,
            }
          : {}),
        remoteSucceeded: true,
      });
      return {
        result: persisted.result,
        execution: reconciled.execution,
        stopAdmissions: !persisted.durable,
      };
    }
    case "failed": {
      const persisted = await persistLidarrAlbumMutationOutcome(context, "failed", {
        errorCode: "verification-failed",
        message: safeLidarrApplyErrorMessage(
          reconciled.error,
          "Managed postcondition verification failed",
        ),
        failure: lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
          code: "verification-failed",
          stage: "verification",
          dispatchState: dispatchError === undefined ? "dispatched" : "dispatch-unknown",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        }),
      });
      return { result: persisted.result, execution: reconciled.execution, stopAdmissions: true };
    }
    case "inconclusive": {
      if (
        dispatchError instanceof LidarrError &&
        !dispatchError.retryable &&
        !isLidarrApplyAbortError(dispatchError, context.signal)
      ) {
        const persisted = await persistLidarrAlbumMutationOutcome(context, "failed", {
          errorCode: dispatchError.code,
          message: dispatchError.message,
          failure: lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
            code: dispatchError.code,
            stage: "dispatch",
            dispatchState: "dispatched",
            verificationState: "failed",
            retryable: false,
            safeNextAction: "review-failure-and-resume",
          }),
        });
        return { result: persisted.result, execution: reconciled.execution, stopAdmissions: false };
      }
      const code = isLidarrApplyAbortError(dispatchError ?? reconciled.error, context.signal)
        ? "post-dispatch-cancelled"
        : "verification-inconclusive";
      const detail =
        dispatchError instanceof LidarrError
          ? dispatchError.message
          : safeLidarrApplyErrorMessage(
              reconciled.error,
              "Post-dispatch state remained inconclusive after bounded reconciliation",
            );
      const persisted = await persistLidarrAlbumMutationOutcome(context, "uncertain", {
        errorCode: code,
        message: detail,
        remoteSucceeded: true,
        failure: lidarrAlbumMutationFailure(context.plan, context.definition, context.entry, {
          code,
          stage: "verification",
          dispatchState: dispatchError === undefined ? "dispatched" : "dispatch-unknown",
          verificationState: "inconclusive",
          retryable: true,
          safeNextAction: "resume-plan",
        }),
      });
      return { result: persisted.result, execution: reconciled.execution, stopAdmissions: true };
    }
  }
}

async function persistAlbumMutationAdmissionFailure(
  args: LidarrAlbumMutationApplyEntryArgs,
  error: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
  if (error instanceof LidarrPlanStaleError) {
    return {
      result: staleLidarrAlbumMutationEntryResult(args.plan, args.definition, args.entry, error),
      execution: args.execution,
      stopAdmissions: true,
      safeNextAction: "review-staleness-and-replan",
    };
  }
  throwIfLidarrApplyCancelled(error, args.signal);
  const retryable = error instanceof LidarrError && error.retryable;
  const code = error instanceof LidarrError ? error.code : "target-read-failed";
  const message = safeLidarrApplyErrorMessage(error, "Unexpected Lidarr target-read failure");
  if (error instanceof LidarrError && error.retryable) {
    const resilience = resolveResiliencePolicy(getLoadedLidarrConfig().resilience);
    enqueueDeferredIntent(await args.ensureDatabase(), {
      origin: args.origin,
      operation: args.definition.deferredOperation,
      tier: TIER,
      payload: args.definition.payloadFor(args.entry),
      idempotencyKey: args.entry.idempotencyKey,
      error,
      maxAttempts: resilience.deferredMaxAttempts,
    });
  }
  const persisted = await persistLidarrAlbumMutationOutcome(
    args,
    retryable ? "deferred" : "failed",
    {
      errorCode: code,
      message,
      failure: lidarrAlbumMutationFailure(args.plan, args.definition, args.entry, {
        code,
        stage: "admission",
        dispatchState: "not-dispatched",
        verificationState: "not-started",
        retryable,
        safeNextAction: retryable ? "resume-plan" : "review-failure-and-resume",
      }),
    },
  );
  return { result: persisted.result, execution: args.execution, stopAdmissions: false };
}

/**
 * Owns admission, kind-typed dispatch, deferral, bounded verification, and
 * persistence for one reviewed album-family target.
 */
export async function executeLidarrAlbumMutationApplyEntry(
  args: LidarrAlbumMutationApplyEntryArgs,
): Promise<LidarrApplyEntryExecutionResult> {
  let live: LidarrClassifiedAlbumMutationTarget;
  try {
    live = await classifyLidarrAlbumMutationTarget(args);
  } catch (error) {
    return persistAlbumMutationAdmissionFailure(args, error);
  }

  if (live.classification === "satisfied") {
    // Missing delete target (or an already-converged edit): record the durable
    // "satisfied" outcome so resume skips the entry without re-dispatch.
    const persisted = await persistLidarrAlbumMutationOutcome(args, "satisfied", {});
    return { result: persisted.result, execution: live.execution, stopAdmissions: false };
  }

  await args.assertOwned();
  let execution = live.execution;
  let dispatchError: unknown;
  try {
    const applied = await resolveLidarrScheduler().runSingle(
      TIER,
      {
        id: `lidarr-apply-${args.plan.id}-${args.definition.taskIdFragment(args.entry)}`,
        operation: `lidarr apply ${args.definition.kind}`,
        idempotent: false,
        run: () => args.definition.execute(args.entry, args.client, args.signal),
      },
      { signal: args.signal },
    );
    execution = applied.execution;
  } catch (error) {
    dispatchError = error;
  }

  if (dispatchError !== undefined) {
    throwIfLidarrApplyCancelled(dispatchError, args.signal);
    if (isNotFound(dispatchError) && args.definition.kind === "album-delete") {
      // Already-deleted target: the destructive postcondition already holds.
      const persisted = await persistLidarrAlbumMutationOutcome(args, "satisfied", {
        errorCode: "not-found",
        message: "Album was already deleted",
        remoteSucceeded: true,
      });
      return { result: persisted.result, execution, stopAdmissions: !persisted.durable };
    }
    if (dispatchError instanceof LidarrError && dispatchError.retryable) {
      // Destructive calls are retry-DENIED in place: defer the exact payload
      // keyed by the sealed idempotency key, never hot-retry.
      const resilience = resolveResiliencePolicy(getLoadedLidarrConfig().resilience);
      enqueueDeferredIntent(await args.ensureDatabase(), {
        origin: args.origin,
        operation: args.definition.deferredOperation,
        tier: TIER,
        payload: args.definition.payloadFor(args.entry),
        idempotencyKey: args.entry.idempotencyKey,
        error: dispatchError,
        maxAttempts: resilience.deferredMaxAttempts,
      });
      const persisted = await persistLidarrAlbumMutationOutcome(args, "deferred", {
        errorCode: dispatchError.code,
        message: dispatchError.message,
        failure: lidarrAlbumMutationFailure(args.plan, args.definition, args.entry, {
          code: dispatchError.code,
          stage: "dispatch",
          dispatchState: "dispatch-unknown",
          verificationState: "not-started",
          retryable: true,
          safeNextAction: "resume-plan",
        }),
      });
      return { result: persisted.result, execution, stopAdmissions: false };
    }
  }

  const reconciled = await reconcileLidarrAlbumMutationTarget({
    plan: args.plan,
    entry: args.entry,
    client: args.client,
    definition: args.definition,
    execution,
    signal: args.signal,
  });
  return persistLidarrAlbumMutationReconciliationOutcome(args, reconciled, dispatchError);
}

/**
 * Iterates reviewed album targets strictly sequentially through the kind-first
 * dispatcher and stops admitting new work on any uncertain, stale, or
 * non-durable boundary (mirror of the artist batch loop).
 */
export async function executeLidarrAlbumMutationApplyMutations(args: {
  readonly plan: LidarrAlbumMutationPlanV2;
  readonly planPath: string;
  readonly origin: string;
  readonly executable: readonly LidarrAlbumMutationPlanEntryV2[];
  readonly client: LidarrClientApi;
  readonly definition: LidarrAlbumMutationOperationDefinition;
  readonly historyPath?: string;
  readonly signal?: AbortSignal;
  readonly execution: LidarrExecutionMetadata;
  readonly ensureDatabase: () => Promise<DbConnection>;
  readonly assertOwned: () => Promise<void>;
}): Promise<{
  readonly entries: readonly LidarrPlanApplyEntryResult[];
  readonly execution: LidarrExecutionMetadata;
  readonly stopAdmissions: boolean;
}> {
  const results: LidarrPlanApplyEntryResult[] = [];
  let execution = args.execution;

  for (const [index, entry] of args.executable.entries()) {
    args.signal?.throwIfAborted();
    const applied = await executeLidarrApplyEntry({ ...args, entry, execution });
    results.push(applied.result);
    execution = applied.execution;

    if (applied.stopAdmissions) {
      results.push(
        ...notAttemptedLidarrAlbumMutationResults(
          args.plan,
          args.definition,
          args.executable.slice(index + 1),
          applied.safeNextAction,
        ),
      );
      return { entries: results, execution, stopAdmissions: true };
    }
  }

  return { entries: results, execution, stopAdmissions: false };
}
