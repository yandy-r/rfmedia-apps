/**
 * Deferred-queue and circuit-state collector for `rfmedia lidarr audit`
 * (issue #211).
 *
 * This module is the ONLY tracking-database access in the audit feature: the
 * evaluators in `audit-platform-checks.ts` consume the assembled
 * {@link LidarrAuditQueueState} and never touch persistence themselves.
 *
 * The whole module is written to a single contract:
 * {@link collectLidarrAuditQueueState} NEVER throws. Every failure mode —
 * unresolvable origin, database open failure, missing/legacy schema, malformed
 * row, close failure — becomes an explicit field on the returned state, so the
 * `retry-backlog` check always renders a verdict and an unreadable queue can
 * never abort an otherwise healthy audit.
 *
 * `LidarrClientOverrides` is imported from `./health.js` rather than the
 * `./index.js` barrel on purpose: the barrel re-exports this module's siblings,
 * so a static import back into it would create an ESM cycle.
 */

import type { DbConnection } from "../../types/db.js";
import type { LidarrAuditQueueState } from "../../types/lidarr-audit.js";
import { closeDatabase, initializeDatabase } from "../db.js";
import { listDeferredIntents } from "./deferred-queue.js";
import type { LidarrDeferredIntent } from "./deferred-queue.js";
import { countDeferredIntentsByStatus } from "./deferred-queue-db.js";
import type { DbLidarrDeferredIntentStatus } from "./deferred-queue-db.js";
import { readLidarrResilienceSnapshot } from "./health.js";
import type { LidarrClientOverrides } from "./health.js";

/**
 * Upper bound on the pending intents inspected for the age / overdue /
 * near-exhaustion detail. The counts are always exact (they come from a
 * `GROUP BY` aggregate); only this derived detail is windowed, which keeps a
 * pathologically large backlog from turning one audit into a full table read.
 *
 * The window is PUBLISHED on the state as `detailWindow` / `detailTruncated`
 * rather than applied silently: `overdue` and `nearExhaustion` are lower bounds
 * once it bites, and a consumer that divided them by the exact `counts.pending`
 * would badly under-report the backlog.
 */
const PENDING_DETAIL_LIMIT = 500;

/** All five lifecycle statuses at zero — the honest fallback when a read fails. */
const ZERO_COUNTS: Readonly<Record<DbLidarrDeferredIntentStatus, number>> = Object.freeze({
  pending: 0,
  "in-progress": 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
});

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Derived per-row detail; every field is absent when the detail read failed. */
type PendingIntentDetail = Pick<
  LidarrAuditQueueState,
  "oldestPendingAgeSeconds" | "overdue" | "nearExhaustion" | "detailWindow" | "detailTruncated"
>;

/**
 * Derives the pending-backlog detail from an already-fetched intent window.
 *
 * `oldestPendingAgeSeconds` is omitted when no pending intent carries a
 * parseable `createdAt`, so a malformed timestamp never becomes a bogus age.
 * `overdue` and `nearExhaustion` are always present (zero is a real answer).
 *
 * `detailWindow` and `detailTruncated` ship alongside them so a consumer can
 * see that these counts range over at most {@link PENDING_DETAIL_LIMIT} rows
 * while `counts.pending` is exact. Truncation is decided against the exact
 * count rather than against the limit, so a backlog that lands exactly on the
 * limit is not mislabelled as truncated.
 *
 * @param pending - Pending intents for the audited origin, oldest first.
 * @param nowMs - Reference instant in epoch milliseconds.
 * @param pendingTotal - Exact pending count from the `GROUP BY` aggregate.
 * @returns The derived detail fields.
 */
function summarizePendingIntents(
  pending: readonly LidarrDeferredIntent[],
  nowMs: number,
  pendingTotal: number,
): PendingIntentDetail {
  let oldestCreatedMs: number | undefined;
  let overdue = 0;
  let nearExhaustion = 0;

  for (const intent of pending) {
    const createdMs = Date.parse(intent.createdAt);
    if (
      !Number.isNaN(createdMs) &&
      (oldestCreatedMs === undefined || createdMs < oldestCreatedMs)
    ) {
      oldestCreatedMs = createdMs;
    }
    if (intent.nextAttemptAt !== null) {
      const nextAttemptMs = Date.parse(intent.nextAttemptAt);
      if (!Number.isNaN(nextAttemptMs) && nextAttemptMs <= nowMs) {
        overdue += 1;
      }
    }
    if (intent.attempts >= intent.maxAttempts - 1) {
      nearExhaustion += 1;
    }
  }

  return {
    ...(oldestCreatedMs === undefined
      ? {}
      : { oldestPendingAgeSeconds: Math.max(0, Math.round((nowMs - oldestCreatedMs) / 1000)) }),
    overdue,
    nearExhaustion,
    detailWindow: PENDING_DETAIL_LIMIT,
    detailTruncated: pendingTotal > pending.length,
  };
}

