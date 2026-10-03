/**
 * Shared fail-closed Lidarr album scanning for the album plan and read lanes.
 *
 * Extracted behavior-identically from plan-albums.ts: scheduler task ids and
 * operation labels are parameterized through {@link AlbumScanTaskOptions} so
 * the shipped album-monitoring lane keeps byte-identical task ids, log lines,
 * and failure text.
 */

import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import { dedupeAlbums } from "../../lib/lidarr/album-selection.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import { logInfo } from "../../lib/logger.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type {
  LidarrExecutionSuccessMetadata,
  LidarrScheduledTask,
} from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { LidarrAlbum } from "../../types/lidarr.js";

const TIER: LidarrTier = "local-only";

/** Emit one stderr progress line per this many per-artist album fetches. */
const FETCH_PROGRESS_INTERVAL = 100;

/** Scheduler task naming for one scan invocation. */
export interface AlbumScanTaskOptions {
  /** Task-id prefix, e.g. `"lidarr-plan-album-monitoring"`. */
  readonly taskIdPrefix: string;
  /** Operation label attached to every scheduler task. */
  readonly operationLabel: string;
}

/** Result of a fail-closed album scan: albums plus artist review context. */
export interface AlbumScan {
  /** Deduped albums in scope. */
  readonly albums: readonly LidarrAlbum[];
  /** Artist names by artist id for plan-entry review context. */
  readonly artistNames: ReadonlyMap<number, string>;
  /** Number of artists covered by the scan. */
  readonly artistsScanned: number;
  /** Execution metadata from the last succeeded scheduler task. */
  readonly execution: LidarrExecutionSuccessMetadata;
}

/**
 * Fetches exact album IDs; every requested ID and its artist must exist, and
 * any album the server returns beyond the requested set fails the scan closed.
 *
 * @param client - Resolved Lidarr client.
 * @param albumIds - Exact album ids to fetch.
 * @param options - Scheduler task naming for this scan.
 * @returns The fail-closed scan result.
 * @throws {LidarrPlanValidationError} On missing IDs, extra returned IDs, or
 *   orphaned artist references.
 */
export async function scanExplicitAlbums(
  client: LidarrClientApi,
  albumIds: readonly number[],
  { taskIdPrefix, operationLabel }: AlbumScanTaskOptions,
): Promise<AlbumScan> {
  const scheduler = resolveLidarrScheduler();
  const albumsRead = await scheduler.runSingle(TIER, {
    id: taskIdPrefix,
    operation: operationLabel,
    idempotent: true,
    run: () => client.listAlbums({ albumIds }),
  });
  const found = new Set(albumsRead.value.map((album) => album.id));
  const missing = albumIds.filter((albumId) => !found.has(albumId));
  if (missing.length > 0) {
    throw new LidarrPlanValidationError(`Lidarr album IDs were not found: ${missing.join(", ")}`);
  }
  const requested = new Set(albumIds);
  const extraIds = [
    ...new Set(albumsRead.value.filter((album) => !requested.has(album.id)).map((a) => a.id)),
  ].sort((a, b) => a - b);
  if (extraIds.length > 0) {
    throw new LidarrPlanValidationError(
      `Lidarr returned album IDs that were not requested: ${extraIds.join(", ")}`,
    );
  }
  const artistsRead = await scheduler.runSingle(TIER, {
    id: `${taskIdPrefix}-artists`,
    operation: operationLabel,
    idempotent: true,
    run: () => client.listArtists(),
  });
  const artistNames = new Map(
    artistsRead.value.map((artist) => [artist.id, artist.artistName] as const),
  );
  const albums = dedupeAlbums(albumsRead.value);
  const orphaned = albums.filter((album) => !artistNames.has(album.artistId));
  if (orphaned.length > 0) {
    throw new LidarrPlanValidationError(
      `Lidarr artists were not found for album IDs: ${orphaned.map((album) => album.id).join(", ")}`,
    );
  }
  return {
    albums,
    artistNames,
    artistsScanned: new Set(albums.map((album) => album.artistId)).size,
    execution: artistsRead.execution,
  };
}

/**
 * Fetches albums per in-scope artist through one fail-closed scheduler batch.
 *
 * @param client - Resolved Lidarr client.
 * @param artistIds - Optional artist scope; `undefined` scans every artist.
 * @param options - Scheduler task naming for this scan.
 * @returns The fail-closed scan result.
 * @throws {LidarrPlanValidationError} On unknown artist IDs or any failed or
 *   skipped batch task (never a silently partial listing).
 */
export async function scanSelectedArtists(
  client: LidarrClientApi,
  artistIds: readonly number[] | undefined,
  { taskIdPrefix, operationLabel }: AlbumScanTaskOptions,
): Promise<AlbumScan> {
  const scheduler = resolveLidarrScheduler();
  const artistsRead = await scheduler.runSingle(TIER, {
    id: `${taskIdPrefix}-artists`,
    operation: operationLabel,
    idempotent: true,
    run: () => client.listArtists(),
  });
  let inScope = [...artistsRead.value];
  if (artistIds !== undefined) {
    const known = new Set(artistsRead.value.map((artist) => artist.id));
    const missing = artistIds.filter((artistId) => !known.has(artistId));
    if (missing.length > 0) {
      throw new LidarrPlanValidationError(
        `Lidarr artist IDs were not found: ${missing.join(", ")}`,
      );
    }
    const requested = new Set(artistIds);
    inScope = inScope.filter((artist) => requested.has(artist.id));
  }

  let execution: LidarrExecutionSuccessMetadata = artistsRead.execution;
  const albums: LidarrAlbum[] = [];
  if (inScope.length > 0) {
    let fetched = 0;
    const tasks: LidarrScheduledTask<readonly LidarrAlbum[]>[] = inScope.map((artist) => ({
      id: `${taskIdPrefix}-${artist.id}`,
      operation: operationLabel,
      idempotent: true,
      run: async () => {
        const artistAlbums = await client.listAlbums({ artistId: artist.id });
        fetched += 1;
        if (fetched % FETCH_PROGRESS_INTERVAL === 0 || fetched === inScope.length) {
          logInfo(`Fetched albums for ${fetched}/${inScope.length} artists`);
        }
        return artistAlbums;
      },
    }));
    const batch = await scheduler.runBatch(TIER, tasks);
    const failed = batch.results.filter((result) => result.outcome === "failed").length;
    const skipped = batch.results.filter((result) => result.outcome === "skipped").length;
    if (failed > 0 || skipped > 0) {
      throw new LidarrPlanValidationError(
        `album listing did not complete (${failed} failed, ${skipped} skipped); ` +
          "no partial plan is written — narrow with --artist-ids and retry",
      );
    }
    for (const result of batch.results) {
      if (result.outcome === "succeeded") {
        albums.push(...result.value);
        execution = {
          taskId: result.taskId,
          operation: result.operation,
          lane: result.lane,
          outcome: "succeeded",
          attempts: result.attempts,
        };
      }
    }
  }
  return {
    albums: dedupeAlbums(albums),
    artistNames: new Map(inScope.map((artist) => [artist.id, artist.artistName] as const)),
    artistsScanned: inScope.length,
    execution,
  };
}
