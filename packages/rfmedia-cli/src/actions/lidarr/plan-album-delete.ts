/**
 * Creates a sealed or previewed Lidarr album-delete plan without mutating
 * Lidarr.
 *
 * Plan-time safety layer for the first file-destructive Lidarr operation:
 * there is deliberately NO --all mode (a library-wide destructive sweep is
 * unexpressible), monitored albums are excluded unless explicitly opted in,
 * and the destruction mode (deleteFiles / import-list exclusion) is sealed
 * into the checksummed artifact — never re-decidable at apply time.
 */

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
import { writeLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import {
  buildLidarrAlbumMutationPlanV3,
  type LidarrAlbumPlanEntrySource,
} from "../../lib/lidarr/plan-album-operations.js";
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
  type LidarrAlbumMutationPlanV3,
  type LidarrAlbumPlanSelectionV2,
} from "../../types/lidarr-plan.js";

export const TIER: LidarrTier = "local-only";

/** Task naming for this producer's shared album scan (own stable ids). */
const ALBUM_SCAN_TASK_OPTIONS: AlbumScanTaskOptions = {
  taskIdPrefix: "lidarr-plan-album-delete",
  operationLabel: "lidarr plan album delete",
};

export interface LidarrAlbumDeletePlanActionOptions {
  /** Exact album IDs (explicit-ID mode; conflicts with selectors). */
  readonly albumIds?: readonly number[];
  /** REQUIRED artist scope in selector mode — no library-wide mode exists. */
  readonly artistIds?: readonly number[];
  /** Optional album-type narrowing within the artist scope. */
  readonly types?: readonly LidarrAlbumTypeSelector[];
  /** Opt-in to deleting monitored albums (excluded by default). */
  readonly includeMonitored?: boolean;
  /** Also delete track files on disk (sealed into the plan; default false). */
  readonly deleteFiles?: boolean;
  /** Add import-list exclusions for deleted albums (sealed; default false). */
  readonly addImportListExclusion?: boolean;
  readonly dryRun?: boolean;
  readonly maxBatch?: number;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

/**
 * Honest scan/match accounting for review before sealing a deletion.
 *
 * `bySelector` counts are OVERLAPPING: an album matched by several selectors
 * increments each selector's count while counting once in `matched`.
 * `withFiles`/`totalSizeOnDisk` cover only the PLANNED albums so the operator
 * sees the exact on-disk blast radius being authorized.
 */
export interface LidarrAlbumDeletePlanSelectionSummary {
  readonly artistsScanned: number;
  readonly albumsScanned: number;
  readonly matched: number;
  /** Monitored albums excluded by the default guard (0 with includeMonitored). */
  readonly excludedMonitored: number;
  readonly planned: number;
  readonly withFiles: number;
  readonly totalSizeOnDisk: number;
  readonly bySelector: Readonly<Record<string, number>>;
}

type LidarrAlbumDeletePlanV3 = Extract<
  LidarrAlbumMutationPlanV3,
  { readonly operation: { readonly kind: "album-delete" } }
>;

function isAlbumDeletePlanV3(plan: LidarrAlbumMutationPlanV3): plan is LidarrAlbumDeletePlanV3 {
  return plan.operation.kind === "album-delete";
}

export type LidarrAlbumDeletePlanGenerationResult =
  | {
      readonly status: "planned";
      readonly plan: LidarrAlbumDeletePlanV3;
      readonly planPath: string;
      readonly selection: LidarrAlbumDeletePlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "previewed";
      readonly plan: LidarrAlbumDeletePlanV3;
      readonly selection: LidarrAlbumDeletePlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "no-change";
      readonly selection: LidarrAlbumDeletePlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    };

/**
 * Validated selection scope. The discriminated shape makes the library-wide
 * sweep unexpressible: selector mode always carries a concrete artist list.
 */
type LidarrAlbumDeleteSelection =
  | { readonly mode: "album-ids"; readonly albumIds: readonly number[] }
  | {
      readonly mode: "album-filters";
      readonly artistIds: readonly number[];
      readonly selectors: readonly LidarrAlbumTypeSelector[];
    };

function requireUniqueIds(ids: readonly number[], label: "album" | "artist"): void {
  if (ids.length === 0) {
    throw new LidarrPlanValidationError(`at least one ${label} ID is required`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new LidarrPlanValidationError(`${label} IDs must be unique`);
  }
}

/** Validates the selection flags into exactly one explicit deletion scope. */
function validateSelection(
  options: LidarrAlbumDeletePlanActionOptions,
): LidarrAlbumDeleteSelection {
  if (options.albumIds !== undefined) {
    if (options.types !== undefined || options.artistIds !== undefined) {
      throw new LidarrPlanValidationError("--album-ids conflicts with --types and --artist-ids");
    }
    requireUniqueIds(options.albumIds, "album");
    return { mode: "album-ids", albumIds: options.albumIds };
  }
  if (options.artistIds === undefined) {
    throw new LidarrPlanValidationError(
      "album deletion requires an explicit --album-ids or --artist-ids scope",
    );
  }
  requireUniqueIds(options.artistIds, "artist");
  return {
    mode: "album-filters",
    artistIds: options.artistIds,
    selectors: options.types === undefined ? [] : [...new Set(options.types)].sort(),
  };
}

function requireArtistName(artistNames: ReadonlyMap<number, string>, album: LidarrAlbum): string {
  const artistName = artistNames.get(album.artistId);
  if (artistName === undefined) {
    throw new LidarrPlanValidationError(`Lidarr artists were not found for album IDs: ${album.id}`);
  }
  return artistName;
}

/** Ascending id order required by the sealed-selection validator. */
function sortIds(ids: readonly number[]): readonly number[] {
  return [...ids].sort((left, right) => left - right);
}

/**
 * Builds an album-delete plan (dry-run preview or sealed artifact).
 *
 * Never a silently partial plan: missing explicit IDs, unknown artist scopes,
 * and any failed or skipped batch task all fail closed before anything is
 * written. Monitored albums are excluded by default and counted honestly as
 * `excludedMonitored`; the destruction mode is sealed into the artifact.
 */
export async function executeLidarrAlbumDeletePlan(
  options: LidarrAlbumDeletePlanActionOptions,
): Promise<LidarrAlbumDeletePlanGenerationResult> {
  const selected = validateSelection(options);
  const includeMonitored = options.includeMonitored === true;
  const deleteFiles = options.deleteFiles === true;
  const addImportListExclusion = options.addImportListExclusion === true;
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const client = resolveRequiredLidarrClient(overrides, {
    tier: TIER,
    retryAttemptsOverride: 0,
  });
  const scan =
    selected.mode === "album-ids"
      ? await scanExplicitAlbums(client, selected.albumIds, ALBUM_SCAN_TASK_OPTIONS)
      : await scanSelectedArtists(client, selected.artistIds, ALBUM_SCAN_TASK_OPTIONS);
  const selectors = selected.mode === "album-ids" ? [] : selected.selectors;
  const matched =
    selectors.length === 0
      ? scan.albums
      : scan.albums.filter((album) => matchesAlbumTypeSelectors(album, selectors));
  const planned = includeMonitored ? matched : matched.filter((album) => !album.monitored);
  const selection: LidarrAlbumDeletePlanSelectionSummary = {
    artistsScanned: scan.artistsScanned,
    albumsScanned: scan.albums.length,
    matched: matched.length,
    excludedMonitored: matched.length - planned.length,
    planned: planned.length,
    withFiles: planned.filter((album) => (album.statistics?.trackFileCount ?? 0) > 0).length,
    totalSizeOnDisk: planned.reduce((sum, album) => sum + (album.statistics?.sizeOnDisk ?? 0), 0),
    bySelector: countBySelector(matched, selectors),
  };
  if (planned.length === 0) {
    if (options.dryRun === true) {
      return { status: "no-change", selection, execution: scan.execution };
    }
    throw new LidarrPlanValidationError(
      "no album deletions to plan; inspect the selection with --dry-run",
    );
  }
  if (planned.length > LIDARR_PLAN_MAX_ENTRIES) {
    throw new LidarrPlanValidationError(
      `planned ${planned.length} deletion(s) exceed the ${LIDARR_PLAN_MAX_ENTRIES}-entry plan cap; ` +
        "split the work with --artist-ids across successive plans",
    );
  }
  const maxBatch = options.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH;
  if (planned.length > maxBatch) {
    const narrowHint =
      selected.mode === "album-ids" ? "pass fewer --album-ids" : "narrow --types/--artist-ids";
    throw new LidarrPlanValidationError(
      `planned ${planned.length} deletion(s) exceed --max-batch ${maxBatch}; ` +
        `re-run with --max-batch ${planned.length} or ${narrowHint}`,
    );
  }
  // Validator invariant: an explicit selection lists exactly the PLANNED
  // albums (guard-excluded IDs stay visible via `excludedMonitored`).
  const sealedSelection: LidarrAlbumPlanSelectionV2 =
    selected.mode === "album-ids"
      ? { kind: "album-ids", albumIds: sortIds(planned.map((album) => album.id)) }
      : {
          kind: "album-filters",
          artistIds: sortIds(selected.artistIds),
          selectors,
          includeMonitored,
        };
  const builtPlan = buildLidarrAlbumMutationPlanV3({
    origin,
    selection: sealedSelection,
    operation: {
      kind: "album-delete",
      deleteFiles,
      addImportListExclusion,
      includeMonitored,
      selectors,
    },
    maxBatch,
    entries: planned.map(
      (album): LidarrAlbumPlanEntrySource => ({
        kind: "album-delete",
        albumId: album.id,
        albumTitle: album.title,
        artistId: album.artistId,
        artistName: requireArtistName(scan.artistNames, album),
        ...(album.albumType === undefined ? {} : { albumType: album.albumType }),
        ...(album.foreignAlbumId === undefined ? {} : { foreignAlbumId: album.foreignAlbumId }),
        monitored: album.monitored,
        trackFileCount: album.statistics?.trackFileCount ?? 0,
        sizeOnDisk: album.statistics?.sizeOnDisk ?? 0,
      }),
    ),
    cascadePolicy,
  });
  if (!isAlbumDeletePlanV3(builtPlan)) {
    throw new LidarrPlanValidationError("album-delete builder returned an inconsistent operation");
  }
  const plan = builtPlan;
  if (options.dryRun === true) {
    return { status: "previewed", plan, selection, execution: scan.execution };
  }
  const planPath = resolve(options.output ?? defaultOutputPath(plan.id, plan.createdAt));
  await writeLidarrPlanArtifact(planPath, plan);
  return { status: "planned", plan, planPath, selection, execution: scan.execution };
}
