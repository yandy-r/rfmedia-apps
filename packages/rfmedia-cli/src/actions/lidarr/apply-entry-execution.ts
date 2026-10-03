/** Typed admission, dispatch, reconciliation, and persistence for one Lidarr apply target. */

import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import { enqueueDeferredIntent } from "../../lib/lidarr/deferred-queue.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import { resolveResiliencePolicy } from "../../lib/lidarr/resilience.js";
import type { LidarrExecutionMetadata } from "../../lib/lidarr/scheduler.js";
import { LidarrPlanStaleError } from "../../lib/errors.js";
import type {
  LidarrAlbumMonitoringPlanEntry,
  LidarrArtistDeleteObservedState,
  LidarrArtistDeletePlanEntry,
  LidarrPlanHistoryOutcome,
  LidarrPlanObservedState,
} from "../../types/lidarr-plan.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import { executeLidarrArtistAddApplyEntry } from "./apply-artist-add-entry-execution.js";
import {
  dispatchLidarrArtistApplyEntry,
  persistLidarrArtistReconciliationOutcome,
  possibleDispatchPersistenceFailure,
} from "./apply-artist-entry-execution.js";
// CIRCULARITY GUARD: this module statically imports the album-family per-entry
// executor for kind-first dispatch while apply-album-mutation-execution.js
// imports this module's dispatcher and reconciliation constants back. The
// cycle is safe only because BOTH modules reference the other's bindings
// exclusively inside function bodies — never during module evaluation.
import {
  executeLidarrAlbumMutationApplyEntry,
  type LidarrAlbumMutationApplyEntryArgs,
} from "./apply-album-mutation-execution.js";
import type { LidarrApplyResourceContext } from "./apply-resources.js";
import {
  isLidarrApplyAbortError,
  safeLidarrApplyErrorMessage,
  throwIfLidarrApplyCancelled,
} from "./apply-target-errors.js";
import { isLidarrDeferredApplyOperationDefinition } from "./apply-target-types.js";
import type {
  AnyLidarrApplyPlanEntry,
  LidarrAlbumApplyOperationDefinition,
  LidarrApplyEntryExecutionArgs,
  LidarrApplyEntryExecutionResult,
  LidarrApplyExecutionSupport,
  LidarrApplyOperationDefinition,
  LidarrApplyPlan,
  LidarrApplyReconciliationResult,
  LidarrArtistAddApplyEntryExecutionArgs,
  LidarrArtistAddApplyEntryExecutionResult,
  LidarrArtistApplyOperationDefinition,
  LidarrArtistApplyPlanEntry,
  LidarrClassifiedApplyTarget,
} from "./apply-target-types.js";

const TIER = "local-only";

class LidarrPossibleDispatchPresentError extends Error {
  constructor(artistId: number) {
    super(
      `Artist ${artistId} remains present after a possibly dispatched deletion; refusing automatic resend`,
    );
    this.name = "LidarrPossibleDispatchPresentError";
  }
}

function isAlbumEntry(entry: AnyLidarrApplyPlanEntry): entry is LidarrAlbumMonitoringPlanEntry {
  return "albumId" in entry;
}

function isArtistDeleteEntry(entry: AnyLidarrApplyPlanEntry): entry is LidarrArtistDeletePlanEntry {
  return !isAlbumEntry(entry) && "exists" in entry.after;
}

function requireAlbumDefinition(
  definition: LidarrApplyOperationDefinition,
): LidarrAlbumApplyOperationDefinition {
  if (definition.kind !== "album-monitoring") {
    throw new Error("Artist operation definition cannot process an album entry");
  }
  return definition;
}

function requireArtistDefinition(
  definition: LidarrApplyOperationDefinition,
): LidarrArtistApplyOperationDefinition {
  if (definition.kind === "album-monitoring") {
    throw new Error("Album operation definition cannot process an artist entry");
  }
  return definition;
}

/** Maximum fresh targeted reads after one editor request. */
export const LIDARR_APPLY_RECONCILIATION_ATTEMPTS = 3;

