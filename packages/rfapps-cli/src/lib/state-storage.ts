/**
 * State storage operations for rfapps CLI.
 *
 * Provides CRUD operations for deployment state records including
 * recording deployments, updating status, and querying by ID or service.
 *
 * Key functions:
 * - {@link recordDeployment} - Insert new deployment records
 * - {@link updateDeploymentStatus} - Update status after deployment completes
 * - {@link getDeployment} - Fetch by ID
 * - {@link getLatestDeployment} - Fetch most recent for a service
 *
 * Generational snapshots:
 * - Recording a successful deploy-like deployment (deploy, rebuild, apply,
 *   rollback, update) automatically appends an immutable generation snapshot via
 *   {@link createGeneration}, so every call site gets generations for free.
 *
 * Security:
 * - Use {@link maskSensitiveEnvVars} to filter secrets before storing config snapshots
 * - Sensitive patterns include: token, password, secret, key, auth, credential
 */

import { logDebug } from "@rfmedia/common";

import type { DbConnection } from "./db.js";
import type {
  StateEntry,
  StateEntryInput,
  StateEntryRow,
  DeploymentStatus,
  DeploymentAction,
  GenerationAction,
} from "../types/state.js";
import { createGeneration } from "./generations.js";

/**
 * Regex patterns for sensitive environment variable keys that should be masked.
 *
 * These patterns are tested against environment variable names (keys, not values).
 * Matches common patterns like *_TOKEN, *_PASSWORD, *_SECRET, *_KEY, etc.
 * All patterns are case-insensitive.
 */
const SENSITIVE_KEY_PATTERNS = [
  /token/i, // PLEX_TOKEN, API_TOKEN, AUTH_TOKEN
  /password/i, // DB_PASSWORD, ADMIN_PASSWORD
  /secret/i, // CLIENT_SECRET, JWT_SECRET
  /key$/i, // API_KEY, PRIVATE_KEY (but not KEYBOARD)
  /api_key/i, // API_KEY, THIRD_PARTY_API_KEY
  /apikey/i, // APIKEY (no underscore variant)
  /auth/i, // AUTHKEY, OAUTH_TOKEN, TS_AUTHKEY
  /credential/i, // AWS_CREDENTIALS, DB_CREDENTIAL
  /private/i, // PRIVATE_KEY, PRIVATE_TOKEN
];

/**
 * Mask for sensitive values in config snapshots.
 */
const MASKED_VALUE = "***MASKED***";

/**
 * Deploy-like actions that produce a generation snapshot when successful.
 *
 * Destructive actions (delete, prune) do not create generations because the
 * service no longer has a running configuration to snapshot. `import` adopts an
 * externally-created running service, recording its observed state as the
 * service's baseline generation.
 *
 * Exported so state-database reconstruction re-derives generations with the same
 * vocabulary that {@link recordDeployments} uses.
 */
export const GENERATION_ACTIONS: ReadonlySet<DeploymentAction> = new Set<DeploymentAction>([
  "deploy",
  "rebuild",
  "apply",
  "rollback",
  "update",
  "import",
]);

/**
 * Determines whether a deployment entry should produce a generation snapshot.
 *
 * @param entry - Deployment entry being recorded
 * @returns true for successful deploy-like actions
 */
function shouldCreateGeneration(entry: StateEntryInput): boolean {
  return entry.status === "success" && GENERATION_ACTIONS.has(entry.action);
}

/**
 * Appends a generation snapshot for a recorded deployment.
 *
 * @param db - Database connection
 * @param entry - Deployment entry that was recorded
 * @param deploymentId - ID of the recorded deployment row
 */
function recordGeneration(db: DbConnection, entry: StateEntryInput, deploymentId: number): void {
  createGeneration(db, {
    service: entry.service,
    deploymentId,
    timestamp: entry.timestamp,
    imageTag: entry.imageTag,
    imageId: entry.imageId,
    imageDigest: entry.imageDigest,
    configSnapshot: entry.configSnapshot,
    createdByAction: entry.action as GenerationAction,
  });
}