/**
 * Closes the tracking database, converting a close failure into a reason
 * string instead of letting it escape a `finally` block and replace the
 * collected state with an exception.
 *
 * @param db - Connection to close.
 * @returns A reason string when the close failed, otherwise `undefined`.
 */
function closeTrackingDatabase(db: DbConnection): string | undefined {
  try {
    closeDatabase(db);
    return undefined;
  } catch (error) {
    return `cannot close tracking database: ${errorMessage(error)}`;
  }
}

/** Test seams for {@link collectLidarrAuditQueueState}. */
export interface LidarrAuditQueueDependencies {
  /** Lazily opens the tracking database; defaults to `initializeDatabase()`. */
  readonly openDb?: () => Promise<DbConnection>;
}

/**
 * Assembles circuit state and the deferred-intent backlog for one audit run.
 * NEVER throws.
 *
 * Circuit state comes from `readLidarrResilienceSnapshot`, which already
 * degrades to `{ state: "unknown", reason }` per scope. The per-row detail read
 * (`listDeferredIntents`) is capped at {@link PENDING_DETAIL_LIMIT} rows and
 * reports that cap through `detailWindow` / `detailTruncated`. It is wrapped
 * SEPARATELY from the count read (`countDeferredIntentsByStatus`) because the
 * former throws on a malformed row: one poisoned row must cost the age/attempt
 * detail, never the counts.
 * The count read is wrapped too — it performs raw SQL with no error handling of
 * its own, so a missing table, a pre-v10 schema, or a corrupt file surfaces
 * there first.
 *
 * This opens the tracking database twice — once inside
 * `readLidarrResilienceSnapshot`, once here for the full status counts and
 * pending detail. Cheap, and it keeps the snapshot's never-throws guarantee
 * instead of re-deriving circuit state.
 *
 * @param overrides - Lidarr connection overrides (URL / API key).
 * @param origin - Credential-free canonical origin, resolved by the action.
 * @param deps - Test seams.
 * @returns The queue state; failures become explicit fields, never exceptions.
 */
export async function collectLidarrAuditQueueState(
  overrides: LidarrClientOverrides,
  origin: string,
  deps?: LidarrAuditQueueDependencies,
): Promise<LidarrAuditQueueState> {
  // Documented never-throws: every failure is already folded into the snapshot.
  const { circuits } = await readLidarrResilienceSnapshot(overrides);

  const openDb = deps?.openDb ?? ((): Promise<DbConnection> => initializeDatabase());
  let db: DbConnection;
  try {
    db = await openDb();
  } catch (error) {
    return {
      circuits,
      counts: ZERO_COUNTS,
      detailUnavailableReason: `cannot open tracking database: ${errorMessage(error)}`,
    };
  }

  let counts: Readonly<Record<DbLidarrDeferredIntentStatus, number>> = ZERO_COUNTS;
  let detail: PendingIntentDetail = {};
  let detailUnavailableReason: string | undefined;

  try {
    counts = countDeferredIntentsByStatus(db, origin);
    try {
      const pending = listDeferredIntents(db, {
        status: "pending",
        origin,
        limit: PENDING_DETAIL_LIMIT,
      });
      detail = summarizePendingIntents(pending, Date.now(), counts.pending);
    } catch (error) {
      detailUnavailableReason = `cannot read deferred-intent detail: ${errorMessage(error)}`;
    }
  } catch (error) {
    counts = ZERO_COUNTS;
    detail = {};
    detailUnavailableReason = `cannot read deferred-intent counts: ${errorMessage(error)}`;
  } finally {
    const closeFailure = closeTrackingDatabase(db);
    if (closeFailure !== undefined && detailUnavailableReason === undefined) {
      detailUnavailableReason = closeFailure;
    }
  }

  return {
    circuits,
    counts,
    ...detail,
    ...(detailUnavailableReason === undefined ? {} : { detailUnavailableReason }),
  };
}