/** Delay between bounded reconciliation reads (two waits, 200 ms total). */
export const LIDARR_APPLY_RECONCILIATION_DELAY_MS = 100;

export {
  isLidarrApplyAbortError,
  safeLidarrApplyErrorMessage,
  throwIfLidarrApplyCancelled,
} from "./apply-target-errors.js";

function isNotFound(error: unknown): boolean {
  return error instanceof LidarrError && error.code === "not-found";
}

type TargetedArtistRead =
  | {
      readonly presence: "present";
      readonly artist: LidarrArtist;
    }
  | {
      readonly presence: "absent";
      readonly observed: Extract<LidarrArtistDeleteObservedState, { readonly exists: false }>;
    };

async function runApplyRead<T>(
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

function observedArtistDeleteState(
  artist: LidarrArtist,
): Extract<LidarrArtistDeleteObservedState, { readonly exists: true }> | undefined {
  if (artist.path === undefined || artist.statistics === undefined) return undefined;
  return {
    kind: "artist-delete",
    exists: true,
    evidence: {
      path: artist.path,
      albumCount: artist.statistics.albumCount,
      trackFileCount: artist.statistics.trackFileCount,
      sizeOnDisk: artist.statistics.sizeOnDisk,
    },
  };
}

function missingArtistDeleteEvidence(artist: LidarrArtist): string {
  const fields = [
    ...(artist.path === undefined ? ["path"] : []),
    ...(artist.statistics === undefined ? ["albumCount", "trackFileCount", "sizeOnDisk"] : []),
  ];
  return `Artist ${artist.id} deletion evidence changed after planning: ${fields.join(", ")}`;
}

async function readTargetedArtist(
  plan: LidarrApplyPlan,
  entry: LidarrArtistApplyPlanEntry,
  client: LidarrClientApi,
  idPrefix: string,
  operation: string,
  attempt: number | undefined,
  signal?: AbortSignal,
): Promise<{ readonly value: TargetedArtistRead; readonly execution: LidarrExecutionMetadata }> {
  const suffix = attempt === undefined ? "" : `-${attempt}`;
  return runApplyRead(
    `${idPrefix}-${plan.id}-${entry.artistId}${suffix}`,
    operation,
    async () => {
      try {
        return {
          presence: "present",
          artist: await client.getArtist(entry.artistId, signal),
        };
      } catch (error) {
        if (!isNotFound(error)) throw error;
        return {
          presence: "absent",
          observed: { kind: "artist-delete", exists: false },
        };
      }
    },
    signal,
  );
}

/** Re-reads and classifies one target immediately before mutation admission. */
export async function classifyLidarrApplyTarget(
  plan: LidarrApplyPlan,
  planPath: string,
  entry: AnyLidarrApplyPlanEntry,
  client: LidarrClientApi,
  definition: LidarrApplyOperationDefinition,
  resources: LidarrApplyResourceContext,
  support: LidarrApplyExecutionSupport,
  signal?: AbortSignal,
  attributableAbsence = false,
): Promise<LidarrClassifiedApplyTarget> {
  signal?.throwIfAborted();
  if (isAlbumEntry(entry)) {
    const albumDefinition = requireAlbumDefinition(definition);
    const read = await runApplyRead(
      `lidarr-apply-read-${plan.id}-${albumDefinition.taskIdFragment(entry)}`,
      "lidarr apply target check",
      () => albumDefinition.loadCurrentStates(client, [entry], signal),
      signal,
    );
    const current = read.value.get(albumDefinition.entryId(entry));
    if (current === undefined) {
      throw new LidarrPlanStaleError([albumDefinition.staleFinding(entry, "missing")], planPath);
    }
    const classification = albumDefinition.classify(entry, current);
    if (classification === "drifted") {
      throw new LidarrPlanStaleError([albumDefinition.staleFinding(entry, "drift")], planPath);
    }
    return { classification, presence: "unstructured", execution: read.execution };
  }

  const artistDefinition = requireArtistDefinition(definition);
  const read = await readTargetedArtist(
    plan,
    entry,
    client,
    "lidarr-apply-read",
    "lidarr apply targeted artist check",
    undefined,
    signal,
  );
  if (read.value.presence === "absent") {
    if (
      artistDefinition.kind === "artist-delete" &&
      isArtistDeleteEntry(entry) &&
      attributableAbsence
    ) {
      return {
        classification: "satisfied",
        presence: "absent",
        execution: read.execution,
        observed: read.value.observed,
        attribution: "resume-possible-dispatch",
      };
    }
    throw new LidarrPlanStaleError([support.staleFinding(entry, "artist-missing")], planPath);
  }

  const artist = read.value.artist;
  if (
    artistDefinition.kind === "artist-delete" &&
    isArtistDeleteEntry(entry) &&
    attributableAbsence
  ) {
    throw new LidarrPossibleDispatchPresentError(entry.artistId);
  }
  const deletionObserved =
    artistDefinition.kind === "artist-delete" && isArtistDeleteEntry(entry)
      ? observedArtistDeleteState(artist)
      : undefined;
  const observed =
    artistDefinition.kind === "artist-delete"
      ? deletionObserved
      : support.observedState(entry, artist, definition, resources);
  if (observed === undefined) {
    throw new LidarrPlanStaleError(
      [support.staleFinding(entry, "artist-state-drift", missingArtistDeleteEvidence(artist))],
      planPath,
    );
  }
  const classification = artistDefinition.classifyLive(entry, deletionObserved ?? artist);
  if (classification.state === "drifted") {
    throw new LidarrPlanStaleError(
      [support.staleFinding(entry, "artist-state-drift", classification.message)],
      planPath,
    );
  }
  return {
    classification: classification.state,
    presence: "present",
    execution: read.execution,
    artist,
    observed,
  };
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

/** Performs bounded fresh reads to classify one post-dispatch mutation outcome. */
export async function reconcileLidarrApplyTarget(args: {
  readonly plan: LidarrApplyPlan;
  readonly entry: AnyLidarrApplyPlanEntry;
  readonly client: LidarrClientApi;
  readonly definition: LidarrApplyOperationDefinition;
  readonly resources: LidarrApplyResourceContext;
  readonly execution: LidarrExecutionMetadata;
  readonly support: LidarrApplyExecutionSupport;
  readonly signal?: AbortSignal;
}): Promise<LidarrApplyReconciliationResult> {
  const artistDefinition = requireArtistDefinition(args.definition);
  const deletion = artistDefinition.kind === "artist-delete" && isArtistDeleteEntry(args.entry);
  let execution = args.execution;
  let latestArtist: LidarrArtist | undefined;
  let latestObserved: LidarrPlanObservedState | undefined;
  let latestError: unknown;
  for (let attempt = 1; attempt <= LIDARR_APPLY_RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (args.signal?.aborted === true) {
      return {
        state: "inconclusive",
        presence: latestArtist === undefined ? "unobserved" : "present",
        execution,
        artist: latestArtist,
        observed: latestObserved,
        error: args.signal.reason,
      };
    }
    try {
      const read = await readTargetedArtist(
        args.plan,
        args.entry,
        args.client,
        "lidarr-apply-verify",
        "lidarr apply targeted verification",
        attempt,
        args.signal,
      );
      execution = read.execution;
      if (read.value.presence === "absent") {
        if (deletion) {
          return {
            state: "verified",
            presence: "absent",
            execution,
            observed: read.value.observed,
          };
        }
        return {
          state: "failed",
          presence: "unobserved",
          execution,
          error: new Error(`Artist ${args.entry.artistId} no longer exists`),
        };
      }
      latestArtist = read.value.artist;
      const deletionObserved = deletion ? observedArtistDeleteState(read.value.artist) : undefined;
      if (deletion && deletionObserved === undefined) {
        return {
          state: "failed",
          presence: "present",
          execution,
          artist: read.value.artist,
          error: new Error(missingArtistDeleteEvidence(read.value.artist)),
        };
      }
      latestObserved =
        deletionObserved ??
        args.support.observedState(args.entry, read.value.artist, args.definition, args.resources);
      const classification = artistDefinition.classifyLive(
        args.entry,
        deletionObserved ?? read.value.artist,
      );
      if (
        classification.state === "satisfied" &&
        artistDefinition.verify(args.entry, deletionObserved ?? read.value.artist)
      ) {
        return {
          state: "verified",
          presence: "present",
          execution,
          artist: read.value.artist,
          observed: latestObserved,
        };
      }
      if (classification.state === "drifted") {
        return {
          state: "failed",
          presence: "present",
          execution,
          artist: read.value.artist,
          observed: latestObserved,
          error: new Error(classification.message),
        };
      }
    } catch (error) {
      latestError = error;
      if (isLidarrApplyAbortError(error, args.signal)) {
        return {
          state: "inconclusive",
          presence: latestArtist === undefined ? "unobserved" : "present",
          execution,
          artist: latestArtist,
          observed: latestObserved,
          error,
        };
      }
    }
    if (attempt < LIDARR_APPLY_RECONCILIATION_ATTEMPTS) {
      try {
        await abortableDelay(LIDARR_APPLY_RECONCILIATION_DELAY_MS, args.signal);
      } catch (error) {
        return {
          state: "inconclusive",
          presence: latestArtist === undefined ? "unobserved" : "present",
          execution,
          artist: latestArtist,
          observed: latestObserved,
          error,
        };
      }
    }
  }
  return {
    state: "inconclusive",
    presence: latestArtist === undefined ? "unobserved" : "present",
    execution,
    artist: latestArtist,
    observed: latestObserved,
    error: latestError,
  };
}

async function persistAdmissionFailure(
  args: LidarrApplyEntryExecutionArgs,
  error: unknown,
): Promise<LidarrApplyEntryExecutionResult> {
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
      safeNextAction: "review-staleness-and-replan",
    };
  }

  if (args.definition.kind === "artist-delete" && isArtistDeleteEntry(args.entry)) {
    const cancelled = isLidarrApplyAbortError(error, args.signal);
    const code = cancelled
      ? "post-dispatch-cancelled"
      : error instanceof LidarrPossibleDispatchPresentError
        ? "possible-dispatch-pending"
        : error instanceof LidarrError
          ? error.code
          : "target-read-failed";
    const message = safeLidarrApplyErrorMessage(
      error,
      "Deletion target state could not be established",
    );
    return {
      result: {
        entryId: args.entry.id,
        artistId: args.entry.artistId,
        artistName: args.entry.artistName,
        outcome: "uncertain",
        errorCode: code,
        message,
        before: {
          kind: "artist-delete",
          exists: true,
          evidence: args.entry.before,
        },
        after: { kind: "artist-delete", exists: false },
        failure: args.support.buildFailure(args.plan, args.definition, args.entry, {
          code,
          stage: "admission",
          dispatchState: args.attributableAbsence === true ? "dispatch-unknown" : "not-dispatched",
          verificationState: "inconclusive",
          retryable: true,
          safeNextAction: "resume-plan",
        }),
      },
      execution: args.execution,
      stopAdmissions: true,
      safeNextAction: "resume-plan",
    };
  }

  throwIfLidarrApplyCancelled(error, args.signal);
  const retryable = error instanceof LidarrError && error.retryable;
  const code = error instanceof LidarrError ? error.code : "target-read-failed";
  const message = safeLidarrApplyErrorMessage(error, "Unexpected Lidarr target-read failure");
  if (retryable && isLidarrDeferredApplyOperationDefinition(args.definition)) {
    const resilience = resolveResiliencePolicy(getLoadedLidarrConfig().resilience);
    const payload = isAlbumEntry(args.entry)
      ? requireAlbumDefinition(args.definition).payloadFor(args.entry)
      : requireArtistDefinition(args.definition).payloadFor(args.entry);
    enqueueDeferredIntent(await args.ensureDatabase(), {
      origin: args.origin,
      operation:
        args.definition.kind === "album-monitoring"
          ? args.definition.deferredOperation
          : args.definition.deferability.operation,
      tier: TIER,
      payload,
      idempotencyKey: args.entry.idempotencyKey,
      error,
      maxAttempts: resilience.deferredMaxAttempts,
    });
  }
  const outcome: LidarrPlanHistoryOutcome = retryable ? "deferred" : "failed";
  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    outcome,
    args.historyPath,
    args.definition,
    args.resources,
    code,
    message,
    false,
    args.assertOwned,
    isAlbumEntry(args.entry)
      ? undefined
      : {
          failure: args.support.buildFailure(args.plan, args.definition, args.entry, {
            code,
            stage: "admission",
            dispatchState: "not-dispatched",
            verificationState: "not-started",
            retryable,
            safeNextAction: retryable ? "resume-plan" : "review-failure-and-resume",
          }),
        },
  );
  return {
    result: persisted.result,
    execution: args.execution,
    stopAdmissions: false,
  };
}

