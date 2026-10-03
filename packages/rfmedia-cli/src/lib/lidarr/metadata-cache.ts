/**
 * Persistent metadata cache for Lidarr projections (schema v10, issue #195).
 *
 * Sole owner of `lidarr_metadata_cache` CRUD. Rows are keyed by
 * origin x category x discriminator ('' for whole-list snapshots) and never
 * contain the API key (plex-cache key-scoping precedent). TTL and staleness
 * are computed at read time from caller-supplied policy values, so config
 * changes apply to existing rows without rewrites. Stale rows are served
 * only under explicit `--allow-stale` consent, enforced by the decorator
 * that consumes this module.
 */

import type { DbConnection, DbLidarrMetadataCacheEntry } from "../../types/db.js";

/**
 * Cache categories shipped in v1. Wanted pages are deliberately excluded
 * (page-parameter explosion, low fallback value).
 */
export type LidarrCacheCategory = "artists" | "lookup" | "system-status";

/**
 * A cache row projected for consumers, with staleness computed at read time.
 */
export interface CacheHit<T> {
  /** The cached payload, parsed from the stored JSON snapshot. */
  readonly value: T;
  /** ISO timestamp of the successful fetch that produced this row. */
  readonly fetchedAt: string;
  /** Whole seconds elapsed since `fetchedAt`, clamped to zero. */
  readonly ageSeconds: number;
  /** True when age <= ttl; false hits are servable only under --allow-stale. */
  readonly fresh: boolean;
}

function resolveNow(now?: () => Date): Date {
  return now ? now() : new Date();
}

function describeCacheKey(
  origin: string,
  category: LidarrCacheCategory,
  discriminator: string,
): string {
  return `${origin} ${category} '${discriminator}'`;
}

/**
 * Reads one cache entry, computing freshness and staleness at read time.
 *
 * Freshness (`fresh = age <= ttlMs`) and the stale ceiling are evaluated
 * against the caller-supplied policy on every read, so config changes take
 * effect immediately for existing rows.
 *
 * @param db - Database connection
 * @param origin - Credential-free canonical Lidarr origin (never the API key)
 * @param category - Cache category the entry belongs to
 * @param discriminator - Sub-key within the category ('' for whole-list snapshots)
 * @param ttlMs - Fresh window in milliseconds (age <= ttlMs means fresh)
 * @param staleMaxAgeMs - Stale-serve ceiling; entries older than this are misses
 * @param now - Optional deterministic clock seam for tests
 * @returns The cache hit, or `undefined` for a miss or an entry past `staleMaxAgeMs`
 * @throws Error when a stored row is malformed (unparseable timestamp or payload)
 */
