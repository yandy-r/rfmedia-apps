/**
 * State query operations for rfapps CLI.
 *
 * Provides read-only query operations for deployment history and rollback
 * target identification. All queries use parameterized SQL to prevent
 * injection attacks.
 *
 * Key functions:
 * - {@link getDeploymentHistory} - Query history with filters (service, action, date)
 * - {@link findRollbackTarget} - Find Nth previous successful deployment
 * - {@link findDeploymentById} - Look up specific deployment by ID
 * - {@link getSuccessfulDeploymentCount} - Count successful deployments for validation
 * - {@link getDeploymentCount} - Count total matching deployments
 *
 * Query Building:
 * - WHERE clauses are built dynamically based on provided filters
 * - All filter values are passed as parameterized query arguments
 * - Results are ordered by timestamp DESC (newest first)
 */

import { logDebug } from "@rfmedia/common";

import type { DbConnection } from "./db.js";
import type {
  StateEntry,
  StateEntryRow,
  HistoryOptions,
  DeploymentAction,
  DeploymentStatus,
} from "../types/state.js";

/**
 * Default limit for history queries when not specified in options.
 * Prevents unbounded result sets from overwhelming output.
 */
const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Transforms a database row to a StateEntry object.
 *
 * Handles null/undefined conversions for optional fields and
 * validates action and status values.
 *
 * @param row - Raw database row
 * @returns Transformed StateEntry
 */
function rowToStateEntry(row: StateEntryRow): StateEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    service: row.service,
    action: row.action as DeploymentAction,
    imageTag: row.image_tag ?? undefined,
    imageId: row.image_id ?? undefined,
    imageDigest: row.image_digest ?? undefined,
    configSnapshot: row.config_snapshot ?? undefined,
    status: row.status as DeploymentStatus,
    planId: row.plan_id ?? undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

/**
 * Gets deployment history with optional filtering.
 *
 * Supports filtering by service name, action type, and timestamp.
 * Results are ordered by timestamp descending (newest first).
 *
 * @param db - Database connection
 * @param options - Query options for filtering and limiting results
 * @returns Array of matching deployment entries
 *
 * @example
 * ```typescript
 * // Get last 10 deployments for all services
 * const history = getDeploymentHistory(db, {});
 *
 * // Get last 5 deployments for traefik
 * const traefikHistory = getDeploymentHistory(db, {
 *   service: "traefik",
 *   limit: 5
 * });
 *
 * // Get all rebuild actions since a specific date
 * const rebuilds = getDeploymentHistory(db, {
 *   action: "rebuild",
 *   since: "2024-01-01T00:00:00Z"
 * });
 * ```
 */
export function getDeploymentHistory(db: DbConnection, options: HistoryOptions): StateEntry[] {
  // Dynamic query building: collect conditions and their parameter values
  // in parallel arrays to ensure proper parameterization
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Each filter adds a condition with a placeholder (?) and the value to params
  if (options.service) {
    conditions.push("service = ?");
    params.push(options.service);
  }

  if (options.action) {
    conditions.push("action = ?");
    params.push(options.action);
  }

  if (options.since) {
    conditions.push("timestamp >= ?");
    params.push(options.since);
  }

  // Join conditions with AND; empty conditions array results in no WHERE clause
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;

  const query = `
    SELECT id, timestamp, service, action, image_tag, image_id, image_digest, config_snapshot,
           status, plan_id, error_message
    FROM deployments
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ?
  `;

  params.push(limit);

  logDebug(`Querying deployment history: ${conditions.length} filter(s), limit ${limit}`);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as StateEntryRow[];

  return rows.map(rowToStateEntry);
}

/**
 * Finds the rollback target for a service N steps back.
 *
 * Only considers successful deployments (status = 'success') as valid
 * rollback targets. Steps are counted from the most recent successful
 * deployment, not including the current deployment.
 *
 * For example, with steps = 1, returns the second-most-recent successful
 * deployment (the one before the current). With steps = 2, returns the
 * third-most-recent successful deployment.
 *
 * @param db - Database connection
 * @param service - Service name to find rollback target for
 * @param steps - Number of successful deployments to go back (1 = previous)
 * @returns The target deployment entry if found, undefined otherwise
 *
 * @example
 * ```typescript
 * // Find the previous successful deployment for traefik
 * const target = findRollbackTarget(db, "traefik", 1);
 * if (target) {
 *   console.log(`Can rollback to deployment ${target.id} from ${target.timestamp}`);
 * }
 *
 * // Find deployment 3 versions back
 * const olderTarget = findRollbackTarget(db, "traefik", 3);
 * ```
 */