async function persistSatisfiedEntry(
  args: LidarrApplyEntryExecutionArgs,
  live: LidarrClassifiedApplyTarget,
): Promise<LidarrApplyEntryExecutionResult> {
  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    "satisfied",
    args.historyPath,
    args.definition,
    args.resources,
    undefined,
    undefined,
    false,
    args.assertOwned,
    {
      artistName: live.artist?.artistName ?? args.entry.artistName,
      observed: live.observed,
    },
  );
  return {
    result: persisted.result,
    execution: live.execution,
    stopAdmissions: false,
  };
}

/** Executes and persists one admitted album target. */
export async function executeLidarrAlbumApplyEntry(
  args: LidarrApplyEntryExecutionArgs & {
    readonly entry: LidarrAlbumMonitoringPlanEntry;
    readonly live: LidarrClassifiedApplyTarget;
  },
): Promise<LidarrApplyEntryExecutionResult> {
  const albumDefinition = requireAlbumDefinition(args.definition);
  let execution = args.live.execution;
  let dispatchError: unknown;
  try {
    const applied = await resolveLidarrScheduler().runSingle(
      TIER,
      {
        id: `lidarr-apply-${args.plan.id}-${albumDefinition.taskIdFragment(args.entry)}`,
        operation: albumDefinition.operationLabel,
        idempotent: true,
        run: () => albumDefinition.execute(args.entry, args.client, args.signal),
      },
      { signal: args.signal },
    );
    execution = applied.execution;
  } catch (error) {
    dispatchError = error;
  }

  if (dispatchError !== undefined) {
    throwIfLidarrApplyCancelled(dispatchError, args.signal);
    const retryable = dispatchError instanceof LidarrError && dispatchError.retryable;
    if (dispatchError instanceof LidarrError && dispatchError.retryable) {
      const resilience = resolveResiliencePolicy(getLoadedLidarrConfig().resilience);
      enqueueDeferredIntent(await args.ensureDatabase(), {
        origin: args.origin,
        operation: albumDefinition.deferredOperation,
        tier: TIER,
        payload: albumDefinition.payloadFor(args.entry),
        idempotencyKey: args.entry.idempotencyKey,
        error: dispatchError,
        maxAttempts: resilience.deferredMaxAttempts,
      });
    }
    const code = dispatchError instanceof LidarrError ? dispatchError.code : "unknown";
    const message =
      dispatchError instanceof Error ? dispatchError.message : "Unknown Lidarr apply failure";
    const persisted = await args.support.persistOutcome(
      args.plan,
      args.entry,
      retryable ? "deferred" : "failed",
      args.historyPath,
      args.definition,
      args.resources,
      code,
      message,
      false,
      args.assertOwned,
    );
    return {
      result: persisted.result,
      execution,
      stopAdmissions: false,
    };
  }

  const persisted = await args.support.persistOutcome(
    args.plan,
    args.entry,
    "succeeded",
    args.historyPath,
    args.definition,
    args.resources,
    undefined,
    undefined,
    true,
    args.assertOwned,
  );
  return {
    result: persisted.result,
    execution,
    stopAdmissions: !persisted.durable,
  };
}