export function readLidarrCache<T>(
  db: DbConnection,
  origin: string,
  category: LidarrCacheCategory,
  discriminator: string,
  ttlMs: number,
  staleMaxAgeMs: number,
  now?: () => Date,
): CacheHit<T> | undefined {
  const stmt = db.prepare(`
    SELECT * FROM lidarr_metadata_cache
    WHERE origin = ? AND category = ? AND discriminator = ?
  `);
  const row = stmt.get(origin, category, discriminator) as DbLidarrMetadataCacheEntry | undefined;
  if (row === undefined) {
    return undefined;
  }

  const fetchedAtMs = Date.parse(row.fetched_at);
  if (Number.isNaN(fetchedAtMs)) {
    throw new Error(
      `Malformed fetched_at in lidarr_metadata_cache row for ${describeCacheKey(origin, category, discriminator)}`,
    );
  }

  const ageMs = Math.max(0, resolveNow(now).getTime() - fetchedAtMs);
  if (ageMs > staleMaxAgeMs) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Malformed payload_json in lidarr_metadata_cache row for ${describeCacheKey(origin, category, discriminator)}: ${reason}`,
    );
  }

  return {
    value: parsed as T,
    fetchedAt: row.fetched_at,
    ageSeconds: Math.floor(ageMs / 1000),
    fresh: ageMs <= ttlMs,
  };
}

/**
 * Writes (upserts) one cache entry via `ON CONFLICT DO UPDATE`.
 *
 * When `staleMaxAgeMs` is provided, rows older than the stale ceiling are
 * pruned opportunistically in the same call (the decorator passes its
 * resolved `cacheStaleMaxAgeSeconds` policy value here). Rows exactly at the
 * ceiling are kept, matching the read-side serve boundary.
 *
 * @param db - Database connection
 * @param origin - Credential-free canonical Lidarr origin (never the API key)
 * @param category - Cache category for the entry
 * @param discriminator - Sub-key within the category ('' for whole-list snapshots)
 * @param value - JSON-serializable payload snapshot to store
 * @param staleMaxAgeMs - Optional stale ceiling for the opportunistic prune
 * @param now - Optional deterministic clock seam for tests
 * @throws TypeError when `value` is not JSON-serializable (serializes to undefined)
 */
export function writeLidarrCache(
  db: DbConnection,
  origin: string,
  category: LidarrCacheCategory,
  discriminator: string,
  value: unknown,
  staleMaxAgeMs?: number,
  now?: () => Date,
): void {
  const payloadJson: string | undefined = JSON.stringify(value);
  if (payloadJson === undefined) {
    throw new TypeError(
      `Lidarr cache values must be JSON-serializable for ${describeCacheKey(origin, category, discriminator)}`,
    );
  }

  const nowDate = resolveNow(now);
  db.prepare(
    `
    INSERT INTO lidarr_metadata_cache (origin, category, discriminator, payload_json, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(origin, category, discriminator) DO UPDATE SET
      payload_json = excluded.payload_json,
      fetched_at = excluded.fetched_at
  `,
  ).run(origin, category, discriminator, payloadJson, nowDate.toISOString());

  if (staleMaxAgeMs !== undefined && Number.isFinite(staleMaxAgeMs) && staleMaxAgeMs > 0) {
    const cutoffIso = new Date(nowDate.getTime() - staleMaxAgeMs).toISOString();
    db.prepare("DELETE FROM lidarr_metadata_cache WHERE fetched_at < ?").run(cutoffIso);
  }
}

/**
 * Deletes cache entries for one origin, optionally scoped to a category.
 *
 * @param db - Database connection
 * @param origin - Credential-free canonical Lidarr origin whose entries are purged
 * @param category - Optional category filter; omitted purges every category
 * @returns Number of rows deleted
 */
export function purgeLidarrCache(
  db: DbConnection,
  origin: string,
  category?: LidarrCacheCategory,
): number {
  const result =
    category === undefined
      ? db.prepare("DELETE FROM lidarr_metadata_cache WHERE origin = ?").run(origin)
      : db
          .prepare("DELETE FROM lidarr_metadata_cache WHERE origin = ? AND category = ?")
          .run(origin, category);
  return result.changes;
}

/**
 * DOCUMENTED SEAM for Tier-2 MusicBrainz fallback (follow-up issue — requires
 * its own FETCH_OWNERS registration, 1 req/s limiter, and error mapping; hard
 * out of #195).
 *
 * CONSUMPTION CONTRACT: the decorator holds an ordered readonly
 * `MetadataFallbackSource[]` (default `[sqliteCacheSource]`); on a
 * stale-eligible failure with `--allow-stale` it consults sources
 * left-to-right and the first hit within the stale ceiling wins. The
 * MusicBrainz follow-up appends a source to this array — zero rework to the
 * decorator.
 */
export interface MetadataFallbackSource {
  /** Stable source identifier ("sqlite-cache" in #195). */
  readonly id: string;
  /**
   * Looks up a cached projection for one cache key.
   *
   * @param origin - Credential-free canonical Lidarr origin
   * @param category - Cache category to consult
   * @param discriminator - Sub-key within the category ('' for whole-list snapshots)
   * @returns The hit within the source's stale ceiling, or `undefined` for a miss
   */
  lookup<T>(
    origin: string,
    category: LidarrCacheCategory,
    discriminator: string,
  ): Promise<CacheHit<T> | undefined>;
}

/**
 * Creates the SQLite-backed fallback source over `lidarr_metadata_cache`.
 *
 * The database is opened lazily through `openDb` on first lookup; the
 * provider owns the connection lifecycle (this source never closes it).
 *
 * @param openDb - Lazy database provider (shared connection owned by the caller)
 * @param policy - Resolved fresh window and stale ceiling in milliseconds
 * @returns A frozen fallback source with id "sqlite-cache"
 */
export function createSqliteCacheSource(
  openDb: () => Promise<DbConnection>,
  policy: { readonly ttlMs: number; readonly staleMaxAgeMs: number },
): MetadataFallbackSource {
  return Object.freeze({
    id: "sqlite-cache",
    async lookup<T>(
      origin: string,
      category: LidarrCacheCategory,
      discriminator: string,
    ): Promise<CacheHit<T> | undefined> {
      const db = await openDb();
      return readLidarrCache<T>(
        db,
        origin,
        category,
        discriminator,
        policy.ttlMs,
        policy.staleMaxAgeMs,
      );
    },
  });
}
