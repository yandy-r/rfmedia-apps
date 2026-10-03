/**
 * Read-only Lidarr album listing action.
 *
 * Composes the shared fail-closed album scan with the pure selection
 * primitives: scan → artist-name resolution → AND filtering → deterministic
 * (artistId, albumId) sort → client-side limit/offset window. Never a
 * silently partial listing (any failed or skipped scan task aborts before
 * anything is returned), and deliberately no album metadata cache or
 * `--allow-stale` — every listing is a live read.
 */

import { resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import {
  filterLidarrAlbums,
  pageLidarrAlbums,
  sortLidarrAlbumsDeterministic,
} from "../../lib/lidarr/album-selection.js";
import {
  LidarrPlanValidationError,
  MissingRequiredArgumentError,
  OptionConflictError,
} from "../../lib/errors.js";
import {
  scanExplicitAlbums,
  scanSelectedArtists,
  type AlbumScanTaskOptions,
} from "./album-scan.js";
import type { LidarrAlbumTypeSelector } from "../../lib/lidarr/album-types.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { LidarrAlbum } from "../../types/lidarr.js";

export const TIER: LidarrTier = "local-only";

/** Task naming for this action's shared album scan (stable read-lane ids). */
const ALBUM_SCAN_TASK_OPTIONS: AlbumScanTaskOptions = {
  taskIdPrefix: "lidarr-albums",
  operationLabel: "lidarr albums",
};

export interface LidarrAlbumsActionOptions {
  /** Artist scope: list albums for exactly these artists. */
  readonly artistIds?: readonly number[];
  /** Explicit album scope (fail-closed on missing/extra IDs; conflicts with types). */
  readonly albumIds?: readonly number[];
  /** Explicit opt-in to a library-wide per-artist scan. */
  readonly all?: boolean;
  /** Album-type selectors; OR within the list, AND with the other filters. */
  readonly types?: readonly LidarrAlbumTypeSelector[];
  /** Required monitored state. */
  readonly monitored?: boolean;
  /** Required on-disk file presence; absent statistics counts as no files. */
  readonly hasFiles?: boolean;
  /** Maximum rows to return (window applied AFTER the deterministic sort). */
  readonly limit: number;
  /** Zero-based window start over the filtered, sorted listing. */
  readonly offset: number;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

/** One listed album with its owning artist resolved for review context. */
export interface LidarrAlbumRow extends LidarrAlbum {
  readonly artistName: string;
}

export interface LidarrAlbumsActionResult {
  /** Albums in the requested window, in (artistId, albumId) order. */
  readonly albums: readonly LidarrAlbumRow[];
  /** Total matching albums BEFORE the limit/offset window. */
  readonly total: number;
  /** Honest scan accounting across the selected scope. */
  readonly scanned: { readonly artists: number; readonly albums: number };
  /** Echoed window plus the actual returned row count. */
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly returned: number;
  };
  /** Execution metadata from the last succeeded scheduler task. */
  readonly execution: LidarrExecutionSuccessMetadata;
}

/**
 * Action-level fail-fast guard mirroring the command layer: exactly ONE of
 * artistIds/albumIds/all must be selected, and explicit album IDs cannot be
 * combined with type selectors.
 */
function validateScope(options: LidarrAlbumsActionOptions): void {
  const selectedScopes = [
    options.artistIds !== undefined,
    options.albumIds !== undefined,
    options.all === true,
  ].filter((selected) => selected).length;
  if (selectedScopes !== 1) {
    throw new MissingRequiredArgumentError(
      "Choose exactly one selection scope: --artist-ids, --album-ids, or --all",
    );
  }
  if (options.albumIds !== undefined && options.types !== undefined) {
    throw new OptionConflictError("--album-ids", "--types");
  }
}

/** Resolves an album's artist name; the scan guarantees coverage, so a gap is an invariant break. */
function requireArtistName(artistNames: ReadonlyMap<number, string>, album: LidarrAlbum): string {
  const artistName = artistNames.get(album.artistId);
  if (artistName === undefined) {
    throw new LidarrPlanValidationError(`Lidarr artists were not found for album IDs: ${album.id}`);
  }
  return artistName;
}

/**
 * Lists Lidarr albums for one explicit scope with AND-composed filters and a
 * stable client-side window.
 *
 * `--all` iterates per artist through the fail-closed scheduler batch — the
 * whole-library client scope guard is never weakened — and any failed or
 * skipped task aborts with no partial listing. `total`/`returned` account
 * honestly: an offset at or beyond the filtered total yields an empty window.
 *
 * @param options - Scope, filters, window, and connection overrides.
 * @returns The windowed rows plus scan/pagination/execution accounting.
 * @throws {MissingRequiredArgumentError} When not exactly one scope is selected.
 * @throws {OptionConflictError} When albumIds are combined with type selectors.
 * @throws {LidarrPlanValidationError} On missing/extra/orphaned IDs or any
 *   failed or skipped scan task (never a silently partial listing).
 */
export async function executeLidarrAlbums(
  options: LidarrAlbumsActionOptions,
): Promise<LidarrAlbumsActionResult> {
  validateScope(options);
  const client = resolveRequiredLidarrClient(
    { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey },
    { tier: TIER, retryAttemptsOverride: 0 },
  );
  // --all maps to an undefined artist scope: a per-artist whole-library scan.
  const scan =
    options.albumIds !== undefined
      ? await scanExplicitAlbums(client, options.albumIds, ALBUM_SCAN_TASK_OPTIONS)
      : await scanSelectedArtists(client, options.artistIds, ALBUM_SCAN_TASK_OPTIONS);
  // Map every scanned album to its artist BEFORE filtering (fail-fast invariant).
  for (const album of scan.albums) {
    requireArtistName(scan.artistNames, album);
  }
  const matched = filterLidarrAlbums(scan.albums, {
    ...(options.types === undefined ? {} : { types: options.types }),
    ...(options.monitored === undefined ? {} : { monitored: options.monitored }),
    ...(options.hasFiles === undefined ? {} : { hasFiles: options.hasFiles }),
  });
  const window = pageLidarrAlbums(sortLidarrAlbumsDeterministic(matched), {
    limit: options.limit,
    offset: options.offset,
  });
  const albums = Object.freeze(
    window.map((album) =>
      Object.freeze({ ...album, artistName: requireArtistName(scan.artistNames, album) }),
    ),
  );
  return Object.freeze({
    albums,
    total: matched.length,
    scanned: Object.freeze({ artists: scan.artistsScanned, albums: scan.albums.length }),
    pagination: Object.freeze({
      limit: options.limit,
      offset: options.offset,
      returned: window.length,
    }),
    execution: Object.freeze({ ...scan.execution }),
  });
}
