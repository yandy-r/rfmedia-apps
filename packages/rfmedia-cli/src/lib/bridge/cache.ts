/**
 * Strict SQLite persistence for complete Plex-Lidarr identity snapshots.
 *
 * This module is the sole owner of bridge_identity_snapshots CRUD. Both writes
 * and reads cross the same unknown-to-domain projector so cached JSON can never
 * become trusted through a type assertion.
 */

import {
  BRIDGE_ARTIST_MAX_RECORDS,
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  BridgeIdentityCacheError,
  type BridgeArtistIdentitySnapshot,
  type BridgeIdentityCompatibleScopeResult,
  type BridgeIdentityCompatibleScopeSelector,
  type BridgeIdentityProvenance,
  type BridgeIdentityScope,
} from "../../types/bridge.js";
import type { DbConnection } from "../../types/db.js";
import {
  cacheError,
  canonicalTimestamp,
  projectCompatibleScopeSelector,
  projectScope,
  projectSnapshot,
  sameScope,
  type CacheOperation,
} from "./cache-codec.js";

const MAX_COMPATIBLE_SCOPE_RESULTS = BRIDGE_ARTIST_MAX_RECORDS;
const CACHE_READ_FRESHNESS: BridgeIdentityProvenance["freshness"] = "stale";

interface BridgeIdentitySnapshotRow {
  readonly plex_origin: unknown;
  readonly plex_machine_id: unknown;
  readonly plex_library_id: unknown;
  readonly lidarr_origin: unknown;
  readonly entity_kind: unknown;
  readonly snapshot_version: unknown;
  readonly resolver_version: unknown;
  readonly payload_json: unknown;
  readonly captured_at: unknown;
  readonly verified_at: unknown;
}

type BridgeIdentityScopeRow = Omit<BridgeIdentitySnapshotRow, "payload_json">;

function asDatabaseError(operation: CacheOperation, error: unknown): never {
  if (error instanceof BridgeIdentityCacheError) throw error;
  throw cacheError(
    operation,
    "database",
    "Bridge identity cache database operation failed.",
    error,
  );
}

/**
 * Finds bounded compatible cache scopes without provider credentials or writes.
 *
 * Results retain the exact machine and library scope and are ordered by that
 * identity. The caller must decide whether zero, one, or many is acceptable.
 */
