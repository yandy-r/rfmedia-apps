/**
 * Creates a sealed or previewed Lidarr album release-policy (anyReleaseOk)
 * plan without mutating Lidarr.
 *
 * Mirrors the album-monitoring producer's selection triad and caps. Entries
 * are changes-only, and the producer FAILS CLOSED when Lidarr omits
 * `anyReleaseOk` for a matched album — a before-state is never guessed.
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
  taskIdPrefix: "lidarr-plan-album-edit",
  operationLabel: "lidarr plan album edit",
};

export interface LidarrAlbumEditPlanActionOptions {
  /** Desired anyReleaseOk state for every matched album. */
  readonly desiredAnyReleaseOk: boolean;
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
export interface LidarrAlbumEditPlanSelectionSummary {
  readonly artistsScanned: number;
  readonly albumsScanned: number;
  readonly matched: number;
  readonly alreadyInDesiredState: number;
  readonly planned: number;
  readonly bySelector: Readonly<Record<string, number>>;
}

type LidarrAlbumEditPlanV3 = Extract<
  LidarrAlbumMutationPlanV3,
  { readonly operation: { readonly kind: "album-edit" } }
>;

function isAlbumEditPlanV3(plan: LidarrAlbumMutationPlanV3): plan is LidarrAlbumEditPlanV3 {
  return plan.operation.kind === "album-edit";
}

export type LidarrAlbumEditPlanGenerationResult =
  | {
      readonly status: "planned";
      readonly plan: LidarrAlbumEditPlanV3;
      readonly planPath: string;
      readonly selection: LidarrAlbumEditPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "previewed";
      readonly plan: LidarrAlbumEditPlanV3;
      readonly selection: LidarrAlbumEditPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "no-change";
      readonly selection: LidarrAlbumEditPlanSelectionSummary;
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
  options: LidarrAlbumEditPlanActionOptions,
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

/** Narrows to albums whose release policy Lidarr actually reported. */
function hasReleasePolicy(
  album: LidarrAlbum,
): album is LidarrAlbum & { readonly anyReleaseOk: boolean } {
  return album.anyReleaseOk !== undefined;
}

/** Ascending id order required by the sealed-selection validator. */
function sortIds(ids: readonly number[]): readonly number[] {
  return [...ids].sort((left, right) => left - right);
}

/**
 * Builds an album release-policy plan (dry-run preview or sealed artifact).
 *
 * Never a silently partial plan: missing explicit IDs, unknown artist scopes,
 * any failed or skipped batch task, and a matched album with no reported
 * `anyReleaseOk` all fail closed before anything is written. Plan entries are
 * changes-only; the selection summary still reports the full accounting.
 */
export async function executeLidarrAlbumEditPlan(
  options: LidarrAlbumEditPlanActionOptions,
): Promise<LidarrAlbumEditPlanGenerationResult> {
  const selectors = validateSelection(options);
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
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
  // Fail closed on an unreported release policy — never guess a before-state.
  const missingPolicy = matched.filter((album) => !hasReleasePolicy(album));
  if (missingPolicy.length > 0) {
    throw new LidarrPlanValidationError(
      "Lidarr did not report anyReleaseOk for album IDs: " +
        missingPolicy.map((album) => album.id).join(", "),
    );
  }
  const changed = matched
    .filter(hasReleasePolicy)
    .filter((album) => album.anyReleaseOk !== options.desiredAnyReleaseOk);
  const selection: LidarrAlbumEditPlanSelectionSummary = {
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
      "no album release-policy changes to plan; inspect the selection with --dry-run",
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
  // Validator invariant: an explicit selection lists exactly the PLANNED
  // albums (already-in-desired-state IDs stay visible via the summary).
  const sealedSelection: LidarrAlbumPlanSelectionV2 =
    options.albumIds !== undefined
      ? { kind: "album-ids", albumIds: sortIds(changed.map((album) => album.id)) }
      : {
          kind: "album-filters",
          ...(options.artistIds === undefined ? {} : { artistIds: sortIds(options.artistIds) }),
          selectors,
        };
  const builtPlan = buildLidarrAlbumMutationPlanV3({
    origin,
    selection: sealedSelection,
    operation: {
      kind: "album-edit",
      desiredAnyReleaseOk: options.desiredAnyReleaseOk,
      selectors,
    },
    maxBatch,
    entries: changed.map(
      (album): LidarrAlbumPlanEntrySource => ({
        kind: "album-edit",
        albumId: album.id,
        albumTitle: album.title,
        artistId: album.artistId,
        artistName: requireArtistName(scan.artistNames, album),
        ...(album.albumType === undefined ? {} : { albumType: album.albumType }),
        anyReleaseOk: album.anyReleaseOk,
      }),
    ),
    cascadePolicy,
  });
  if (!isAlbumEditPlanV3(builtPlan)) {
    throw new LidarrPlanValidationError("album-edit builder returned an inconsistent operation");
  }
  const plan = builtPlan;
  if (options.dryRun === true) {
    return { status: "previewed", plan, selection, execution: scan.execution };
  }
  const planPath = resolve(options.output ?? defaultOutputPath(plan.id, plan.createdAt));
  await writeLidarrPlanArtifact(planPath, plan);
  return { status: "planned", plan, planPath, selection, execution: scan.execution };
}
