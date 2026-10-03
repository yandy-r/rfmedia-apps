/**
 * Row-level CRUD for the `lidarr_deferred_intents` table (schema v10).
 *
 * Pure persistence layer for the Lidarr resilience deferred-intent queue
 * (issue #195): every function is `(db: DbConnection, ...)`-shaped and free
 * of domain logic (queue-db.ts sibling precedent). Replay orchestration,
 * idempotency-key derivation, and backoff policy live in `deferred-queue.ts`.
 *
 * Never uses `queue_*` tables — those belong to the copy-job queue.
 */

import { logDebug } from "../logger.js";
import { LIDARR_PLAN_MAX_ENTRIES } from "../../types/lidarr-plan.js";
import type {
  DbConnection,
  DbLidarrDeferredIntent,
  CreateLidarrDeferredIntentParams,
} from "../../types/db.js";

/**
 * Status union for deferred-intent rows (row-layer view of the lifecycle).
 */
export type DbLidarrDeferredIntentStatus = DbLidarrDeferredIntent["status"];

/**
 * Filter for listing deferred-intent rows.
 */
export interface DeferredIntentRowFilter {
  /** Only rows with this status. */
  readonly status?: DbLidarrDeferredIntentStatus;
  /** Only rows for this credential-free canonical origin. */
  readonly origin?: string;
  /** Only rows for this exact executor-map operation. */
  readonly operation?: string;
  /** Only rows with one of these idempotency keys (at most 1,000). */
  readonly idempotencyKeys?: readonly string[];
  /** Maximum number of rows to return (positive integer). */
  readonly limit?: number;
}

/**
 * Filter for deleting deferred-intent rows. At least one of `ids` or
 * `statuses` must be provided; when both are present they are combined
 * with AND semantics.
 */
export interface ClearDeferredIntentRowsFilter {
  /** Row ids to delete. */
  readonly ids?: readonly string[];
  /** Statuses to delete. */
  readonly statuses?: readonly DbLidarrDeferredIntentStatus[];
}

/**
 * Outcome of a single replay attempt, written back to the row in one
 * statement. Optional fields left `undefined` are written as NULL — an
 * attempt outcome fully replaces prior error/backoff state.
 */
export interface DeferredIntentAttemptUpdate {
  /** Post-attempt lifecycle status. */
  readonly status: DbLidarrDeferredIntentStatus;
  /** New total attempt count (caller computes `attempts + 1`). */
  readonly attempts: number;
  /** LidarrErrorCode of the failure, or omit to clear. */
  readonly errorCode?: string | null;
  /** Scrubbed failure message (never raw bodies or credentials), or omit to clear. */
  readonly errorMessage?: string | null;
  /** ISO timestamp before which replay must not retry, or omit to clear. */
  readonly nextAttemptAt?: string | null;
}

/**
 * Maximum bound parameters per batched IN (...) clause (queue-db precedent);
 * kept well below SQLite's compile-time variable limit.
 */
const MAX_BATCH_PARAMS = 500;

/** Matches the maximum number of entries accepted by a Lidarr mutation plan. */
const MAX_IDEMPOTENCY_KEYS = 1_000;

/**
 * Validates an optional positive-integer limit.
 *
 * @param limit - Limit value to validate (may be undefined)
 * @throws Error when the limit is present but not a positive integer
 */
function assertValidLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`Deferred intent limit must be a positive integer, got: ${limit}`);
  }
}

/**
 * Validates the bounded idempotency-key selector used by plan resume.
 *
 * @param idempotencyKeys - Keys to validate (may be undefined)
 * @throws Error when more keys are provided than a bounded plan can contain
 */
function assertValidIdempotencyKeys(idempotencyKeys: readonly string[] | undefined): void {
  if (idempotencyKeys !== undefined && idempotencyKeys.length > MAX_IDEMPOTENCY_KEYS) {
    throw new Error(
      `Deferred intent idempotencyKeys must contain at most ${MAX_IDEMPOTENCY_KEYS} entries, got: ${idempotencyKeys.length}`,
    );
  }
}

/** Validates the bounded exact-id selector used by plan replay. */
function assertValidIds(ids: readonly string[] | undefined): void {
  if (ids !== undefined && ids.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw new Error(
      `Deferred intent ids must contain at most ${LIDARR_PLAN_MAX_ENTRIES} entries, got: ${ids.length}`,
    );
  }
}

/**
 * Inserts a deferred intent idempotently via `INSERT OR IGNORE` on
 * `UNIQUE(origin, idempotency_key)`.
 *
 * A duplicate enqueue never loses and never duplicates intent: the
 * pre-existing row is returned unchanged and the new parameters are
 * discarded. New rows start as `pending` with `attempts = 0`; when
 * `maxAttempts` is omitted the schema default (5) applies.
 *
 * @param db - Database connection
 * @param params - Row identity, payload, and optional failure seed
 * @param nowIso - ISO timestamp for created_at/updated_at (defaults to now)
 * @returns The canonical row for (origin, idempotency_key) after the insert
 * @throws Error if the row cannot be read back after the insert
 */
