/** Deferred-intent queue selection and exact plan-entry validation for Lidarr apply resume. */

import { listDeferredIntents } from "../../lib/lidarr/deferred-queue.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import type { LidarrDeferredIntent } from "../../lib/lidarr/deferred-queue.js";
import type { DbConnection } from "../../types/db.js";
import type { LidarrAlbumMonitoringPlanEntry } from "../../types/lidarr-plan.js";
import type {
  AnyLidarrApplyPlanEntry,
  LidarrDeferredApplyOperationDefinition,
} from "./apply-target-execution.js";

function isAlbumEntry(entry: AnyLidarrApplyPlanEntry): entry is LidarrAlbumMonitoringPlanEntry {
  return "albumId" in entry;
}

function matchesDeferredIntent(
  definition: LidarrDeferredApplyOperationDefinition,
  entry: AnyLidarrApplyPlanEntry,
  queuedOperation: string,
  queuedPayload: Readonly<Record<string, unknown>>,
): boolean {
  if (isAlbumEntry(entry)) {
    return (
      definition.kind === "album-monitoring" &&
      definition.matchesDeferredIntent(entry, queuedOperation, queuedPayload)
    );
  }
  return (
    definition.kind !== "album-monitoring" &&
    definition.matchesDeferredIntent(entry, queuedOperation, queuedPayload)
  );
}

export interface LidarrDeferredReplayQueue {
  readonly byKey: Map<string, AnyLidarrApplyPlanEntry>;
  readonly queued: readonly LidarrDeferredIntent[];
}

/** Selects resumable intents and rejects claims or payloads that do not match the plan exactly. */
export function loadLidarrDeferredReplayQueue(args: {
  readonly database: DbConnection;
  readonly planPath: string;
  readonly origin: string;
  readonly executable: readonly AnyLidarrApplyPlanEntry[];
  readonly definition: LidarrDeferredApplyOperationDefinition;
}): LidarrDeferredReplayQueue {
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
    if (
      entry === undefined ||
      !matchesDeferredIntent(args.definition, entry, intent.operation, intent.payload)
    ) {
      throw new LidarrPlanValidationError(
        `deferred intent ${intent.id} does not exactly match its plan entry`,
        args.planPath,
      );
    }
  }
  return { byKey, queued };
}
