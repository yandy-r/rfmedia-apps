import type { PlexCacheCategory, PlexCacheSettings } from "./types.js";

/** Default time-to-live when caching is enabled without an explicit TTL. */
export const DEFAULT_PLEX_CACHE_TTL_SECONDS = 300;

const MAX_DISCRIMINATOR_PARTS = 16;
const MAX_DISCRIMINATOR_LENGTH = 256;
const FORBIDDEN_KEY_CONTENT =
  /(?:[a-z][a-z\d+.-]*:\/\/|x-plex-token|authorization|(?:^|[?&;\s])(?:access[_-]?token|token)\s*[:=])/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const CACHE_CATEGORIES = new Set<PlexCacheCategory>([
  "identity",
  "libraries",
  "queries",
  "playlists",
  "collections",
]);

/** Primitive values accepted as non-secret cache key discriminators. */
export type PlexCacheKeyPart = string | number | boolean;

/** A category-scoped key for one adapter-local cache entry. */
export interface PlexCacheKey {
  readonly category: PlexCacheCategory;
  readonly discriminator?: readonly PlexCacheKeyPart[];
}

/** Test seam for deterministic expiration. */
export interface PlexCacheDependencies {
  readonly now?: () => number;
}

/** Adapter-local cache operations used by private Plex capability modules. */
export interface PlexResponseCache {
  readonly enabled: boolean;

  /** Returns a live cached value or `undefined` for a miss or expired entry. */
  get<T>(key: PlexCacheKey): T | undefined;

  /** Stores a value using the TTL captured when this cache was constructed. */
  set<T>(key: PlexCacheKey, value: T): void;

  /** Deletes one exact category/discriminator entry. */
  delete(key: PlexCacheKey): boolean;

  /** Invalidates every entry in a bounded cache category. */
  invalidate(category: PlexCacheCategory): number;

  /** Clears all entries owned by this adapter lifecycle. */
  clear(): void;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

function assertCategory(category: PlexCacheCategory): void {
  if (!CACHE_CATEGORIES.has(category)) {
    throw new TypeError("Unknown Plex cache category");
  }
}

function serializePart(part: PlexCacheKeyPart): string {
  if (typeof part === "number") {
    if (!Number.isFinite(part)) {
      throw new TypeError("Plex cache key numbers must be finite");
    }
    return `n:${part}`;
  }

  if (typeof part === "boolean") {
    return part ? "b:1" : "b:0";
  }

  if (part.length > MAX_DISCRIMINATOR_LENGTH) {
    throw new TypeError(
      `Plex cache key discriminator exceeds ${MAX_DISCRIMINATOR_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTERS.test(part) || FORBIDDEN_KEY_CONTENT.test(part)) {
    throw new TypeError("Plex cache key cannot contain URLs or credential material");
  }
  return `s:${encodeURIComponent(part)}`;
}

function serializeKey(key: PlexCacheKey): string {
  assertCategory(key.category);
  const discriminator = key.discriminator ?? [];
  if (discriminator.length > MAX_DISCRIMINATOR_PARTS) {
    throw new TypeError(
      `Plex cache key cannot exceed ${MAX_DISCRIMINATOR_PARTS} discriminator parts`,
    );
  }
  return [key.category, ...discriminator.map(serializePart)].join("::");
}

function resolveTtlSeconds(settings: Partial<PlexCacheSettings>): number {
  const ttlSeconds = settings.ttlSeconds ?? DEFAULT_PLEX_CACHE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError("Plex cache TTL must be a positive integer");
  }
  return ttlSeconds;
}

/**
 * Creates one in-memory TTL cache for one Plex adapter/credential lifecycle.
 *
 * Settings are copied at construction, so later configuration changes cannot
 * alter existing cache semantics. Keys deliberately omit origin and credential
 * state because adapter instances already provide that isolation boundary.
 *
 * @param settings - Captured enablement and optional TTL configuration.
 * @param dependencies - Optional deterministic clock for tests.
 * @returns An isolated cache instance with no config or network dependencies.
 * @throws TypeError when the TTL or a cache key violates its bounded contract.
 */
export function createPlexResponseCache(
  settings: Partial<PlexCacheSettings>,
  dependencies: PlexCacheDependencies = {},
): PlexResponseCache {
  const enabled = settings.enabled === true;
  const ttlSeconds = resolveTtlSeconds(settings);
  const ttlMilliseconds = ttlSeconds * 1_000;
  const now = dependencies.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();

  return Object.freeze({
    enabled,
    get<T>(key: PlexCacheKey): T | undefined {
      if (!enabled) {
        return undefined;
      }

      const serializedKey = serializeKey(key);
      const entry = entries.get(serializedKey);
      if (entry === undefined) {
        return undefined;
      }
      if (now() > entry.expiresAt) {
        entries.delete(serializedKey);
        return undefined;
      }
      return entry.value as T;
    },
    set<T>(key: PlexCacheKey, value: T): void {
      if (!enabled) {
        return;
      }

      const serializedKey = serializeKey(key);
      entries.set(serializedKey, {
        value,
        expiresAt: now() + ttlMilliseconds,
      });
    },
    delete(key: PlexCacheKey): boolean {
      if (!enabled) {
        return false;
      }
      return entries.delete(serializeKey(key));
    },
    invalidate(category: PlexCacheCategory): number {
      if (!enabled) {
        return 0;
      }

      assertCategory(category);
      const prefix = `${category}::`;
      let invalidated = 0;
      for (const key of entries.keys()) {
        if (key === category || key.startsWith(prefix)) {
          entries.delete(key);
          invalidated += 1;
        }
      }
      return invalidated;
    },
    clear(): void {
      entries.clear();
    },
  });
}
