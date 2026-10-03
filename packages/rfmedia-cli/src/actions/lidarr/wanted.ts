/**
 * `rfmedia lidarr wanted` action — wanted/missing albums.
 *
 * Framework-agnostic: resolves the required Lidarr client and fetches a single
 * server-paginated page of wanted/missing albums, then projects each record
 * into a flat row. Full traversal across pages is deferred; this action fetches
 * exactly the requested page.
 */

import { resolveLidarrScheduler, resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { logDebug, logInfo } from "../../lib/logger.js";
import type { LidarrWantedRecord } from "../../types/lidarr.js";

/** Reliability tier for the `wanted` action. */
export const TIER: LidarrTier = "local-only";

/** Options for the `lidarr wanted` action. */
export interface LidarrWantedActionOptions {
  /** 1-based page number; defaults to 1 (applied by the client). */
  page?: number;
  /** Page size; defaults to 50 (applied by the client). */
  pageSize?: number;
  /** Sort key; defaults to `releaseDate` (applied by the client). */
  sortKey?: string;
  /** Sort direction. */
  sortDir?: "ascending" | "descending";
  /** `--lidarr-url` override for the configured base URL. */
  lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  lidarrApiKey?: string;
}

/** A single projected wanted/missing row. */
export interface LidarrWantedItem {
  /** Album id. */
  albumId: number;
  /** Album title. */
  title: string;
  /** Owning artist display name. */
  artistName: string;
  /** ISO release date, when known. */
  releaseDate?: string;
  /** Whether the album is monitored. */
  monitored: boolean;
}

/** Result of the `lidarr wanted` action. */
export interface LidarrWantedActionResult {
  /** Execution-lane metadata for this action. */
  execution: LidarrExecutionSuccessMetadata;
  /** The projected wanted/missing rows for the fetched page. */
  records: readonly LidarrWantedItem[];
  /** 1-based page number returned by the server. */
  page: number;
  /** Page size returned by the server. */
  pageSize: number;
  /** Total wanted records across all pages. */
  totalRecords: number;
}

/**
 * Projects a wanted/missing wire record into a flat row.
 *
 * @param record - The source wanted/missing record.
 * @returns The projected {@link LidarrWantedItem}.
 */
function projectRecord(record: LidarrWantedRecord): LidarrWantedItem {
  return {
    albumId: record.id,
    title: record.title,
    artistName: record.artist.artistName,
    releaseDate: record.releaseDate,
    monitored: record.monitored,
  };
}

/**
 * Executes the `lidarr wanted` action.
 *
 * @param options - Paging/sort options plus CLI connection overrides.
 * @returns The projected wanted/missing rows for the requested page.
 * @throws {LidarrError} When the client is unresolved or the request fails.
 */
export async function executeLidarrWanted(
  options: LidarrWantedActionOptions,
): Promise<LidarrWantedActionResult> {
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-wanted",
    operation: "lidarr wanted",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(
        {
          lidarrUrl: options.lidarrUrl,
          lidarrApiKey: options.lidarrApiKey,
        },
        { tier: TIER, retryAttemptsOverride: 0 },
      );
      logDebug("lidarr wanted: fetching wanted/missing page");
      const page = await client.getWantedMissing({
        page: options.page,
        pageSize: options.pageSize,
        sortKey: options.sortKey,
        sortDirection: options.sortDir,
      });

      logInfo(`Lidarr wanted: page ${page.page} — ${page.totalRecords} wanted`);
      return {
        records: page.records.map(projectRecord),
        page: page.page,
        pageSize: page.pageSize,
        totalRecords: page.totalRecords,
      };
    },
  });
  return { ...scheduled.value, execution: scheduled.execution };
}
