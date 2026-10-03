/**
 * Lidarr resilience decorator (issue #195).
 *
 * `createResilientLidarrClient` wraps the existing `LidarrClientApi` facade
 * from the OUTSIDE — transport, generated code, and the `LidarrError`
 * taxonomy are untouched, and no fetch call sites are introduced. The
 * decorator is surfaced transparently through `resolveRequiredLidarrClient`
 * (additive second parameter), so actions keep their barrel-mock tests.
 *
 * Behavior is keyed strictly off `LIDARR_TIER_DESCRIPTORS[tier]`:
 *
 * - Local-only tier (all shipped actions): zero pre-call overhead — no gate,
 *   no breaker read, no DB open before dispatch. The persisted circuit
 *   breaker is fed on the failure path only; windowed counting guarantees
 *   failures spread across healthy weeks can never trip it.
 * - Gated tiers (`requiresHealthGate: true`; #196's lanes): every call runs
 *   through `ensureTierHealthy` first — breaker gates, then a fresh health
 *   probe — and records breaker success after a completed call.
 *
 * In-place retry is an EXPLICIT read allowlist (all current idempotent GETs);
 * any method added later defaults to no in-place retry until classified —
 * mutations are defer-only by construction.
 *
 * Stale cache serving requires explicit per-invocation consent
 * (`--allow-stale`); this module is the SOLE emitter of the stale-serve
 * stderr warning (the command layer surfaces only the `cacheStatus` field).
 * Thrown errors gain no cache metadata — the taxonomy shape is frozen.
 */

import type { LidarrResilienceConfigOptions } from "../../types/config.js";
import type { DbConnection } from "../../types/db.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import { initializeDatabase } from "../db.js";
import { logWarn } from "../logger.js";
import { createCircuitBreaker, createSqliteCircuitStore } from "./circuit-breaker.js";
import type { CircuitPolicy, CircuitScope, LidarrCircuitBreaker } from "./circuit-breaker.js";
import type { LidarrAlbumQuery, LidarrClientApi, LidarrWantedQuery } from "./client.js";
import { LidarrError } from "./errors.js";
import type { LidarrErrorCode } from "./errors.js";
import { ensureTierHealthy } from "./health.js";
import { createSqliteCacheSource, writeLidarrCache } from "./metadata-cache.js";
import type { CacheHit, LidarrCacheCategory, MetadataFallbackSource } from "./metadata-cache.js";
import { LIDARR_TIER_DESCRIPTORS } from "./tiers.js";
import type { LidarrTier } from "./tiers.js";

/** Base delay for in-place read retries of non-timeout retryable failures. */
export const RETRY_BASE_DELAY_MS = 500;

/**
 * Timeout-specific retry base delay. A timed-out instance is slow, not down;
 * retrying it after half a second only compounds the load (errors.ts intent:
 * "so #195 can apply timeout-specific backoff").
 */
export const TIMEOUT_RETRY_BASE_DELAY_MS = 2_000;

/**
 * Explicit in-place retry allowlist for current idempotent GETs. Any method
 * added later is DENIED in-place retry by default until explicitly classified
 * here — mutations are defer-only by construction.
 */
export const LIDARR_IN_PLACE_RETRY_ALLOWLIST: ReadonlySet<string> = new Set([
  "getSystemStatus",
  "getHealth",
  "listArtists",
  "getArtistByForeignId",
  "listRootFolders",
  "listAlbums",
  "probeManualImport",
  "listTracks",
  "listTrackFiles",
  "getArtist",
  "listQualityProfiles",
  "listCustomFormats",
  "getCustomFormat",
  "getCustomFormatSchema",
  "listQualityProfileDefinitions",
  "getQualityProfileDefinition",
  "getQualityProfileSchema",
  "getNamingConfig",
  "getNamingExamples",
  "listMetadataProfileDetails",
  "listMetadataProfiles",
  "listTags",
  "getWantedMissing",
  "search",
  "lookupArtists",
  "lookupAlbums",
]);

/** Cache discriminator for whole-list snapshots (metadata-cache key rule). */
const WHOLE_LIST_DISCRIMINATOR = "";