export function insertDeferredIntent(
  db: DbConnection,
  params: CreateLidarrDeferredIntentParams,
  nowIso: string = new Date().toISOString(),
): DbLidarrDeferredIntent {
  const baseColumns =
    "id, origin, operation, tier, payload_json, idempotency_key, " +
    "error_code, error_message, created_at, updated_at, next_attempt_at";
  const baseValues: (string | number | null)[] = [
    params.id,
    params.origin,
    params.operation,
    params.tier,
    params.payloadJson,
    params.idempotencyKey,
    params.errorCode ?? null,
    params.errorMessage ?? null,
    nowIso,
    nowIso,
    params.nextAttemptAt ?? null,
  ];

  // max_attempts is only listed when provided so the schema default applies otherwise.
  const withMax = params.maxAttempts !== undefined;
  const columns = withMax ? `${baseColumns}, max_attempts` : baseColumns;
  const values = withMax ? [...baseValues, params.maxAttempts ?? null] : baseValues;
  const placeholders = values.map(() => "?").join(", ");

  const result = db
    .prepare(`INSERT OR IGNORE INTO lidarr_deferred_intents (${columns}) VALUES (${placeholders})`)
    .run(...values);

  const row = db
    .prepare("SELECT * FROM lidarr_deferred_intents WHERE origin = ? AND idempotency_key = ?")
    .get(params.origin, params.idempotencyKey) as DbLidarrDeferredIntent | undefined;

  if (!row) {
    throw new Error(
      `Failed to read back deferred intent after insert (operation: ${params.operation})`,
    );
  }

  if (result.changes === 0) {
    logDebug(`Deferred intent already enqueued (idempotent): ${row.id} [${row.operation}]`);
  } else {
    logDebug(`Enqueued deferred intent: ${row.id} [${row.operation}]`);
  }

  return row;
}

/**
 * Reads a single deferred-intent row by id.
 *
 * @param db - Database connection
 * @param id - Row id (UUID)
 * @returns The row, or undefined when no row has that id
 */
export function getDeferredIntentRow(
  db: DbConnection,
  id: string,
): DbLidarrDeferredIntent | undefined {
  return db.prepare("SELECT * FROM lidarr_deferred_intents WHERE id = ?").get(id) as
    | DbLidarrDeferredIntent
    | undefined;
}

/**
 * Selects rows due for replay: `status = 'pending'` with no scheduled
 * `next_attempt_at`, or one at/before `nowIso`. Ordered by `created_at`
 * (id as a deterministic tiebreak).
 *
 * @param db - Database connection
 * @param nowIso - ISO timestamp used as the due cutoff
 * @param limit - Optional maximum number of rows (positive integer)
 * @param ids - Optional exact row ids, bounded by the Lidarr plan entry cap
 * @returns Due rows in enqueue order
 * @throws Error when limit is invalid or ids exceeds the Lidarr plan entry cap
 */
export function selectDueDeferredIntents(
  db: DbConnection,
  nowIso: string,
  limit?: number,
  ids?: readonly string[],
): DbLidarrDeferredIntent[] {
  assertValidLimit(limit);
  assertValidIds(ids);

  if (ids?.length === 0) {
    return [];
  }

  const selectRows = (idChunk?: readonly string[]): DbLidarrDeferredIntent[] => {
    let sql =
      "SELECT * FROM lidarr_deferred_intents " +
      "WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ";
    const values: (string | number)[] = [nowIso];

    if (idChunk !== undefined) {
      sql += `AND id IN (${idChunk.map(() => "?").join(", ")}) `;
      values.push(...idChunk);
    }

    sql += "ORDER BY created_at ASC, id ASC";

    if (limit !== undefined) {
      sql += " LIMIT ?";
      values.push(limit);
    }

    return db.prepare(sql).all(...values) as DbLidarrDeferredIntent[];
  };

  if (ids === undefined) {
    return selectRows();
  }

  const rowsById = new Map<string, DbLidarrDeferredIntent>();
  const chunkSize = MAX_BATCH_PARAMS - 1;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    for (const row of selectRows(ids.slice(offset, offset + chunkSize))) {
      rowsById.set(row.id, row);
    }
  }

  const rows = [...rowsById.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return limit === undefined ? rows : rows.slice(0, limit);
}

