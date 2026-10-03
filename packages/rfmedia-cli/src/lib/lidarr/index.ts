/**
 * Lidarr client barrel: connection resolution + public surface re-exports.
 *
 * `createLidarrClient` and `resolveRequiredLidarrClient` read the loaded config,
 * apply CLI overrides, normalize the base URL to a canonical origin, and
 * construct an origin-bound {@link LidarrClient}. The optional factory returns
 * `undefined` when the connection cannot be resolved; the required resolver
 * throws a typed configuration error the actions surface to the user.
 *
 * Since issue #195 the required resolver returns the facade wrapped in the
 * resilience decorator ({@link createResilientLidarrClient}) — transparently,
 * with an additive second parameter — so every action inherits retry,
 * circuit-breaker, and stale-cache behavior with zero call-site churn.
 */

import { normalizeHttpUrl } from "../http-url.js";
import { getLoadedLidarrConfig } from "../loaded-config.js";
import { logDebug } from "../logger.js";
import type { LidarrConfigOptions } from "../../types/config.js";
import { LidarrClient, type LidarrClientApi } from "./client.js";
import { LidarrValidationError } from "./errors.js";
import { createLidarrResilienceContext, resolveResiliencePolicy } from "./resilience.js";
import type { LidarrResilienceCallOptions, LidarrResilienceContext } from "./resilience.js";
import {
  createLidarrScheduler,
  createLidarrSchedulerPreflight,
  resolveLidarrSchedulerPolicy,
} from "./scheduler.js";
import type { LidarrScheduler, LidarrSchedulerPreflight } from "./scheduler.js";
import { createLidarrConnectionSettings, StaticLidarrApiKeyProvider } from "./types.js";
import type { LidarrConnectionSettings, LidarrRequestSettings } from "./types.js";

export * from "./circuit-breaker.js";
export * from "./client.js";
export * from "./deferred-queue.js";
export * from "./deferred-queue-db.js";
export * from "./errors.js";
export * from "./health.js";
export * from "./metadata-cache.js";
export * from "./plan-engine.js";
export * from "./resilience.js";
export * from "./scheduler.js";
export * from "./tiers.js";
export type { LidarrCacheStatus, LidarrResilienceSnapshot } from "../../types/lidarr-resilience.js";

/** CLI override fields used to resolve Lidarr connection settings. */
export interface LidarrClientOverrides {
  /** `--lidarr-url` override for the configured base URL. */
  readonly lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  readonly lidarrApiKey?: string;
}

/** Shared execution dependencies for one scheduled Lidarr operation. */
export interface LidarrExecutionContext {
  /** Resilience-decorated facade used for live operation attempts. */
  readonly client: LidarrClientApi;
  /** Lazy raw-client health/circuit preflight for gated scheduler lanes. */
  readonly preflight: LidarrSchedulerPreflight;
  /** Non-throwing full-projection lookup cache writer. */
  readonly writeLookupCache: LidarrResilienceContext["writeLookupCache"];
  /** Exact-query terminal stale fallback helper. */
  readonly tryServeStale: LidarrResilienceContext["tryServeStale"];
}

type LidarrConnectionResolution =
  | { readonly ok: true; readonly connection: LidarrConnectionSettings }
  | { readonly ok: false; readonly reason: "missing" | "invalid-url" };

const MISSING_CONNECTION_MESSAGE =
  "Lidarr base URL and API key are required. Set in config or use --lidarr-url and --lidarr-api-key";
const MISSING_ORIGIN_MESSAGE = "Lidarr base URL is required. Set in config or use --lidarr-url";
const INVALID_URL_MESSAGE = "Invalid Lidarr base URL format";

let cachedSchedulerConfigIdentity: unknown;
let cachedScheduler: LidarrScheduler | undefined;

/**
 * Normalizes a raw URL into a canonical origin, rejecting any embedded
 * credentials, path, query, or fragment.
 *
 * @param value - Raw base URL from config or a CLI override.
 * @returns The canonical origin, or `undefined` when the input is unsafe.
 */