/**
 * `lidarr.resilience` config knobs with the design §5 defaults applied via
 * `??` at the consumption site — defaults are never written into config.
 */
export type ResolvedResiliencePolicy = Readonly<Required<LidarrResilienceConfigOptions>>;

/**
 * Applies the design §5 defaults to the optional `lidarr.resilience` config
 * sub-object.
 *
 * @param config - Validated `lidarr.resilience` config knobs, when present.
 * @returns A frozen policy with every knob resolved.
 */
export function resolveResiliencePolicy(
  config?: LidarrResilienceConfigOptions,
): ResolvedResiliencePolicy {
  return Object.freeze({
    failureThreshold: config?.failureThreshold ?? 3,
    failureWindowSeconds: config?.failureWindowSeconds ?? 300,
    cooldownSeconds: config?.cooldownSeconds ?? 60,
    retryAttempts: config?.retryAttempts ?? 1,
    retryBackoffCapMs: config?.retryBackoffCapMs ?? 15_000,
    cacheTtlSeconds: config?.cacheTtlSeconds ?? 900,
    cacheStaleMaxAgeSeconds: config?.cacheStaleMaxAgeSeconds ?? 86_400,
    deferredMaxAttempts: config?.deferredMaxAttempts ?? 5,
  });
}

/** Per-invocation resilience options actions pass through the resolver. */
export interface LidarrResilienceCallOptions {
  /** Reliability tier; defaults to `"local-only"`. Keys ALL gating behavior. */
  readonly tier?: LidarrTier;
  /** Explicit per-invocation consent to serve stale cached data. Default false. */
  readonly allowStale?: boolean;
  /** Fired when a stale projection is served; actions copy into `cacheStatus`. */
  readonly onStaleServe?: (status: LidarrCacheStatus) => void;
  /** Override in-place retries when another layer owns retry policy. */
  readonly retryAttemptsOverride?: number;
}

/** Test seams only (transport-test style); production callers omit this. */
export interface ResilienceDependencies {
  /** Deterministic clock seam. */
  readonly now?: () => Date;
  /** Abortable wait seam used between retry attempts. */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source in `[0, 1)`. */
  readonly random?: () => number;
  /** Lazy tracking-database opener; defaults to `initializeDatabase()`. */
  readonly openDb?: () => Promise<DbConnection>;
  /** Ordered stale-fallback chain; defaults to `[sqliteCacheSource]`. */
  readonly fallbackSources?: readonly MetadataFallbackSource[];
}

/** Store-backed breaker handles for both scopes of one origin. */
export interface ScopedBreakers {
  readonly lidarr: LidarrCircuitBreaker;
  readonly metadata: LidarrCircuitBreaker;
}

/** Query-aware terminal stale lookup parameters. */
export interface LidarrTryServeStaleOptions<T> {
  readonly category: LidarrCacheCategory;
  readonly discriminator: string;
  readonly error: unknown;
  readonly validate: (value: unknown) => T | undefined;
}

/** Explicit hit/miss result returned by terminal stale lookup. */
export type LidarrStaleServeResult<T> =
  | { readonly served: true; readonly value: T }
  | { readonly served: false };

/** Shared resilience state used by scheduled Lidarr execution. */
export interface LidarrResilienceContext {
  readonly client: LidarrClientApi;
  readonly getBreakers: () => Promise<ScopedBreakers>;
  readonly writeLookupCache: (discriminator: string, value: unknown) => Promise<void>;
  readonly tryServeStale: <T>(
    options: LidarrTryServeStaleOptions<T>,
  ) => Promise<LidarrStaleServeResult<T>>;
}