/** Executes, reconciles, and persists one admitted artist target. */
export async function executeLidarrArtistApplyEntry(
  args: LidarrApplyEntryExecutionArgs & {
    readonly entry: LidarrArtistApplyPlanEntry;
    readonly live: LidarrClassifiedApplyTarget;
  },
): Promise<LidarrApplyEntryExecutionResult> {
  const artistDefinition = requireArtistDefinition(args.definition);
  const dispatched = await dispatchLidarrArtistApplyEntry(args, artistDefinition);
  if (!dispatched.possibleDispatchDurable) {
    return possibleDispatchPersistenceFailure(args, dispatched.error);
  }
  const reconciled = await reconcileLidarrApplyTarget({
    plan: args.plan,
    entry: args.entry,
    client: args.client,
    definition: args.definition,
    resources: args.resources,
    execution: dispatched.execution,
    support: args.support,
    signal: args.signal,
  });
  return persistLidarrArtistReconciliationOutcome(args, reconciled, dispatched.error);
}

function isAlbumMutationEntryArgs(
  args:
    | LidarrApplyEntryExecutionArgs
    | LidarrAlbumMutationApplyEntryArgs
    | LidarrArtistAddApplyEntryExecutionArgs,
): args is LidarrAlbumMutationApplyEntryArgs {
  const kind = args.plan.operation.kind;
  return kind === "album-edit" || kind === "album-delete";
}