/**
 * Masks sensitive values in an environment variables object.
 *
 * Filters environment variables that contain tokens, passwords, secrets,
 * keys, or other sensitive data patterns. Returns a new object with
 * sensitive values replaced by a mask string.
 *
 * @param env - Environment variables record (key-value pairs)
 * @returns New record with sensitive values replaced by "***MASKED***"
 *
 * @example
 * ```typescript
 * const env = {
 *   PLEX_URL: "https://plex.example.com",
 *   PLEX_TOKEN: "secret-token-123",
 *   TZ: "America/New_York"
 * };
 * const masked = maskSensitiveEnvVars(env);
 * // Result: { PLEX_URL: "...", PLEX_TOKEN: "***MASKED***", TZ: "..." }
 * ```
 */
export function maskSensitiveEnvVars(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    masked[key] = isSensitive ? MASKED_VALUE : value;
  }

  return masked;
}

/**
 * Transforms a database row to a StateEntry object.
 *
 * Converts SQLite null values to undefined and casts string columns
 * to their typed equivalents (DeploymentAction, DeploymentStatus).
 *
 * @param row - Raw database row with snake_case columns and nullable fields
 * @returns Transformed StateEntry with camelCase properties and undefined for missing values
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
 * Records a new deployment in the state database.
 *
 * Inserts a deployment record with service information, action type,
 * optional image tag, configuration snapshot, and status.
 *
 * Successful deploy-like entries (deploy, rebuild, apply, rollback, update)
 * also append an immutable generation snapshot for the service in the same
 * transaction as the deployment row.
 *
 * Note: Sensitive data in configSnapshot should be masked before calling
 * this function. The configSnapshot is stored as-is.
 *
 * @param db - Database connection
 * @param entry - Deployment entry without id (auto-generated)
 * @returns The generated id of the inserted record
 *
 * @example
 * ```typescript
 * const db = await initializeDatabase();
 * const id = recordDeployment(db, {
 *   timestamp: new Date().toISOString(),
 *   service: "traefik",
 *   action: "deploy",
 *   imageTag: "traefik:v2.10.4",
 *   status: "success"
 * });
 * ```
 */