function normalizeLidarrOrigin(value: string): string | undefined {
  const normalized = normalizeHttpUrl(value);
  if (!normalized.ok) {
    return undefined;
  }
  const { parsed, href, origin } = normalized.value;
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    href.includes("?") ||
    href.includes("#")
  ) {
    return undefined;
  }
  return origin;
}

/**
 * Resolves the Lidarr connection from loaded config and CLI overrides.
 *
 * @param overrides - CLI URL/API-key overrides.
 * @returns A resolved connection, or a typed failure reason.
 */
function resolveLidarrConnection(
  overrides?: LidarrClientOverrides,
  config: LidarrConfigOptions = getLoadedLidarrConfig(),
): LidarrConnectionResolution {
  const rawUrl = overrides?.lidarrUrl ?? config.baseUrl;
  const apiKey = overrides?.lidarrApiKey ?? config.apiKey;
  if (!rawUrl || !apiKey) {
    return { ok: false, reason: "missing" };
  }

  const origin = normalizeLidarrOrigin(rawUrl);
  if (origin === undefined) {
    return { ok: false, reason: "invalid-url" };
  }

  const request: Partial<LidarrRequestSettings> | undefined =
    config.timeoutMs === undefined ? undefined : { timeoutMs: config.timeoutMs };
  const connection = createLidarrConnectionSettings({ origin, apiKey, request });
  return { ok: true, connection };
}

/**
 * Creates a Lidarr client from loaded config and CLI overrides.
 *
 * @param overrides - CLI URL/API-key overrides.
 * @returns A client, or `undefined` when the connection cannot be resolved.
 */
export function createLidarrClient(overrides?: LidarrClientOverrides): LidarrClient | undefined {
  const resolved = resolveLidarrConnection(overrides);
  if (!resolved.ok) {
    return undefined;
  }
  return new LidarrClient(resolved.connection, new StaticLidarrApiKeyProvider(resolved.connection));
}

/**
 * Resolves the canonical Lidarr origin without requiring or expanding an API key.
 *
 * @param overrides - Optional CLI URL override.
 * @returns The credential-free canonical origin.
 * @throws {LidarrValidationError} With code `configuration` when the base URL
 *   is missing or malformed.
 */
export function resolveRequiredLidarrOriginWithoutCredentials(
  overrides?: Pick<LidarrClientOverrides, "lidarrUrl">,
): string {
  const rawUrl = overrides?.lidarrUrl ?? getLoadedLidarrConfig().baseUrl;
  if (!rawUrl) {
    throw new LidarrValidationError(
      "resolve lidarr origin",
      MISSING_ORIGIN_MESSAGE,
      "configuration",
    );
  }

  const origin = normalizeLidarrOrigin(rawUrl);
  if (origin === undefined) {
    throw new LidarrValidationError("resolve lidarr origin", INVALID_URL_MESSAGE, "configuration");
  }
  return origin;
}

/** Resolves the credential-free canonical origin used to bind online plan artifacts. */
export function resolveRequiredLidarrOrigin(overrides?: LidarrClientOverrides): string {
  const origin = resolveRequiredLidarrOriginWithoutCredentials(overrides);
  const apiKey = overrides?.lidarrApiKey ?? getLoadedLidarrConfig().apiKey;
  if (!apiKey) {
    throw new LidarrValidationError(
      "resolve lidarr origin",
      MISSING_CONNECTION_MESSAGE,
      "configuration",
    );
  }
  return origin;
}

/**
 * Resolves the process-wide scheduler from the validated loaded Lidarr configuration.
 *
 * Calls that observe the same scheduler configuration object share one
 * scheduler and its four lane limiters. Replacing the scheduler configuration
 * invalidates the cache without retaining any connection credentials.
 *
 * @returns A configured, frozen {@link LidarrScheduler}.
 */
export function resolveLidarrScheduler(): LidarrScheduler {
  const schedulerConfig = getLoadedLidarrConfig().scheduler;
  if (cachedScheduler === undefined || cachedSchedulerConfigIdentity !== schedulerConfig) {
    const policy = resolveLidarrSchedulerPolicy(schedulerConfig);
    cachedScheduler = createLidarrScheduler(policy);
    cachedSchedulerConfigIdentity = schedulerConfig;
  }
  return cachedScheduler;
}