export function findCompatibleBridgeIdentityScopes(
  db: DbConnection,
  inputSelector: BridgeIdentityCompatibleScopeSelector,
  now: () => Date = () => new Date(),
): readonly BridgeIdentityCompatibleScopeResult[] {
  const operation = "read";
  const selector = projectCompatibleScopeSelector(inputSelector, operation);
  const libraryPredicate = selector.plexLibraryId === undefined ? "" : " AND plex_library_id = ?";
  const scopeParameters: readonly unknown[] =
    selector.plexLibraryId === undefined
      ? [selector.plexOrigin, selector.lidarrOrigin, selector.entityKind]
      : [selector.plexOrigin, selector.lidarrOrigin, selector.entityKind, selector.plexLibraryId];
  const compatibleParameters: readonly unknown[] = [
    ...scopeParameters,
    BRIDGE_IDENTITY_SNAPSHOT_VERSION,
    BRIDGE_ARTIST_RESOLVER_VERSION,
    BRIDGE_ARTIST_NORMALIZATION_VERSION,
    BRIDGE_ARTIST_SCORING_VERSION,
    MAX_COMPATIBLE_SCOPE_RESULTS + 1,
  ];

  let rows: readonly BridgeIdentityScopeRow[];
  let hasMatchingEvidence = false;
  let hasCorruptCurrentEvidence = false;
  try {
    rows = db
      .prepare(
        `SELECT plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind,
                snapshot_version, resolver_version, captured_at, verified_at
         FROM bridge_identity_snapshots
         WHERE plex_origin = ? AND lidarr_origin = ? AND entity_kind = ?${libraryPredicate}
           AND snapshot_version = ? AND resolver_version = ?
           AND CASE WHEN json_valid(payload_json)
                    THEN json_type(payload_json, '$.normalizationVersion') = 'integer'
                    ELSE 0 END
           AND CASE WHEN json_valid(payload_json)
                    THEN json_extract(payload_json, '$.normalizationVersion') END = ?
           AND CASE WHEN json_valid(payload_json)
                    THEN json_type(payload_json, '$.scoringVersion') = 'integer'
                    ELSE 0 END
           AND CASE WHEN json_valid(payload_json)
                    THEN json_extract(payload_json, '$.scoringVersion') END = ?
         ORDER BY plex_machine_id ASC, plex_library_id ASC
         LIMIT ?`,
      )
      .all(...compatibleParameters) as BridgeIdentityScopeRow[];
    if (rows.length === 0) {
      hasCorruptCurrentEvidence =
        db
          .prepare(
            `SELECT 1
             FROM bridge_identity_snapshots
             WHERE plex_origin = ? AND lidarr_origin = ? AND entity_kind = ?${libraryPredicate}
               AND snapshot_version = ? AND resolver_version = ?
               AND CASE
                     WHEN json_valid(payload_json) THEN
                       json_type(payload_json) IS NOT 'object'
                       OR json_type(payload_json, '$.normalizationVersion') IS NOT 'integer'
                       OR json_type(payload_json, '$.scoringVersion') IS NOT 'integer'
                     ELSE 1
                   END
             LIMIT 1`,
          )
          .get(
            ...scopeParameters,
            BRIDGE_IDENTITY_SNAPSHOT_VERSION,
            BRIDGE_ARTIST_RESOLVER_VERSION,
          ) !== undefined;
      hasMatchingEvidence =
        db
          .prepare(
            `SELECT 1
             FROM bridge_identity_snapshots
             WHERE plex_origin = ? AND lidarr_origin = ? AND entity_kind = ?${libraryPredicate}
             LIMIT 1`,
          )
          .get(...scopeParameters) !== undefined;
    }
  } catch (error) {
    return asDatabaseError(operation, error);
  }
  if (rows.length > MAX_COMPATIBLE_SCOPE_RESULTS) {
    throw cacheError(
      operation,
      "invalid-snapshot",
      "Bridge identity cache contains too many compatible scopes.",
    );
  }

  const nowMilliseconds = now().getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw cacheError(operation, "invalid-snapshot", "Bridge identity cache clock is invalid.");
  }
  if (rows.length === 0 && hasCorruptCurrentEvidence) {
    throw cacheError(operation, "corrupt-payload", "Cached bridge snapshot payload is corrupt.");
  }
  if (rows.length === 0 && hasMatchingEvidence) {
    throw cacheError(operation, "incompatible-version", "Cached bridge snapshot is incompatible.");
  }
  const results = rows.map((row): BridgeIdentityCompatibleScopeResult => {
    const scope = projectScope(
      {
        plexOrigin: row.plex_origin,
        plexInstanceId: row.plex_machine_id,
        plexLibraryId: row.plex_library_id,
        lidarrOrigin: row.lidarr_origin,
        entityKind: row.entity_kind,
      },
      operation,
    );
    if (
      scope.plexOrigin !== selector.plexOrigin ||
      scope.lidarrOrigin !== selector.lidarrOrigin ||
      scope.entityKind !== selector.entityKind ||
      (selector.plexLibraryId !== undefined && scope.plexLibraryId !== selector.plexLibraryId)
    ) {
      throw cacheError(
        operation,
        "corrupt-payload",
        "Cached bridge snapshot metadata is inconsistent.",
      );
    }
    const capturedAt = canonicalTimestamp(row.captured_at, operation);
    const verifiedAt = canonicalTimestamp(row.verified_at, operation);
    if (Date.parse(verifiedAt) > Date.parse(capturedAt)) {
      throw cacheError(
        operation,
        "corrupt-payload",
        "Cached bridge snapshot metadata is inconsistent.",
      );
    }
    return Object.freeze({
      scope,
      capturedAt,
      verifiedAt,
      ageSeconds: Math.max(0, Math.floor((nowMilliseconds - Date.parse(capturedAt)) / 1_000)),
    });
  });
  return Object.freeze(results);
}

/**
 * Reads one complete snapshot for an exact provider-instance scope.
 *
 * Corrupt and incompatible rows throw a bounded typed error; absence is the
 * only condition represented as `undefined`.
 */