export function recordDeployment(db: DbConnection, entry: StateEntryInput): number {
  const stmt = db.prepare(`
    INSERT INTO deployments (
      timestamp, service, action, image_tag, image_id, image_digest,
      config_snapshot, status, plan_id, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insert = db.transaction((entry: StateEntryInput): number => {
    const result = stmt.run(
      entry.timestamp,
      entry.service,
      entry.action,
      entry.imageTag ?? null,
      entry.imageId ?? null,
      entry.imageDigest ?? null,
      entry.configSnapshot ?? null,
      entry.status,
      entry.planId ?? null,
      entry.errorMessage ?? null,
    );

    const deploymentId = Number(result.lastInsertRowid);
    if (shouldCreateGeneration(entry)) {
      recordGeneration(db, entry, deploymentId);
    }

    return deploymentId;
  });

  const deploymentId = insert(entry);
  logDebug(`Recorded deployment ${deploymentId}: ${entry.service} (${entry.action})`);
  return deploymentId;
}

/**
 * Updates the status of an existing deployment record.
 *
 * Can also set an error message when updating to failed status.
 *
 * @param db - Database connection
 * @param id - Deployment record id to update
 * @param status - New deployment status
 * @param errorMessage - Optional error message (typically for failed status)
 *
 * @example
 * ```typescript
 * // Mark deployment as failed with error message
 * updateDeploymentStatus(db, deploymentId, "failed", "Container failed to start");
 *
 * // Mark deployment as rolled back
 * updateDeploymentStatus(db, deploymentId, "rolled_back");
 * ```
 */
export function updateDeploymentStatus(
  db: DbConnection,
  id: number,
  status: DeploymentStatus,
  errorMessage?: string,
): void {
  const stmt = db.prepare(`
    UPDATE deployments
    SET status = ?, error_message = ?
    WHERE id = ?
  `);

  stmt.run(status, errorMessage ?? null, id);
  logDebug(`Updated deployment ${id} status to: ${status}`);
}

/**
 * Gets a deployment record by its id.
 *
 * @param db - Database connection
 * @param id - Deployment record id
 * @returns The deployment entry if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const deployment = getDeployment(db, 42);
 * if (deployment) {
 *   console.log(`Service: ${deployment.service}, Status: ${deployment.status}`);
 * }
 * ```
 */
export function getDeployment(db: DbConnection, id: number): StateEntry | undefined {
  const stmt = db.prepare(`
    SELECT id, timestamp, service, action, image_tag, image_id, image_digest,
           config_snapshot, status, plan_id, error_message
    FROM deployments
    WHERE id = ?
  `);

  const row = stmt.get(id) as StateEntryRow | undefined;
  if (!row) {
    return undefined;
  }

  return rowToStateEntry(row);
}

/**
 * Gets the most recent deployment for a specific service.
 *
 * Retrieves the latest deployment record (by timestamp) for the
 * given service name.
 *
 * @param db - Database connection
 * @param service - Service name to query
 * @returns The latest deployment entry if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const latest = getLatestDeployment(db, "traefik");
 * if (latest) {
 *   console.log(`Last deployed: ${latest.timestamp}, Image: ${latest.imageTag}`);
 * }
 * ```
 */
export function getLatestDeployment(db: DbConnection, service: string): StateEntry | undefined {
  const stmt = db.prepare(`
    SELECT id, timestamp, service, action, image_tag, image_id, image_digest,
           config_snapshot, status, plan_id, error_message
    FROM deployments
    WHERE service = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(service) as StateEntryRow | undefined;
  if (!row) {
    return undefined;
  }

  return rowToStateEntry(row);
}

/**
 * Records multiple deployments in a single transaction (batch insert).
 *
 * Uses SQLite transactions for atomicity and significantly better performance
 * compared to individual inserts. All entries are inserted or none if an error occurs.
 *
 * Successful deploy-like entries (deploy, rebuild, apply, rollback, update) also
 * append immutable generation snapshots within the same transaction.
 *
 * @param db - Database connection
 * @param entries - Array of deployment entries without ids (auto-generated)
 * @returns Array of generated ids for the inserted records
 *
 * @example
 * ```typescript
 * const db = await initializeDatabase();
 * const timestamp = new Date().toISOString();
 *
 * const entries = services.map(service => ({
 *   timestamp,
 *   service,
 *   action: "deploy" as const,
 *   imageTag: imageMap.get(service),
 *   status: "success" as const,
 * }));
 *
 * const ids = recordDeployments(db, entries);
 * console.log(`Recorded ${ids.length} deployments`);
 * ```
 */
export function recordDeployments(db: DbConnection, entries: StateEntryInput[]): number[] {
  if (entries.length === 0) {
    return [];
  }

  const stmt = db.prepare(`
    INSERT INTO deployments (
      timestamp, service, action, image_tag, image_id, image_digest,
      config_snapshot, status, plan_id, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ids: number[] = [];

  const insertMany = db.transaction((entries: StateEntryInput[]) => {
    for (const entry of entries) {
      const result = stmt.run(
        entry.timestamp,
        entry.service,
        entry.action,
        entry.imageTag ?? null,
        entry.imageId ?? null,
        entry.imageDigest ?? null,
        entry.configSnapshot ?? null,
        entry.status,
        entry.planId ?? null,
        entry.errorMessage ?? null,
      );
      const deploymentId = Number(result.lastInsertRowid);
      ids.push(deploymentId);

      if (shouldCreateGeneration(entry)) {
        recordGeneration(db, entry, deploymentId);
      }
    }
  });

  insertMany(entries);
  logDebug(`Recorded ${ids.length} deployments in batch`);
  return ids;
}