/**
 * Resolves the shared context for one scheduler-owned Lidarr operation.
 *
 * One connection produces one raw facade and one resilience context. Breaker
 * and database initialization remain lazy until the scheduler invokes
 * `preflight`; that preflight uses the raw facade and the resilience context's
 * exact persisted breaker pair. Cache helpers are returned unchanged so they
 * retain the same origin, policy, database, and stale-consent closure.
 *
 * @param overrides - CLI URL/API-key overrides.
 * @param resilience - Per-invocation tier and stale-cache options.
 * @returns A frozen client/preflight/cache execution context.
 * @throws {LidarrValidationError} With code `configuration` when the base URL
 *   or API key is missing or the base URL is malformed.
 */
export function resolveRequiredLidarrExecutionContext(
  overrides?: LidarrClientOverrides,
  resilience: LidarrResilienceCallOptions = {},
): LidarrExecutionContext {
  const config = getLoadedLidarrConfig();
  const resolved = resolveLidarrConnection(overrides, config);
  if (!resolved.ok) {
    throw new LidarrValidationError(
      "resolve lidarr client",
      resolved.reason === "missing" ? MISSING_CONNECTION_MESSAGE : INVALID_URL_MESSAGE,
      "configuration",
    );
  }

  logDebug(`Resolved Lidarr client for origin ${resolved.connection.origin}`);
  const inner = new LidarrClient(
    resolved.connection,
    new StaticLidarrApiKeyProvider(resolved.connection),
  );
  const policy = resolveResiliencePolicy(config.resilience);
  const context = createLidarrResilienceContext(
    inner,
    resolved.connection.origin,
    policy,
    resilience,
  );

  let preflightPromise: Promise<LidarrSchedulerPreflight> | undefined;
  const createPreflight = async (): Promise<LidarrSchedulerPreflight> => {
    const breakers = await context.getBreakers();
    return createLidarrSchedulerPreflight(inner, breakers);
  };
  const resolvePreflight = async (): Promise<LidarrSchedulerPreflight> => {
    try {
      preflightPromise ??= createPreflight();
      return await preflightPromise;
    } catch (error) {
      preflightPromise = undefined;
      throw error;
    }
  };
  const preflight: LidarrSchedulerPreflight = async (preflightContext): Promise<void> => {
    const runPreflight = await resolvePreflight();
    await runPreflight(preflightContext);
  };

  return Object.freeze({
    client: context.client,
    preflight,
    writeLookupCache: context.writeLookupCache,
    tryServeStale: context.tryServeStale,
  });
}

/**
 * Resolves a required Lidarr client, throwing when the connection is missing or
 * invalid. Actions call this so failures surface as typed configuration errors.
 *
 * The returned client is the facade wrapped in the #195 resilience decorator:
 * the policy comes from the loaded `lidarr.resilience` config (design §5
 * defaults applied via {@link resolveResiliencePolicy}), the credential-free
 * canonical origin scopes breaker/cache state, and the optional `resilience`
 * argument carries per-invocation tier/stale options from the action layer.
 * The return type is unchanged (`LidarrClientApi`), so existing barrel mocks
 * keep working — the extra argument is simply ignored by mocks.
 *
 * @param overrides - CLI URL/API-key overrides.
 * @param resilience - Per-invocation resilience options (tier, `--allow-stale`,
 *   stale-serve callback); defaults to local-only tier with no stale consent.
 * @returns A ready {@link LidarrClientApi} implementation (resilience-decorated).
 * @throws {LidarrValidationError} With code `configuration` when the base URL or
 *   API key is missing or the base URL is malformed.
 */
export function resolveRequiredLidarrClient(
  overrides?: LidarrClientOverrides,
  resilience: LidarrResilienceCallOptions = {},
): LidarrClientApi {
  return resolveRequiredLidarrExecutionContext(overrides, resilience).client;
}