/**
 * Claims a row for replay via the cross-process claim-race guard:
 * `UPDATE ... SET status = 'in-progress' WHERE id = ? AND status = 'pending'`.
 *
 * @param db - Database connection
 * @param id - Row id to claim
 * @param nowIso - ISO timestamp for updated_at (defaults to now)
 * @returns true when this caller won the claim (`changes === 1`); false when
 *   the row is missing or was already claimed/terminal
 */
export function claimDeferredIntent(
  db: DbConnection,
  id: string,
  nowIso: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      "UPDATE lidarr_deferred_intents SET status = 'in-progress', updated_at = ? " +
        "WHERE id = ? AND status = 'pending'",
    )
    .run(nowIso, id);

  return result.changes === 1;
}

/**
 * Writes the outcome of a replay attempt in a single statement: status,
 * attempt count, error fields, backoff schedule, and `last_attempt_at`.
 *
 * @param db - Database connection
 * @param id - Row id to update
 * @param update - Attempt outcome (undefined optional fields clear to NULL)
 * @param nowIso - ISO timestamp for last_attempt_at/updated_at (defaults to now)
 * @throws Error when no row has the given id
 */
export function recordDeferredIntentAttempt(
  db: DbConnection,
  id: string,
  update: DeferredIntentAttemptUpdate,
  nowIso: string = new Date().toISOString(),
): void {
  const result = db
    .prepare(
      "UPDATE lidarr_deferred_intents SET status = ?, attempts = ?, error_code = ?, " +
        "error_message = ?, next_attempt_at = ?, last_attempt_at = ?, updated_at = ? " +
        "WHERE id = ?",
    )
    .run(
      update.status,
      update.attempts,
      update.errorCode ?? null,
      update.errorMessage ?? null,
      update.nextAttemptAt ?? null,
      nowIso,
      nowIso,
      id,
    );

  if (result.changes === 0) {
    throw new Error(`Deferred intent not found: ${id}`);
  }

  logDebug(`Recorded deferred intent attempt: ${id} -> ${update.status}`);
}

/**
 * Updates only the lifecycle status of a row (e.g. resetting a claimed row
 * back to `pending` when no executor is registered).
 *
 * @param db - Database connection
 * @param id - Row id to update
 * @param status - New lifecycle status
 * @param nowIso - ISO timestamp for updated_at (defaults to now)
 * @throws Error when no row has the given id
 */
