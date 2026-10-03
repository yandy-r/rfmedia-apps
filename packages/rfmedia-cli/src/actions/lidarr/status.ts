/**
 * `rfmedia lidarr status` action — Lidarr library overview.
 *
 * Framework-agnostic: resolves the required Lidarr client, fetches the system
 * status and full artist list, and aggregates artist counts, disk usage, and
 * track totals into a typed result. Output formatting lives in the command
 * layer; this action performs a pure projection and never renders.
 */

import { resolveLidarrScheduler, resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { logDebug, logInfo } from "../../lib/logger.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import type { LidarrArtist, LidarrSystemStatus } from "../../types/lidarr.js";

/** Reliability tier for the `status` action. */
export const TIER: LidarrTier = "local-only";

/** Options for the `lidarr status` action. */
export interface LidarrStatusActionOptions {
  /** `--allow-stale` consent to serve cached data when Lidarr is unreachable. */
  allowStale?: boolean;
  /** `--lidarr-url` override for the configured base URL. */
  lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  lidarrApiKey?: string;
}

/** Aggregated Lidarr library overview. */
export interface LidarrStatusActionResult {
  /** Execution-lane metadata for this action. */
  execution: LidarrExecutionSuccessMetadata;
  /** Lidarr application version. */
  version: string;
  /** Operator-assigned instance name, when reported. */
  instanceName?: string;
  /** Total number of artists in the library. */
  artistCount: number;
  /** Number of monitored artists. */
  monitoredCount: number;
  /** Number of unmonitored artists. */
  unmonitoredCount: number;
  /** Sum of `statistics.sizeOnDisk` across all artists, in bytes. */
  totalSizeOnDisk: number;
  /** Sum of `statistics.trackFileCount` across all artists. */
  trackFileCount: number;
  /** Sum of `statistics.trackCount` across all artists. */
  trackCount: number;
  /** Set when a stale cached projection was served under `--allow-stale`. */
  cacheStatus?: LidarrCacheStatus;
}

/**
 * Aggregates a system status and artist list into a library overview.
 *
 * @param systemStatus - The Lidarr system status.
 * @param artists - The full artist list.
 * @returns The aggregated {@link LidarrStatusActionResult}.
 */
function projectStatus(
  systemStatus: LidarrSystemStatus,
  artists: readonly LidarrArtist[],
): Omit<LidarrStatusActionResult, "execution"> {
  let monitoredCount = 0;
  let totalSizeOnDisk = 0;
  let trackFileCount = 0;
  let trackCount = 0;

  for (const artist of artists) {
    if (artist.monitored) {
      monitoredCount += 1;
    }
    const stats = artist.statistics;
    if (stats !== undefined) {
      totalSizeOnDisk += stats.sizeOnDisk;
      trackFileCount += stats.trackFileCount;
      trackCount += stats.trackCount;
    }
  }

  return {
    version: systemStatus.version,
    instanceName: systemStatus.instanceName,
    artistCount: artists.length,
    monitoredCount,
    unmonitoredCount: artists.length - monitoredCount,
    totalSizeOnDisk,
    trackFileCount,
    trackCount,
  };
}

/**
 * Executes the `lidarr status` action.
 *
 * @param options - CLI overrides for the Lidarr connection plus the
 *   `--allow-stale` consent flag.
 * @returns The aggregated library overview; `cacheStatus` is attached when a
 *   stale cached projection was served under `--allow-stale`.
 * @throws {LidarrError} When the client is unresolved or a request fails; the
 *   action does not swallow client errors.
 */
export async function executeLidarrStatus(
  options: LidarrStatusActionOptions,
): Promise<LidarrStatusActionResult> {
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-status",
    operation: "lidarr status",
    idempotent: true,
    run: async () => {
      let cacheStatus: LidarrCacheStatus | undefined;
      const client = resolveRequiredLidarrClient(
        {
          lidarrUrl: options.lidarrUrl,
          lidarrApiKey: options.lidarrApiKey,
        },
        {
          tier: TIER,
          allowStale: options.allowStale,
          retryAttemptsOverride: 0,
          onStaleServe: (status) => {
            cacheStatus = status;
          },
        },
      );
      logDebug("lidarr status: fetching system status and artist list");
      // Sequenced deliberately: under --allow-stale each decorated call falls back
      // to its own cache row independently. system-status is only cached by a
      // successful `status` run, while artists may be cached by `list` alone, so
      // fetching system status first fails fast before the artists call can emit
      // a contradictory "serving cached data" warning.
      const systemStatus = await client.getSystemStatus();
      const artists = await client.listArtists();
      const result = projectStatus(systemStatus, artists);
      logInfo(
        `Lidarr ${result.version}: ${result.artistCount} artists (${result.monitoredCount} monitored)`,
      );
      return cacheStatus === undefined ? result : { ...result, cacheStatus };
    },
  });
  return { ...scheduled.value, execution: scheduled.execution };
}
