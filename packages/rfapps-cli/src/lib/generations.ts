/**
 * Generation snapshot operations for rfapps CLI.
 *
 * Implements Nix-style generational state: every successful deploy-like
 * action (deploy, rebuild, apply, rollback) appends an immutable, per-service
 * numbered generation snapshot. Generations are append-only — they are never
 * updated or deleted — which makes them stable restore targets independent of
 * later changes to the deployments table.
 *
 * Restore scope: a generation records the image reference and a config snapshot
 * for audit. Restoring applies the image only — config comes from the current
 * compose file, and volumes/databases are never rolled back.
 *
 * Key functions:
 * - {@link createGeneration} - Append a new generation (next per-service number)
 * - {@link getGenerations} - List generations (newest first) with filters
 * - {@link findGenerationByNumber} - Look up a specific generation for a service
 * - {@link findLatestGenerationByImageId} - Find the newest exact-image recovery anchor
 * - {@link findGenerationAtTime} - Find the generation active at a point in time
 * - {@link getGenerationCount} - Count generations for validation/pagination
 */

import { logDebug } from "@rfmedia/common";

import type { DbConnection } from "./db.js";
import type {
  GenerationAction,
  GenerationEntry,
  GenerationInput,
  GenerationRow,
  GenerationsOptions,
} from "../types/state.js";

/**
 * Default limit for generation queries when not specified in options.
 */
const DEFAULT_GENERATIONS_LIMIT = 10;

/**
 * Columns selected for generation queries, matching {@link GenerationRow}.
 */
const GENERATION_COLUMNS =
  "id, service, generation, deployment_id, timestamp, image_tag, image_id, image_digest, config_snapshot, created_by_action";

/**
 * Transforms a database row to a GenerationEntry object.
 *
 * Converts SQLite null values to undefined and casts the action column
 * to its typed equivalent.
 *
 * @param row - Raw database row with snake_case columns and nullable fields
 * @returns Transformed GenerationEntry with camelCase properties
 */
function rowToGenerationEntry(row: GenerationRow): GenerationEntry {
  return {
    id: row.id,
    service: row.service,
    generation: row.generation,
    deploymentId: row.deployment_id ?? undefined,
    timestamp: row.timestamp,
    imageTag: row.image_tag ?? undefined,
    imageId: row.image_id ?? undefined,
    imageDigest: row.image_digest ?? undefined,
    configSnapshot: row.config_snapshot ?? undefined,
    createdByAction: row.created_by_action as GenerationAction,
  };
}

/**
 * Creates a new immutable generation snapshot for a service.
 *
 * Computes the next per-service generation number and inserts the snapshot
 * atomically in a transaction, so concurrent inserts cannot produce duplicate
 * generation numbers for the same service.
 *
 * Note: Sensitive data in configSnapshot should be masked before calling
 * this function (see maskSensitiveEnvVars). The snapshot is stored as-is.
 *
 * @param db - Database connection
 * @param input - Generation data without id/generation (both auto-assigned)
 * @returns The assigned per-service generation number
 *
 * @example
 * ```typescript
 * const generation = createGeneration(db, {
 *   service: "traefik",
 *   deploymentId: 42,
 *   timestamp: new Date().toISOString(),
 *   imageTag: "traefik:v3.1",
 *   configSnapshot: JSON.stringify({ image: "traefik:v3.1" }),
 *   createdByAction: "deploy",
 * });
 * // generation === 7 (next number for traefik)
 * ```
 */