export function updateDeferredIntentStatus(
  db: DbConnection,
  id: string,
  status: DbLidarrDeferredIntentStatus,
  nowIso: string = new Date().toISOString(),
): void {
  const result = db
    .prepare("UPDATE lidarr_deferred_intents SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso, id);

  if (result.changes === 0) {
    throw new Error(`Deferred intent not found: ${id}`);
  }

  logDebug(`Updated deferred intent ${id} status to: ${status}`);
}

/**
 * Updates the status of many rows atomically (prepared statement inside
 * `db.transaction`). If any id is missing the whole batch rolls back.
 *
 * @param db - Database connection
 * @param ids - Row ids to update
 * @param status - New lifecycle status for every row
 * @param nowIso - ISO timestamp for updated_at (defaults to now)
 * @throws Error listing the missing ids (transaction rolled back)
 */
export function updateDeferredIntentStatusBatch(
  db: DbConnection,
  ids: readonly string[],
  status: DbLidarrDeferredIntentStatus,
  nowIso: string = new Date().toISOString(),
): void {
  if (ids.length === 0) {
    return;
  }

  const stmt = db.prepare(
    "UPDATE lidarr_deferred_intents SET status = ?, updated_at = ? WHERE id = ?",
  );

  const applyBatch = db.transaction((batchIds: readonly string[]) => {
    const missing: string[] = [];
    for (const id of batchIds) {
      const result = stmt.run(status, nowIso, id);
      if (result.changes === 0) {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Deferred intents not found: ${missing.join(", ")}`);
    }
  });

  applyBatch(ids);

  logDebug(`Updated ${ids.length} deferred intents to status: ${status}`);
}

/**
 * Lists deferred-intent rows, optionally filtered by status, origin,
 * operation, and/or idempotency key,
 * ordered by `created_at` (id as a deterministic tiebreak).
 *
 * @param db - Database connection
 * @param filter - Optional exact-match filters and final result limit
 * @returns Matching rows in enqueue order
 * @throws Error when filter.limit is invalid or idempotencyKeys exceeds 1,000 entries
 */
export function listDeferredIntentRows(
  db: DbConnection,
  filter: DeferredIntentRowFilter = {},
): DbLidarrDeferredIntent[] {
  assertValidLimit(filter.limit);
  assertValidIdempotencyKeys(filter.idempotencyKeys);

  if (filter.idempotencyKeys?.length === 0) {
    return [];
  }

  const clauses: string[] = [];
  const values: (string | number)[] = [];

  if (filter.status !== undefined) {
    clauses.push("status = ?");
    values.push(filter.status);
  }
  if (filter.origin !== undefined) {
    clauses.push("origin = ?");
    values.push(filter.origin);
  }
  if (filter.operation !== undefined) {
    clauses.push("operation = ?");
    values.push(filter.operation);
  }

  const selectRows = (idempotencyKeys?: readonly string[]): DbLidarrDeferredIntent[] => {
    const queryClauses = [...clauses];
    const queryValues: (string | number)[] = [...values];
    if (idempotencyKeys !== undefined) {
      queryClauses.push(`idempotency_key IN (${idempotencyKeys.map(() => "?").join(", ")})`);
      queryValues.push(...idempotencyKeys);
    }

    let sql = "SELECT * FROM lidarr_deferred_intents";
    if (queryClauses.length > 0) {
      sql += ` WHERE ${queryClauses.join(" AND ")}`;
    }
    sql += " ORDER BY created_at ASC, id ASC";

    if (idempotencyKeys === undefined && filter.limit !== undefined) {
      sql += " LIMIT ?";
      queryValues.push(filter.limit);
    }

    return db.prepare(sql).all(...queryValues) as DbLidarrDeferredIntent[];
  };

  if (filter.idempotencyKeys === undefined) {
    return selectRows();
  }

  const rowsById = new Map<string, DbLidarrDeferredIntent>();
  const chunkSize = MAX_BATCH_PARAMS - values.length;
  for (let offset = 0; offset < filter.idempotencyKeys.length; offset += chunkSize) {
    const chunk = filter.idempotencyKeys.slice(offset, offset + chunkSize);
    for (const row of selectRows(chunk)) {
      rowsById.set(row.id, row);
    }
  }

  const rows = [...rowsById.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
}

/**
 * Deletes deferred-intent rows by id and/or status (AND semantics when both
 * are provided). Id batches are chunked to stay under SQLite's bound-variable
 * limit and applied atomically inside a transaction.
 *
 * @param db - Database connection
 * @param filter - Ids and/or statuses to delete (at least one required)
 * @returns Number of rows deleted
 * @throws Error when neither ids nor statuses is provided
 */
export function clearDeferredIntentRows(
  db: DbConnection,
  filter: ClearDeferredIntentRowsFilter,
): number {
  if (filter.ids === undefined && filter.statuses === undefined) {
    throw new Error("clearDeferredIntentRows requires at least one of ids or statuses");
  }

  // An explicitly empty selector can never match anything.
  if (filter.ids?.length === 0 || filter.statuses?.length === 0) {
    return 0;
  }

  const statusClause = filter.statuses
    ? `status IN (${filter.statuses.map(() => "?").join(", ")})`
    : undefined;

  if (filter.ids === undefined) {
    const statuses = filter.statuses ?? [];
    const result = db
      .prepare(`DELETE FROM lidarr_deferred_intents WHERE ${statusClause}`)
      .run(...statuses);
    return result.changes;
  }

  const ids = filter.ids;
  let removed = 0;

  const deleteChunks = db.transaction(() => {
    for (let offset = 0; offset < ids.length; offset += MAX_BATCH_PARAMS) {
      const chunk = ids.slice(offset, offset + MAX_BATCH_PARAMS);
      const idClause = `id IN (${chunk.map(() => "?").join(", ")})`;
      const where = statusClause ? `${idClause} AND ${statusClause}` : idClause;
      const result = db
        .prepare(`DELETE FROM lidarr_deferred_intents WHERE ${where}`)
        .run(...chunk, ...(filter.statuses ?? []));
      removed += result.changes;
    }
  });

  deleteChunks();
  return removed;
}

/**
 * Counts deferred intents grouped by status. Every status key is present
 * (zero when no rows), which is what the resilience snapshot consumes.
 *
 * @param db - Database connection
 * @param origin - Optional credential-free canonical origin; when provided,
 *   only that origin's rows are counted (served by
 *   `idx_lidarr_deferred_intents_origin`)
 * @returns Counts per lifecycle status
 */
export function countDeferredIntentsByStatus(
  db: DbConnection,
  origin?: string,
): Record<DbLidarrDeferredIntentStatus, number> {
  const counts: Record<DbLidarrDeferredIntentStatus, number> = {
    pending: 0,
    "in-progress": 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };

  let sql = "SELECT status, COUNT(*) as count FROM lidarr_deferred_intents";
  const values: string[] = [];
  if (origin !== undefined) {
    sql += " WHERE origin = ?";
    values.push(origin);
  }
  sql += " GROUP BY status";

  const rows = db.prepare(sql).all(...values) as Array<{
    status: DbLidarrDeferredIntentStatus;
    count: number;
  }>;

  for (const row of rows) {
    counts[row.status] = row.count;
  }

  return counts;
}
