/** Creates a sealed or previewed Lidarr album-monitoring plan without mutating Lidarr. */

import { resolve } from "node:path";

import {
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import {
  matchesAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "../../lib/lidarr/album-types.js";
import { countBySelector } from "../../lib/lidarr/album-selection.js";
import { resolveLidarrCascadePolicy } from "../../lib/lidarr/cascade-analysis.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import {
  buildLidarrAlbumMonitoringPlanV3,
  writeLidarrPlanArtifact,
} from "../../lib/lidarr/plan-engine.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import { defaultOutputPath } from "./plan.js";
import {
  scanExplicitAlbums,
  scanSelectedArtists,
  type AlbumScanTaskOptions,
} from "./album-scan.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { LidarrAlbum } from "../../types/lidarr.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  LIDARR_PLAN_MAX_ENTRIES,
  type LidarrAlbumMonitoringPlanV3,
} from "../../types/lidarr-plan.js";

export const TIER: LidarrTier = "local-only";

/** Task naming for the shared album scan; byte-identical to the shipped ids. */
const ALBUM_SCAN_TASK_OPTIONS: AlbumScanTaskOptions = {
  taskIdPrefix: "lidarr-plan-album-monitoring",
  operationLabel: "lidarr plan album monitoring",
};

export interface LidarrAlbumPlanActionOptions {
  /** Desired monitored state for every matched album. */
  readonly monitored: boolean;
  /** Canonical album-type selectors (selector mode). */
  readonly types?: readonly LidarrAlbumTypeSelector[];
  /** Optional artist scope for selector mode. */
  readonly artistIds?: readonly number[];
  /** Exact album IDs (explicit-ID mode; conflicts with selectors). */
  readonly albumIds?: readonly number[];
  readonly dryRun?: boolean;
  readonly maxBatch?: number;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

/**
 * Honest scan/match accounting for review before sealing.
 *
 * `bySelector` counts are OVERLAPPING: an album matched by several selectors
 * increments each selector's count while counting once in `matched`.
 */
export interface LidarrAlbumPlanSelectionSummary {
  readonly artistsScanned: number;
  readonly albumsScanned: number;
  readonly matched: number;
  readonly alreadyInDesiredState: number;
  readonly planned: number;
  readonly bySelector: Readonly<Record<string, number>>;
}

export type LidarrAlbumPlanGenerationResult =
  | {
      readonly status: "planned";
      readonly plan: LidarrAlbumMonitoringPlanV3;
      readonly planPath: string;
      readonly selection: LidarrAlbumPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "previewed";
      readonly plan: LidarrAlbumMonitoringPlanV3;
      readonly selection: LidarrAlbumPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "no-change";
      readonly selection: LidarrAlbumPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    };

function requireUniqueIds(ids: readonly number[], label: "album" | "artist"): void {
  if (ids.length === 0) {
    throw new LidarrPlanValidationError(`at least one ${label} ID is required`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new LidarrPlanValidationError(`${label} IDs must be unique`);
  }
}

/** Validates the selection flags and returns canonical selectors (`[]` in explicit-ID mode). */
function validateSelection(
  options: LidarrAlbumPlanActionOptions,
): readonly LidarrAlbumTypeSelector[] {
  if (options.albumIds !== undefined) {
    if (options.types !== undefined || options.artistIds !== undefined) {
      throw new LidarrPlanValidationError("--album-ids conflicts with --types and --artist-ids");
    }
    requireUniqueIds(options.albumIds, "album");
    return [];
  }
  if (options.types === undefined || options.types.length === 0) {
    throw new LidarrPlanValidationError("pass --types or --album-ids to select albums");
  }
  if (options.artistIds !== undefined) {
    requireUniqueIds(options.artistIds, "artist");
  }
  return [...new Set(options.types)].sort();
}

function requireArtistName(artistNames: ReadonlyMap<number, string>, album: LidarrAlbum): string {
  const artistName = artistNames.get(album.artistId);
  if (artistName === undefined) {
    throw new LidarrPlanValidationError(`Lidarr artists were not found for album IDs: ${album.id}`);
  }
  return artistName;
}

/**
 * Builds an album-monitoring plan (dry-run preview or sealed artifact).
 *
 * Never a silently partial plan: missing explicit IDs, unknown artist scopes,
 * and any failed or skipped batch task all fail closed before anything is
 * written. Plan entries are changes-only; the selection summary still reports
 * the full scanned/matched accounting.
 */
export async function executeLidarrAlbumPlan(
  options: LidarrAlbumPlanActionOptions,
): Promise<LidarrAlbumPlanGenerationResult> {
  const selectors = validateSelection(options);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const client = resolveRequiredLidarrClient(overrides, {
    tier: TIER,
    retryAttemptsOverride: 0,
  });
  const scan =
    options.albumIds !== undefined
      ? await scanExplicitAlbums(client, options.albumIds, ALBUM_SCAN_TASK_OPTIONS)
      : await scanSelectedArtists(client, options.artistIds, ALBUM_SCAN_TASK_OPTIONS);
  const matched =
    options.albumIds !== undefined
      ? scan.albums
      : scan.albums.filter((album) => matchesAlbumTypeSelectors(album, selectors));
  const changed = matched.filter((album) => album.monitored !== options.monitored);
  const selection: LidarrAlbumPlanSelectionSummary = {
    artistsScanned: scan.artistsScanned,
    albumsScanned: scan.albums.length,
    matched: matched.length,
    alreadyInDesiredState: matched.length - changed.length,
    planned: changed.length,
    bySelector: countBySelector(matched, selectors),
  };
  if (changed.length === 0) {
    if (options.dryRun === true) {
      return { status: "no-change", selection, execution: scan.execution };
    }
    throw new LidarrPlanValidationError(
      "no album monitoring changes to plan; inspect the selection with --dry-run",
    );
  }
  if (changed.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw new LidarrPlanValidationError(
      `planned ${changed.length} change(s) exceed the ${LIDARR_PLAN_MAX_ENTRIES}-entry plan cap; ` +
        "split the work with --artist-ids across successive plans",
    );
  }
  const maxBatch = options.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH;
  if (changed.length > maxBatch) {
    const narrowHint =
      options.albumIds !== undefined ? "pass fewer --album-ids" : "narrow --types/--artist-ids";
    throw new LidarrPlanValidationError(
      `planned ${changed.length} change(s) exceed --max-batch ${maxBatch}; ` +
        `re-run with --max-batch ${changed.length} or ${narrowHint}`,
    );
  }
  const plan = buildLidarrAlbumMonitoringPlanV3({
    origin,
    operation: { kind: "album-monitoring", desiredMonitored: options.monitored, selectors },
    maxBatch,
    entries: changed.map((album) => ({
      albumId: album.id,
      albumTitle: album.title,
      artistId: album.artistId,
      artistName: requireArtistName(scan.artistNames, album),
      ...(album.albumType === undefined ? {} : { albumType: album.albumType }),
      monitored: album.monitored,
    })),
    cascadePolicy,
  });
  if (options.dryRun === true) {
    return { status: "previewed", plan, selection, execution: scan.execution };
  }
  const planPath = resolve(options.output ?? defaultOutputPath(plan.id, plan.createdAt));
  await writeLidarrPlanArtifact(planPath, plan);
  return { status: "planned", plan, planPath, selection, execution: scan.execution };
}