export function findRollbackTarget(
  db: DbConnection,
  service: string,
  steps: number,
): StateEntry | undefined {
  if (steps < 1) {
    logDebug(`Invalid rollback steps: ${steps}, must be >= 1`);
    return undefined;
  }

  // SQL OFFSET is 0-indexed, so:
  // - steps=1: OFFSET 1 skips the current deployment (row 0), returns previous (row 1)
  // - steps=2: OFFSET 2 skips current and previous, returns the one before that (row 2)
  // This means "rollback 1 step" gives you the deployment before the current one
  const stmt = db.prepare(`
    SELECT id, timestamp, service, action, image_tag, image_id, image_digest, config_snapshot,
           status, plan_id, error_message
    FROM deployments
    WHERE service = ? AND status = 'success'
    ORDER BY timestamp DESC
    LIMIT 1 OFFSET ?
  `);

  const row = stmt.get(service, steps) as StateEntryRow | undefined;

  if (!row) {
    logDebug(`No rollback target found for ${service} at ${steps} step(s) back`);
    return undefined;
  }

  logDebug(`Found rollback target for ${service}: deployment ${row.id} from ${row.timestamp}`);
  return rowToStateEntry(row);
}

/**
 * Finds a deployment by its ID.
 *
 * Used for the --to-deployment option in rollback to target a specific
 * deployment ID directly.
 *
 * @param db - Database connection
 * @param deploymentId - The deployment ID to find (as string for CLI input)
 * @returns The deployment entry if found, undefined otherwise
 *
 * @example
 * ```typescript
 * // Find deployment by ID (from CLI --to-deployment option)
 * const target = findDeploymentById(db, "42");
 * if (target && target.status === "success") {
 *   console.log(`Can rollback to ${target.service} from ${target.timestamp}`);
 * }
 * ```
 */
export function findDeploymentById(db: DbConnection, deploymentId: string): StateEntry | undefined {
  if (!/^\d+$/.test(deploymentId)) {
    logDebug(`Invalid deployment ID: ${deploymentId}`);
    return undefined;
  }

  const id = parseInt(deploymentId, 10);

  const stmt = db.prepare(`
    SELECT id, timestamp, service, action, image_tag, image_id, image_digest, config_snapshot,
           status, plan_id, error_message
    FROM deployments
    WHERE id = ?
  `);

  const row = stmt.get(id) as StateEntryRow | undefined;

  if (!row) {
    logDebug(`Deployment not found: ${deploymentId}`);
    return undefined;
  }

  logDebug(`Found deployment ${deploymentId}: ${row.service} (${row.action})`);
  return rowToStateEntry(row);
}

/**
 * Gets the count of successful deployments for a service.
 *
 * Used to validate that enough deployment history exists for the
 * requested number of rollback steps.
 *
 * @param db - Database connection
 * @param service - Service name to count deployments for
 * @returns Count of successful deployments
 *
 * @example
 * ```typescript
 * const count = getSuccessfulDeploymentCount(db, "traefik");
 * if (count < 2) {
 *   console.log("Not enough deployment history for rollback");
 * }
 * ```
 */
export function getSuccessfulDeploymentCount(db: DbConnection, service: string): number {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM deployments
    WHERE service = ? AND status = 'success'
  `);

  const row = stmt.get(service) as { count: number };
  const count = row.count;

  logDebug(`Successful deployment count for ${service}: ${count}`);
  return count;
}

/**
 * Gets the total count of deployments matching the given filters.
 *
 * Useful for determining total result set size before applying limit,
 * enabling pagination or informing users about filtered vs total counts.
 *
 * @param db - Database connection
 * @param options - Query options for filtering (limit is ignored)
 * @returns Total count of matching deployments
 *
 * @example
 * ```typescript
 * // Get total count for a service
 * const total = getDeploymentCount(db, { service: "traefik" });
 * console.log(`Total deployments for traefik: ${total}`);
 * ```
 */
export function getDeploymentCount(
  db: DbConnection,
  options: Omit<HistoryOptions, "limit">,
): number {
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.service) {
    conditions.push("service = ?");
    params.push(options.service);
  }

  if (options.action) {
    conditions.push("action = ?");
    params.push(options.action);
  }

  if (options.since) {
    conditions.push("timestamp >= ?");
    params.push(options.since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    SELECT COUNT(*) as count
    FROM deployments
    ${whereClause}
  `;

  const stmt = db.prepare(query);
  const row = stmt.get(...params) as { count: number };

  return row.count;
}