function isArtistAddEntryArgs(
  args:
    | LidarrApplyEntryExecutionArgs
    | LidarrAlbumMutationApplyEntryArgs
    | LidarrArtistAddApplyEntryExecutionArgs,
): args is LidarrArtistAddApplyEntryExecutionArgs {
  return args.plan.operation.kind === "artist-add";
}

/** Owns admission, type-specific dispatch, and persistence for one reviewed target. */
export function executeLidarrApplyEntry(
  args: LidarrArtistAddApplyEntryExecutionArgs,
): Promise<LidarrArtistAddApplyEntryExecutionResult>;
export function executeLidarrApplyEntry(
  args: LidarrApplyEntryExecutionArgs | LidarrAlbumMutationApplyEntryArgs,
): Promise<LidarrApplyEntryExecutionResult>;
export async function executeLidarrApplyEntry(
  args:
    | LidarrApplyEntryExecutionArgs
    | LidarrAlbumMutationApplyEntryArgs
    | LidarrArtistAddApplyEntryExecutionArgs,
): Promise<LidarrApplyEntryExecutionResult | LidarrArtistAddApplyEntryExecutionResult> {
  if (isArtistAddEntryArgs(args)) {
    return executeLidarrArtistAddApplyEntry(args);
  }
  // KIND-FIRST ROUTING: album v2 mutation entries also satisfy the
  // `"albumId" in entry` shape guard used by the v1 album-monitoring lane, so
  // this dispatch keys on `plan.operation.kind` before any structural check.
  if (isAlbumMutationEntryArgs(args)) {
    return executeLidarrAlbumMutationApplyEntry(args);
  }
  let live: LidarrClassifiedApplyTarget;
  try {
    live = await classifyLidarrApplyTarget(
      args.plan,
      args.planPath,
      args.entry,
      args.client,
      args.definition,
      args.resources,
      args.support,
      args.signal,
      args.attributableAbsence,
    );
  } catch (error) {
    return persistAdmissionFailure(args, error);
  }

  if (live.classification === "satisfied") {
    return persistSatisfiedEntry(args, live);
  }

  await args.assertOwned();
  return isAlbumEntry(args.entry)
    ? executeLidarrAlbumApplyEntry({ ...args, entry: args.entry, live })
    : executeLidarrArtistApplyEntry({ ...args, entry: args.entry, live });
}