export function createGeneration(db: DbConnection, input: GenerationInput): number {
  const insert = db.transaction((entry: GenerationInput): number => {
    const nextRow = db
      .prepare("SELECT COALESCE(MAX(generation), 0) + 1 as next FROM generations WHERE service = ?")
      .get(entry.service) as { next: number };

    db.prepare(
      `
      INSERT INTO generations (
        service, generation, deployment_id, timestamp,
        image_tag, image_id, image_digest, config_snapshot, created_by_action
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      entry.service,
      nextRow.next,
      entry.deploymentId ?? null,
      entry.timestamp,
      entry.imageTag ?? null,
      entry.imageId ?? null,
      entry.imageDigest ?? null,
      entry.configSnapshot ?? null,
      entry.createdByAction,
    );

    return nextRow.next;
  });

  const generation = insert(input);
  logDebug(`Created generation ${generation} for ${input.service} (${input.createdByAction})`);
  return generation;
}

/**
 * Gets generation snapshots with optional filtering.
 *
 * Results are ordered newest first (by per-service generation number when
 * filtered to one service, by timestamp across services otherwise).
 *
 * @param db - Database connection
 * @param options - Query options for filtering and limiting results
 * @returns Array of matching generation entries
 *
 * @example
 * ```typescript
 * // Last 10 generations across all services
 * const all = getGenerations(db, {});
 *
 * // Last 5 generations for traefik
 * const traefik = getGenerations(db, { service: "traefik", limit: 5 });
 * ```
 */
export function getGenerations(db: DbConnection, options: GenerationsOptions): GenerationEntry[] {
  const limit = options.limit ?? DEFAULT_GENERATIONS_LIMIT;

  let query: string;
  const params: (string | number)[] = [];

  if (options.service) {
    query = `
      SELECT ${GENERATION_COLUMNS}
      FROM generations
      WHERE service = ?
      ORDER BY generation DESC
      LIMIT ?
    `;
    params.push(options.service, limit);
  } else {
    query = `
      SELECT ${GENERATION_COLUMNS}
      FROM generations
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  logDebug(`Querying generations: service=${options.service ?? "(all)"}, limit ${limit}`);

  const rows = db.prepare(query).all(...params) as GenerationRow[];
  return rows.map(rowToGenerationEntry);
}

/**
 * Finds a specific generation for a service by its generation number.
 *
 * @param db - Database connection
 * @param service - Service name
 * @param generation - Per-service generation number
 * @returns The generation entry if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const target = findGenerationByNumber(db, "traefik", 5);
 * if (target) {
 *   console.log(`Generation 5 image: ${target.imageTag}`);
 * }
 * ```
 */
export function findGenerationByNumber(
  db: DbConnection,
  service: string,
  generation: number,
): GenerationEntry | undefined {
  const row = db
    .prepare(
      `
      SELECT ${GENERATION_COLUMNS}
      FROM generations
      WHERE service = ? AND generation = ?
    `,
    )
    .get(service, generation) as GenerationRow | undefined;

  if (!row) {
    logDebug(`Generation ${generation} not found for ${service}`);
    return undefined;
  }

  return rowToGenerationEntry(row);
}

/**
 * Finds the newest exact-image recovery generation for one service.
 *
 * This lookup is intentionally executed in SQLite rather than loading a broad
 * generation history into JavaScript. The matching composite index keeps plan
 * generation bounded even for long-lived state databases.
 */
export function findLatestGenerationByImageId(
  db: DbConnection,
  service: string,
  imageId: string,
): GenerationEntry | undefined {
  const row = db
    .prepare(
      `
      SELECT ${GENERATION_COLUMNS}
      FROM generations
      WHERE service = ? AND image_id = ?
      ORDER BY generation DESC
      LIMIT 1
    `,
    )
    .get(service, imageId) as GenerationRow | undefined;

  if (!row) {
    logDebug(`No recovery generation found for ${service} with the requested image identity`);
    return undefined;
  }
  return rowToGenerationEntry(row);
}

/**
 * Finds the generation that was active for a service at a point in time.
 *
 * Returns the newest generation whose timestamp is at or before the given
 * time — i.e., the configuration the service was running at that moment.
 *
 * @param db - Database connection
 * @param service - Service name
 * @param isoTime - ISO 8601 timestamp to query at
 * @returns The generation entry if one existed at that time, undefined otherwise
 *
 * @example
 * ```typescript
 * // What was traefik running at the start of the month?
 * const target = findGenerationAtTime(db, "traefik", "2026-06-01T00:00:00.000Z");
 * ```
 */
export function findGenerationAtTime(
  db: DbConnection,
  service: string,
  isoTime: string,
): GenerationEntry | undefined {
  const row = db
    .prepare(
      `
      SELECT ${GENERATION_COLUMNS}
      FROM generations
      WHERE service = ? AND timestamp <= ?
      ORDER BY timestamp DESC, generation DESC
      LIMIT 1
    `,
    )
    .get(service, isoTime) as GenerationRow | undefined;

  if (!row) {
    logDebug(`No generation found for ${service} at or before ${isoTime}`);
    return undefined;
  }

  logDebug(`Generation active for ${service} at ${isoTime}: ${row.generation}`);
  return rowToGenerationEntry(row);
}

/**
 * Gets the count of generations matching the given filters.
 *
 * @param db - Database connection
 * @param options - Query options for filtering (limit is ignored)
 * @returns Total count of matching generations
 *
 * @example
 * ```typescript
 * const total = getGenerationCount(db, { service: "traefik" });
 * ```
 */
export function getGenerationCount(
  db: DbConnection,
  options: Omit<GenerationsOptions, "limit">,
): number {
  let row: { count: number };

  if (options.service) {
    row = db
      .prepare("SELECT COUNT(*) as count FROM generations WHERE service = ?")
      .get(options.service) as { count: number };
  } else {
    row = db.prepare("SELECT COUNT(*) as count FROM generations").get() as { count: number };
  }

  return row.count;
}