/** Map an error code to the circuit scope it feeds, if any (design §8). */
function circuitScopeForCode(code: LidarrErrorCode): CircuitScope | undefined {
  switch (code) {
    case "lidarr-unreachable":
    case "timeout":
      return "lidarr";
    case "metadata-provider-unavailable":
      return "metadata";
    case "rate-limited":
    case "validation":
    case "authentication":
    case "authorization":
    case "not-found":
    case "invalid-response":
    case "configuration":
      return undefined;
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled Lidarr error code: ${String(exhaustive)}`);
    }
  }
}

/**
 * True when the code may be retried in place for allowlisted reads (§8).
 * `metadata-provider-unavailable` is deliberately excluded: provider outages
 * last minutes, not milliseconds — the tier gate handles them instead.
 */
function isInPlaceRetryableCode(code: LidarrErrorCode): boolean {
  switch (code) {
    case "lidarr-unreachable":
    case "timeout":
    case "rate-limited":
      return true;
    case "metadata-provider-unavailable":
    case "validation":
    case "authentication":
    case "authorization":
    case "not-found":
    case "invalid-response":
    case "configuration":
      return false;
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled Lidarr error code: ${String(exhaustive)}`);
    }
  }
}

/**
 * True when a failure with this code may fall back to a stale cache row
 * under `--allow-stale` (§8). `rate-limited` is excluded: the service is up,
 * so the failure surfaces with its wait time instead.
 */
