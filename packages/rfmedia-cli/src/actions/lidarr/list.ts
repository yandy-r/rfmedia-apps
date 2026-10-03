/**
 * `rfmedia lidarr list` action — filtered artist listing.
 *
 * Framework-agnostic: resolves the required Lidarr client, fetches the full
 * artist list (the `/api/v1/artist` endpoint is not server-paginated), applies
 * client-side monitored/tag/quality-profile filters, then pages the filtered
 * result with `offset`/`limit`. The pre-slice count is surfaced as `total`.
 */

import { resolveLidarrScheduler, resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { logDebug, logInfo } from "../../lib/logger.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import type { LidarrArtist } from "../../types/lidarr.js";

/** Default page size applied when `--limit` is omitted. */
const DEFAULT_LIMIT = 50;
/** Default offset applied when `--offset` is omitted. */
const DEFAULT_OFFSET = 0;

/** Reliability tier for the `list` action. */
export const TIER: LidarrTier = "local-only";

/** Options for the `lidarr list` action. */
export interface LidarrListActionOptions {
  /** Restrict to artists carrying all of these tag ids. */
  tag?: readonly number[];
  /** Restrict to monitored artists. Mutually exclusive with `unmonitored`. */
  monitored?: boolean;
  /** Restrict to unmonitored artists. Mutually exclusive with `monitored`. */
  unmonitored?: boolean;
  /** Restrict to artists assigned this quality-profile id. */
  qualityProfile?: number;
  /** Maximum number of artists to return; defaults to 50. */
  limit?: number;
  /** Number of filtered artists to skip; defaults to 0. */
  offset?: number;
  /** `--allow-stale` consent to serve cached data when Lidarr is unreachable. */
  allowStale?: boolean;
  /** `--lidarr-url` override for the configured base URL. */
  lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  lidarrApiKey?: string;
}

/** A single projected artist row. */
export interface LidarrListItem {
  /** Lidarr-internal artist id. */
  id: number;
  /** Display name of the artist. */
  artistName: string;
  /** MusicBrainz artist id. */
  foreignArtistId: string;
  /** Whether the artist is monitored. */
  monitored: boolean;
  /** Quality-profile id assigned to the artist. */
  qualityProfileId: number;
  /** Tag ids applied to the artist. */
  tags: readonly number[];
  /** Album count from the artist statistics, or 0 when unreported. */
  albumCount: number;
  /** Size on disk in bytes from the artist statistics, or 0 when unreported. */
  sizeOnDisk: number;
}

/** Result of the `lidarr list` action. */
export interface LidarrListActionResult {
  /** Execution-lane metadata for this action. */
  execution: LidarrExecutionSuccessMetadata;
  /** The paged, filtered artist rows. */
  artists: readonly LidarrListItem[];
  /** Total matching artists before paging. */
  total: number;
  /** Effective limit applied. */
  limit: number;
  /** Effective offset applied. */
  offset: number;
  /** Set when a stale cached projection was served under `--allow-stale`. */
  cacheStatus?: LidarrCacheStatus;
}

/**
 * Determines whether an artist passes the configured filters.
 *
 * @param artist - The artist to test.
 * @param options - The active list options.
 * @returns True when the artist matches every active filter.
 */
function matchesFilters(artist: LidarrArtist, options: LidarrListActionOptions): boolean {
  if (options.monitored === true && !artist.monitored) {
    return false;
  }
  if (options.unmonitored === true && artist.monitored) {
    return false;
  }
  if (options.qualityProfile !== undefined && artist.qualityProfileId !== options.qualityProfile) {
    return false;
  }
  if (options.tag !== undefined && options.tag.length > 0) {
    const artistTags = new Set(artist.tags);
    if (!options.tag.every((tagId) => artistTags.has(tagId))) {
      return false;
    }
  }
  return true;
}

/**
 * Projects an artist wire record into a list row.
 *
 * @param artist - The source artist record.
 * @returns The projected {@link LidarrListItem}.
 */
function projectArtist(artist: LidarrArtist): LidarrListItem {
  return {
    id: artist.id,
    artistName: artist.artistName,
    foreignArtistId: artist.foreignArtistId,
    monitored: artist.monitored,
    qualityProfileId: artist.qualityProfileId,
    tags: artist.tags,
    albumCount: artist.statistics?.albumCount ?? 0,
    sizeOnDisk: artist.statistics?.sizeOnDisk ?? 0,
  };
}

/**
 * Executes the `lidarr list` action.
 *
 * @param options - Filter and paging options plus CLI connection overrides and
 *   the `--allow-stale` consent flag.
 * @returns The paged, filtered artist rows with the pre-slice total;
 *   `cacheStatus` is attached when a stale cached projection was served under
 *   `--allow-stale`.
 * @throws {LidarrError} When the client is unresolved or the request fails.
 */
export async function executeLidarrList(
  options: LidarrListActionOptions,
): Promise<LidarrListActionResult> {
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-list",
    operation: "lidarr list",
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
      logDebug("lidarr list: fetching artist list");
      const artists = await client.listArtists();

      const limit = options.limit ?? DEFAULT_LIMIT;
      const offset = options.offset ?? DEFAULT_OFFSET;
      const filtered = artists.filter((artist) => matchesFilters(artist, options));
      const page = filtered.slice(offset, offset + limit).map(projectArtist);

      logInfo(`Lidarr list: showing ${page.length} of ${filtered.length} artists`);
      const result: Omit<LidarrListActionResult, "execution"> = {
        artists: page,
        total: filtered.length,
        limit,
        offset,
      };
      return cacheStatus === undefined ? result : { ...result, cacheStatus };
    },
  });
  return { ...scheduled.value, execution: scheduled.execution };
}
