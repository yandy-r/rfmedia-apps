/**
 * `rfmedia lidarr health` action — system health checks.
 *
 * Framework-agnostic: resolves the required Lidarr client, fetches the current
 * health checks, optionally filters them by severity, and reports whether any
 * error-level check is present. Additively surfaces the metadata-provider
 * outage view (from the health probe) and a point-in-time resilience snapshot
 * (circuit state per scope plus deferred-intent counts). This action is
 * diagnostic (surfacing, not gating); the command layer decides exit behavior.
 */

import { readLidarrResilienceSnapshot, runHealthProbe } from "../../lib/lidarr/health.js";
import type { LidarrHealthReport } from "../../lib/lidarr/health.js";
import { resolveLidarrScheduler, resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { logDebug, logInfo } from "../../lib/logger.js";
import type { LidarrHealthCheck, LidarrHealthType } from "../../types/lidarr.js";
import type { LidarrResilienceSnapshot } from "../../types/lidarr-resilience.js";

/** Reliability tier for the `health` action. */
export const TIER: LidarrTier = "local-only";

/** Options for the `lidarr health` action. */
export interface LidarrHealthActionOptions {
  /** Restrict to checks whose severity is in this set. */
  type?: readonly LidarrHealthType[];
  /** `--lidarr-url` override for the configured base URL. */
  lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  lidarrApiKey?: string;
}

/** Result of the `lidarr health` action. */
export interface LidarrHealthActionResult {
  /** Execution-lane metadata for this action. */
  execution: LidarrExecutionSuccessMetadata;
  /** The (optionally filtered) health checks. */
  checks: readonly LidarrHealthCheck[];
  /** True when any returned check is error-level. */
  hasErrors: boolean;
  /** Metadata-provider outage view derived from a fresh health probe. */
  metadataProvider: LidarrHealthReport["metadataProvider"];
  /**
   * Point-in-time resilience snapshot (circuit state per scope plus
   * deferred-intent counts). When persisted state cannot be read, entries
   * report `{ state: "unknown", reason }` and the action still succeeds.
   */
  resilience?: LidarrResilienceSnapshot;
}

/**
 * Executes the `lidarr health` action.
 *
 * @param options - Optional severity filter plus CLI connection overrides.
 * @returns The health checks, an aggregate `hasErrors` flag, the
 *   metadata-provider outage view, and the resilience snapshot.
 * @throws {LidarrError} When the client is unresolved or the request fails.
 */
export async function executeLidarrHealth(
  options: LidarrHealthActionOptions,
): Promise<LidarrHealthActionResult> {
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-health",
    operation: "lidarr health",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(
        {
          lidarrUrl: options.lidarrUrl,
          lidarrApiKey: options.lidarrApiKey,
        },
        { tier: TIER, retryAttemptsOverride: 0 },
      );
      logDebug("lidarr health: fetching health checks");
      const allChecks = await client.getHealth();

      const checks =
        options.type !== undefined && options.type.length > 0
          ? allChecks.filter((check) => options.type?.includes(check.type) === true)
          : allChecks;
      const hasErrors = checks.some((check) => check.type === "error");

      logDebug("lidarr health: probing metadata-provider availability");
      const probeReport = await runHealthProbe(client);
      const resilience = await readLidarrResilienceSnapshot({
        lidarrUrl: options.lidarrUrl,
        lidarrApiKey: options.lidarrApiKey,
      });

      logInfo(`Lidarr health: ${checks.length} checks${hasErrors ? " (errors present)" : ""}`);
      return { checks, hasErrors, metadataProvider: probeReport.metadataProvider, resilience };
    },
  });
  return { ...scheduled.value, execution: scheduled.execution };
}