export function readBridgeIdentitySnapshot(
  db: DbConnection,
  inputScope: BridgeIdentityScope,
  now: () => Date = () => new Date(),
): BridgeArtistIdentitySnapshot | undefined {
  const operation = "read";
  const scope = projectScope(inputScope, operation);
  let row: BridgeIdentitySnapshotRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind,
                snapshot_version, resolver_version, payload_json, captured_at, verified_at
         FROM bridge_identity_snapshots
         WHERE plex_origin = ? AND plex_machine_id = ? AND plex_library_id = ?
           AND lidarr_origin = ? AND entity_kind = ?`,
      )
      .get(
        scope.plexOrigin,
        scope.plexInstanceId,
        scope.plexLibraryId,
        scope.lidarrOrigin,
        scope.entityKind,
      ) as BridgeIdentitySnapshotRow | undefined;
  } catch (error) {
    return asDatabaseError(operation, error);
  }
  if (row === undefined) return undefined;

  if (
    row.snapshot_version !== BRIDGE_IDENTITY_SNAPSHOT_VERSION ||
    row.resolver_version !== BRIDGE_ARTIST_RESOLVER_VERSION
  ) {
    throw cacheError(operation, "incompatible-version", "Cached bridge snapshot is incompatible.");
  }
  if (
    typeof row.payload_json !== "string" ||
    Buffer.byteLength(row.payload_json, "utf8") > BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES
  ) {
    throw cacheError(
      operation,
      "payload-too-large",
      "Cached bridge snapshot payload is too large.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw cacheError(operation, "corrupt-payload", "Cached bridge snapshot payload is corrupt.");
  }

  let snapshot: BridgeArtistIdentitySnapshot;
  try {
    snapshot = projectSnapshot(parsed, operation);
  } catch (error) {
    if (error instanceof BridgeIdentityCacheError && error.code === "incompatible-version") {
      throw error;
    }
    throw cacheError(
      operation,
      "corrupt-payload",
      "Cached bridge snapshot payload is invalid.",
      error,
    );
  }

  const rowScope = projectScope(
    {
      plexOrigin: row.plex_origin,
      plexInstanceId: row.plex_machine_id,
      plexLibraryId: row.plex_library_id,
      lidarrOrigin: row.lidarr_origin,
      entityKind: row.entity_kind,
    },
    operation,
  );
  if (
    !sameScope(scope, rowScope) ||
    !sameScope(scope, snapshot.scope) ||
    row.captured_at !== snapshot.capturedAt ||
    row.verified_at !== snapshot.verifiedAt
  ) {
    throw cacheError(
      operation,
      "corrupt-payload",
      "Cached bridge snapshot metadata is inconsistent.",
    );
  }
  const nowMilliseconds = now().getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw cacheError(operation, "invalid-snapshot", "Bridge identity cache clock is invalid.");
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((nowMilliseconds - Date.parse(snapshot.capturedAt)) / 1_000),
  );
  return Object.freeze({
    ...snapshot,
    provenance: Object.freeze({
      source: "sqlite-cache",
      mode: "offline",
      freshness: CACHE_READ_FRESHNESS,
      ageSeconds,
    }),
  });
}

/** Validates and atomically replaces one complete same-scope snapshot. */
export function replaceBridgeIdentitySnapshot(
  db: DbConnection,
  input: BridgeArtistIdentitySnapshot,
): void {
  const operation = "replace";
  const snapshot = projectSnapshot(input, operation);
  const payloadJson = JSON.stringify(snapshot);
  if (Buffer.byteLength(payloadJson, "utf8") > BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES) {
    throw cacheError(
      operation,
      "payload-too-large",
      "Bridge identity snapshot payload is too large.",
    );
  }

  try {
    const replace = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO bridge_identity_snapshots (
           plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind,
           snapshot_version, resolver_version, payload_json, captured_at, verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind)
         DO UPDATE SET
           snapshot_version = excluded.snapshot_version,
           resolver_version = excluded.resolver_version,
           payload_json = excluded.payload_json,
           captured_at = excluded.captured_at,
           verified_at = excluded.verified_at
         WHERE excluded.captured_at >= bridge_identity_snapshots.captured_at`,
        )
        .run(
          snapshot.scope.plexOrigin,
          snapshot.scope.plexInstanceId,
          snapshot.scope.plexLibraryId,
          snapshot.scope.lidarrOrigin,
          snapshot.scope.entityKind,
          snapshot.snapshotVersion,
          snapshot.resolverVersion,
          payloadJson,
          snapshot.capturedAt,
          snapshot.verifiedAt,
        );
      if (result.changes === 0) {
        // A newer same-scope generation won the race; retain it deliberately.
        return;
      }
    });
    replace();
  } catch (error) {
    asDatabaseError(operation, error);
  }
}

/** Purges one exact provider-instance snapshot and returns the deleted row count. */
export function purgeBridgeIdentitySnapshot(
  db: DbConnection,
  inputScope: BridgeIdentityScope,
): number {
  const operation = "purge";
  const scope = projectScope(inputScope, operation);
  try {
    return db
      .prepare(
        `DELETE FROM bridge_identity_snapshots
         WHERE plex_origin = ? AND plex_machine_id = ? AND plex_library_id = ?
           AND lidarr_origin = ? AND entity_kind = ?`,
      )
      .run(
        scope.plexOrigin,
        scope.plexInstanceId,
        scope.plexLibraryId,
        scope.lidarrOrigin,
        scope.entityKind,
      ).changes;
  } catch (error) {
    return asDatabaseError(operation, error);
  }
}