function isStaleFallbackEligibleCode(code: LidarrErrorCode): boolean {
  switch (code) {
    case "lidarr-unreachable":
    case "timeout":
    case "metadata-provider-unavailable":
      return true;
    case "rate-limited":
    case "validation":
    case "authentication":
    case "authorization":
    case "not-found":
    case "invalid-response":
    case "configuration":
      return false;
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled Lidarr error code: ${String(exhaustive)}`);
    }
  }
}

/** Compact age rendering for the stale-serve warning ("45s", "12m", "3h", "2d"). */
function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }
  if (ageSeconds < 3_600) {
    return `${Math.floor(ageSeconds / 60)}m`;
  }
  if (ageSeconds < 86_400) {
    return `${Math.floor(ageSeconds / 3_600)}h`;
  }
  return `${Math.floor(ageSeconds / 86_400)}d`;
}

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The caller's abort reason, with an AbortError fallback. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Lidarr retry wait was cancelled", "AbortError");
}

/** Default abortable wait between retry attempts. */
function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Creates the shared resilience state for one `LidarrClientApi` facade.
 *
 * The returned context and decorated client are frozen. Their enumerable
 * surface contains only public functions and never the origin or credentials.
 *
 * Control flow per call (design §7):
 *
 * - Gated tiers run `ensureTierHealthy` first (breaker gates + fresh probe);
 *   a circuit-open rejection throws the scope-mapped taxonomy error with
 *   zero network I/O, unless `--allow-stale` can serve a cached projection.
 * - Retryable read failures on the allowlist retry in place with
 *   `min(base × 2^attempt + full jitter, retryBackoffCapMs)` backoff
 *   (timeout base 2 000 ms, otherwise 500 ms); `rate-limited` waits exactly
 *   `retryAfterSeconds` and fails through immediately when that exceeds the
 *   cap; `metadata-provider-unavailable` is never retried in place.
 * - On exhaustion the failure feeds the persisted breaker for its scope
 *   (lazy DB open — failure-path-only cost; a persist failure warns and the
 *   original error is rethrown unchanged), then the stale-fallback chain is
 *   consulted under `--allow-stale` before the error surfaces.
 * - Successful `listArtists`/`getSystemStatus` results are written through
 *   to the metadata cache when `cacheTtlSeconds > 0`; a write failure warns
 *   and never affects the operation result.
 *
 * @param inner - The undecorated facade (also used for health probes).
 * @param origin - Credential-free canonical Lidarr origin — never the API key.
 * @param policy - Resolved resilience knobs ({@link resolveResiliencePolicy}).
 * @param call - Per-invocation tier/stale options from the action layer.
 * @param deps - Optional test seams (clock, delay, jitter, DB, sources).
 * @returns A frozen context containing the decorated client and shared lazy helpers.
 */
export function createLidarrResilienceContext(
  inner: LidarrClientApi,
  origin: string,
  policy: ResolvedResiliencePolicy,
  call: LidarrResilienceCallOptions,
  deps: ResilienceDependencies = {},
): LidarrResilienceContext {
  const tier: LidarrTier = call.tier ?? "local-only";
  const descriptor = LIDARR_TIER_DESCRIPTORS[tier];
  const now = deps.now ?? ((): Date => new Date());
  const delay = deps.delay ?? defaultDelay;
  const random = deps.random ?? Math.random;
  const openDb = deps.openDb ?? ((): Promise<DbConnection> => initializeDatabase());

  const circuitPolicy: CircuitPolicy = {
    failureThreshold: policy.failureThreshold,
    failureWindowMs: policy.failureWindowSeconds * 1000,
    cooldownMs: policy.cooldownSeconds * 1000,
  };

  let dbPromise: Promise<DbConnection> | undefined;
  const openDbOnce = async (): Promise<DbConnection> => {
    try {
      dbPromise ??= openDb();
      return await dbPromise;
    } catch (error) {
      dbPromise = undefined;
      throw error;
    }
  };

  let breakersPromise: Promise<ScopedBreakers> | undefined;
  const getBreakers = async (): Promise<ScopedBreakers> => {
    try {
      breakersPromise ??= openDbOnce().then((db) => {
        const store = createSqliteCircuitStore(db);
        return Object.freeze({
          lidarr: createCircuitBreaker({
            store,
            origin,
            scope: "lidarr",
            policy: circuitPolicy,
            now,
          }),
          metadata: createCircuitBreaker({
            store,
            origin,
            scope: "metadata",
            policy: circuitPolicy,
            now,
          }),
        });
      });
      return await breakersPromise;
    } catch (error) {
      breakersPromise = undefined;
      throw error;
    }
  };

  const fallbackSources: readonly MetadataFallbackSource[] = deps.fallbackSources ?? [
    createSqliteCacheSource(openDbOnce, {
      ttlMs: policy.cacheTtlSeconds * 1000,
      staleMaxAgeMs: policy.cacheStaleMaxAgeSeconds * 1000,
    }),
  ];

  /** True when this failure may be retried in place right now. */
  const shouldAttemptRetry = (
    method: string,
    error: unknown,
    attempt: number,
  ): error is LidarrError =>
    attempt < (call.retryAttemptsOverride ?? policy.retryAttempts) &&
    LIDARR_IN_PLACE_RETRY_ALLOWLIST.has(method) &&
    error instanceof LidarrError &&
    error.retryable &&
    isInPlaceRetryableCode(error.code);

  /**
   * Wait before retry `attempt` (0-based), or `undefined` to fail through
   * (a Retry-After hint that exceeds the backoff cap).
   */
  const retryDelayMs = (error: LidarrError, attempt: number): number | undefined => {
    if (error.code === "rate-limited" && error.retryAfterSeconds !== undefined) {
      const waitMs = error.retryAfterSeconds * 1000;
      return waitMs > policy.retryBackoffCapMs ? undefined : waitMs;
    }
    const base = error.code === "timeout" ? TIMEOUT_RETRY_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
    const exponential = base * 2 ** attempt;
    return Math.min(exponential + random() * exponential, policy.retryBackoffCapMs);
  };

  /** Failure-path breaker feed; a persist failure warns and never masks. */
  const feedBreakerOnFailure = async (error: unknown): Promise<void> => {
    if (!(error instanceof LidarrError)) {
      return;
    }
    const scope = circuitScopeForCode(error.code);
    if (scope === undefined) {
      return;
    }
    try {
      const scoped = await getBreakers();
      scoped[scope].recordFailure(error);
    } catch (persistError) {
      logWarn(`Failed to persist Lidarr circuit state: ${errorMessage(persistError)}`);
    }
  };

  /** Gated-tier success closes the gated scopes (persisted only on change). */
  const recordGatedSuccess = async (): Promise<void> => {
    if (!descriptor.requiresHealthGate) {
      return;
    }
    try {
      const scoped = await getBreakers();
      scoped.lidarr.recordSuccess();
      if (descriptor.metadataServerRequired) {
        scoped.metadata.recordSuccess();
      }
    } catch (persistError) {
      logWarn(`Failed to persist Lidarr circuit state: ${errorMessage(persistError)}`);
    }
  };

  /** Non-throwing UPSERT for cacheable projections. */
  const writeCache = async (
    category: LidarrCacheCategory | undefined,
    discriminator: string,
    value: unknown,
  ): Promise<void> => {
    if (category === undefined || policy.cacheTtlSeconds <= 0) {
      return;
    }
    try {
      const db = await openDbOnce();
      writeLidarrCache(
        db,
        origin,
        category,
        discriminator,
        value,
        policy.cacheStaleMaxAgeSeconds * 1000,
        now,
      );
    } catch (writeError) {
      logWarn(`Failed to write Lidarr metadata cache (${category}): ${errorMessage(writeError)}`);
    }
  };

  const writeLookupCache = (discriminator: string, value: unknown): Promise<void> =>
    writeCache("lookup", discriminator, value);

  /**
   * Consults the ordered fallback chain for a stale projection. Only runs
   * under explicit `--allow-stale`, for cacheable operations, with the cache
   * enabled, on stale-eligible failures. On a hit this fires `onStaleServe`
   * and emits the SOLE stale-serve stderr warning (design §7(c)).
   */
  const tryServeStale = async <T>({
    category,
    discriminator,
    error,
    validate,
  }: LidarrTryServeStaleOptions<T>): Promise<LidarrStaleServeResult<T>> => {
    if (
      call.allowStale !== true ||
      policy.cacheTtlSeconds <= 0 ||
      !(error instanceof LidarrError) ||
      !isStaleFallbackEligibleCode(error.code)
    ) {
      return { served: false };
    }
    for (const source of fallbackSources) {
      let hit: CacheHit<unknown> | undefined;
      try {
        hit = await source.lookup<unknown>(origin, category, discriminator);
      } catch (lookupError) {
        logWarn(`Lidarr stale-cache source '${source.id}' failed: ${errorMessage(lookupError)}`);
        continue;
      }
      if (hit === undefined) {
        continue;
      }
      let value: T | undefined;
      try {
        value = validate(hit.value);
      } catch {
        continue;
      }
      if (value === undefined) {
        continue;
      }
      const status: LidarrCacheStatus = {
        source: "stale-cache",
        fetchedAt: hit.fetchedAt,
        ageSeconds: hit.ageSeconds,
      };
      call.onStaleServe?.(status);
      logWarn(
        `Lidarr unreachable — serving cached data from ${formatAge(hit.ageSeconds)} ago (--allow-stale).`,
      );
      return { served: true, value };
    }
    return { served: false };
  };

  const tryServeWholeListStale = <T>(
    category: LidarrCacheCategory | undefined,
    error: unknown,
  ): Promise<LidarrStaleServeResult<T>> => {
    if (category === undefined) {
      return Promise.resolve({ served: false });
    }
    return tryServeStale({
      category,
      discriminator: WHOLE_LIST_DISCRIMINATOR,
      error,
      validate: (value): T | undefined => value as T,
    });
  };

  /** Core pipeline shared by every decorated method. */
  const execute = async <T>(
    method: string,
    category: LidarrCacheCategory | undefined,
    signal: AbortSignal | undefined,
    invoke: () => Promise<T>,
  ): Promise<T> => {
    if (descriptor.requiresHealthGate) {
      try {
        await ensureTierHealthy(inner, tier, await getBreakers(), signal);
      } catch (gateError) {
        // Breaker feeding for the gate phase is OWNED by ensureTierHealthy:
        // it records probe/health outcomes on the gated scope(s) and never
        // records circuit-open rejections (which happen before any network
        // call). Feeding here would double-count probe failures.
        const stale = await tryServeWholeListStale<T>(category, gateError);
        if (stale.served) {
          return stale.value;
        }
        throw gateError;
      }
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await invoke();
        await recordGatedSuccess();
        await writeCache(category, WHOLE_LIST_DISCRIMINATOR, result);
        return result;
      } catch (error) {
        if (shouldAttemptRetry(method, error, attempt)) {
          const waitMs = retryDelayMs(error, attempt);
          if (waitMs !== undefined) {
            await delay(waitMs, signal);
            continue;
          }
        }
        await feedBreakerOnFailure(error);
        const stale = await tryServeWholeListStale<T>(category, error);
        if (stale.served) {
          return stale.value;
        }
        throw error;
      }
    }
  };

  /**
   * Scheduled lookups delegate health gating, retry timing, and stale serving
   * to the scheduler while retaining this context's shared breaker feed.
   */
  const executeScheduledLookup = async <T>(invoke: () => Promise<T>): Promise<T> => {
    try {
      const result = await invoke();
      await recordGatedSuccess();
      return result;
    } catch (error) {
      await feedBreakerOnFailure(error);
      throw error;
    }
  };

  const setArtistProfiles: LidarrClientApi["setArtistProfiles"] = (artistId, assignment, signal) =>
    execute("setArtistProfiles", undefined, signal, () =>
      inner.setArtistProfiles(artistId, assignment, signal),
    );
  const updateArtistTags: LidarrClientApi["updateArtistTags"] = (artistId, mutation, signal) =>
    execute("updateArtistTags", undefined, signal, () =>
      inner.updateArtistTags(artistId, mutation, signal),
    );
  const wrapped: LidarrClientApi = {
    getSystemStatus: (signal?: AbortSignal) =>
      execute("getSystemStatus", "system-status", signal, () => inner.getSystemStatus(signal)),
    getHealth: (signal?: AbortSignal) =>
      execute("getHealth", undefined, signal, () => inner.getHealth(signal)),
    listArtists: (signal?: AbortSignal) =>
      execute("listArtists", "artists", signal, () => inner.listArtists(signal)),
    listAlbums: (query: LidarrAlbumQuery) =>
      execute("listAlbums", undefined, query.signal, () => inner.listAlbums(query)),
    probeManualImport: (input) =>
      execute("probeManualImport", undefined, input.signal, () => inner.probeManualImport(input)),
    listTracks: (query) =>
      execute("listTracks", undefined, query.signal, () => inner.listTracks(query)),
    listTrackFiles: (query) =>
      execute("listTrackFiles", undefined, query.signal, () => inner.listTrackFiles(query)),
    bulkDeleteTrackFiles: (trackFileIds, signal) =>
      execute("bulkDeleteTrackFiles", undefined, signal, () =>
        inner.bulkDeleteTrackFiles(trackFileIds, signal),
      ),
    getArtist: (artistId, signal) =>
      execute("getArtist", undefined, signal, () => inner.getArtist(artistId, signal)),
    deleteArtist: (artistId, deleteFiles, signal) =>
      execute("deleteArtist", undefined, signal, () =>
        inner.deleteArtist(artistId, deleteFiles, signal),
      ),
    listQualityProfiles: (signal?: AbortSignal) =>
      execute("listQualityProfiles", undefined, signal, () => inner.listQualityProfiles(signal)),
    listCustomFormats: (signal?: AbortSignal) =>
      execute("listCustomFormats", undefined, signal, () => inner.listCustomFormats(signal)),
    getCustomFormat: (customFormatId, signal) =>
      execute("getCustomFormat", undefined, signal, () =>
        inner.getCustomFormat(customFormatId, signal),
      ),
    getCustomFormatSchema: (signal?: AbortSignal) =>
      execute("getCustomFormatSchema", undefined, signal, () =>
        inner.getCustomFormatSchema(signal),
      ),
    createCustomFormat: (input, signal) =>
      execute("createCustomFormat", undefined, signal, () =>
        inner.createCustomFormat(input, signal),
      ),
    updateCustomFormat: (input, signal) =>
      execute("updateCustomFormat", undefined, signal, () =>
        inner.updateCustomFormat(input, signal),
      ),
    listQualityProfileDefinitions: (signal?: AbortSignal) =>
      execute("listQualityProfileDefinitions", undefined, signal, () =>
        inner.listQualityProfileDefinitions(signal),
      ),
    getQualityProfileDefinition: (qualityProfileId, signal) =>
      execute("getQualityProfileDefinition", undefined, signal, () =>
        inner.getQualityProfileDefinition(qualityProfileId, signal),
      ),
    getQualityProfileSchema: (signal?: AbortSignal) =>
      execute("getQualityProfileSchema", undefined, signal, () =>
        inner.getQualityProfileSchema(signal),
      ),
    createQualityProfile: (input, signal) =>
      execute("createQualityProfile", undefined, signal, () =>
        inner.createQualityProfile(input, signal),
      ),
    updateQualityProfile: (input, signal) =>
      execute("updateQualityProfile", undefined, signal, () =>
        inner.updateQualityProfile(input, signal),
      ),
    getNamingConfig: (signal?: AbortSignal) =>
      execute("getNamingConfig", undefined, signal, () => inner.getNamingConfig(signal)),
    getNamingExamples: (input, signal) =>
      execute("getNamingExamples", undefined, signal, () => inner.getNamingExamples(input, signal)),
    updateNamingConfig: (input, signal) =>
      execute("updateNamingConfig", undefined, signal, () =>
        inner.updateNamingConfig(input, signal),
      ),
    listMetadataProfiles: (signal?: AbortSignal) =>
      execute("listMetadataProfiles", undefined, signal, () => inner.listMetadataProfiles(signal)),
    listMetadataProfileDetails: (signal?: AbortSignal) =>
      execute("listMetadataProfileDetails", undefined, signal, () =>
        inner.listMetadataProfileDetails(signal),
      ),
    listTags: (signal?: AbortSignal) =>
      execute("listTags", undefined, signal, () => inner.listTags(signal)),
    getWantedMissing: (query?: LidarrWantedQuery) =>
      execute("getWantedMissing", undefined, query?.signal, () => inner.getWantedMissing(query)),
    search: (query) => executeScheduledLookup(() => inner.search(query)),
    lookupArtists: (query) => executeScheduledLookup(() => inner.lookupArtists(query)),
    lookupAlbums: (query) => executeScheduledLookup(() => inner.lookupAlbums(query)),
    getArtistByForeignId: (foreignArtistId, signal) =>
      execute("getArtistByForeignId", undefined, signal, () =>
        inner.getArtistByForeignId(foreignArtistId, signal),
      ),
    listRootFolders: (signal?: AbortSignal) =>
      execute("listRootFolders", undefined, signal, () => inner.listRootFolders(signal)),
    prepareArtistAdd: (input, signal) =>
      executeScheduledLookup(() => inner.prepareArtistAdd(input, signal)),
    // The scheduler completed the single health gate and authoritative lookup
    // before durable possible-dispatch evidence. Dispatch must not add another
    // gate or retry between that record and the POST.
    addArtist: async (input, signal) => {
      try {
        return await inner.addArtist(input, signal);
      } catch (error) {
        await feedBreakerOnFailure(error);
        throw error;
      }
    },
    setArtistsMonitored: (artistIds, monitored, signal) =>
      execute("setArtistsMonitored", undefined, signal, () =>
        inner.setArtistsMonitored(artistIds, monitored, signal),
      ),
    setAlbumsMonitored: (albumIds, monitored, signal) =>
      execute("setAlbumsMonitored", undefined, signal, () =>
        inner.setAlbumsMonitored(albumIds, monitored, signal),
      ),
    // Album mutation primitives are defer-only by construction: neither is in
    // LIDARR_IN_PLACE_RETRY_ALLOWLIST, so a destructive call is never hot-retried.
    deleteAlbum: (albumId, options, signal) =>
      execute("deleteAlbum", undefined, signal, () => inner.deleteAlbum(albumId, options, signal)),
    setAlbumAnyReleaseOk: (albumId, anyReleaseOk, signal) =>
      execute("setAlbumAnyReleaseOk", undefined, signal, () =>
        inner.setAlbumAnyReleaseOk(albumId, anyReleaseOk, signal),
      ),
    setArtistProfiles,
    updateArtistTags,
  };
  return Object.freeze({
    client: Object.freeze(wrapped),
    getBreakers,
    writeLookupCache,
    tryServeStale,
  });
}

/**
 * Compatibility wrapper returning only the decorated client facade.
 *
 * New scheduled execution should use {@link createLidarrResilienceContext}
 * so preflight, breaker state, cache writes, and terminal fallback share one
 * lazily initialized context.
 */
export function createResilientLidarrClient(
  inner: LidarrClientApi,
  origin: string,
  policy: ResolvedResiliencePolicy,
  call: LidarrResilienceCallOptions,
  deps: ResilienceDependencies = {},
): LidarrClientApi {
  return createLidarrResilienceContext(inner, origin, policy, call, deps).client;
}
