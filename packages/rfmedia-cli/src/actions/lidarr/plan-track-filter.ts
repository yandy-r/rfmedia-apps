/** Builds one fail-closed, exact-album trackfile-filter plan. */

import { resolve } from "node:path";

import { LidarrPlanValidationError } from "../../lib/errors.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import { resolveLidarrCascadePolicy } from "../../lib/lidarr/cascade-analysis.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import { writeLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import { buildLidarrTrackFilterPlanV3 } from "../../lib/lidarr/plan-track-filter-operations.js";
import { readRating } from "../../lib/ratings.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { LidarrTrack, LidarrTrackFile } from "../../types/lidarr.js";
import {
  type LidarrTrackFileDeleteCandidateV2,
  type LidarrTrackFileFilterPlanV3,
  type LidarrTrackFilterWarningV2,
} from "../../types/lidarr-plan.js";
import { defaultOutputPath } from "./plan.js";

export const TIER: LidarrTier = "local-only";
export const LIDARR_TRACK_FILTER_DEFAULT_MAX_BATCH = 100;

export interface LidarrTrackFilterPlanActionOptions {
  readonly albumId: number;
  readonly keepTrackIds?: readonly number[];
  readonly minStars?: number;
  readonly maxBatch?: number;
  readonly dryRun?: boolean;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

export interface LidarrTrackFilterPlanSelectionSummary {
  readonly tracks: number;
  readonly trackFiles: number;
  readonly kept: number;
  readonly deleteCandidates: number;
  readonly warnings: readonly LidarrTrackFilterWarningV2[];
  readonly totalDeleteBytes: number;
}

export type LidarrTrackFilterPlanGenerationResult =
  | {
      readonly status: "planned";
      readonly plan: LidarrTrackFileFilterPlanV3;
      readonly planPath: string;
      readonly selection: LidarrTrackFilterPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "previewed";
      readonly plan: LidarrTrackFileFilterPlanV3;
      readonly selection: LidarrTrackFilterPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    }
  | {
      readonly status: "no-change";
      readonly selection: LidarrTrackFilterPlanSelectionSummary;
      readonly execution: LidarrExecutionSuccessMetadata;
    };

function validateOptions(options: LidarrTrackFilterPlanActionOptions): {
  readonly keepTrackIds: readonly number[];
  readonly minStars?: number;
  readonly maxBatch: number;
} {
  if (!Number.isSafeInteger(options.albumId) || options.albumId <= 0) {
    throw new LidarrPlanValidationError("album ID must be a positive safe integer");
  }
  const rawIds = options.keepTrackIds ?? [];
  if (
    rawIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(rawIds).size !== rawIds.length
  ) {
    throw new LidarrPlanValidationError("keep track IDs must be unique positive integers");
  }
  const keepTrackIds = [...rawIds].sort((left, right) => left - right);
  if (
    options.minStars !== undefined &&
    (!Number.isFinite(options.minStars) ||
      options.minStars < 0.5 ||
      options.minStars > 5 ||
      !Number.isInteger(options.minStars * 2))
  ) {
    throw new LidarrPlanValidationError("--min-stars must be a half-star from 0.5 to 5");
  }
  if (keepTrackIds.length === 0 && options.minStars === undefined) {
    throw new LidarrPlanValidationError("pass --keep-track-ids and/or --min-stars");
  }
  const maxBatch = options.maxBatch ?? LIDARR_TRACK_FILTER_DEFAULT_MAX_BATCH;
  if (!Number.isSafeInteger(maxBatch) || maxBatch <= 0 || maxBatch > 1_000) {
    throw new LidarrPlanValidationError("--max-batch must be a positive integer at most 1000");
  }
  return {
    keepTrackIds,
    ...(options.minStars === undefined ? {} : { minStars: options.minStars }),
    maxBatch,
  };
}

function trackOrder(left: LidarrTrack, right: LidarrTrack): number {
  return (
    (left.mediumNumber ?? 0) - (right.mediumNumber ?? 0) ||
    (left.absoluteTrackNumber ?? left.id) - (right.absoluteTrackNumber ?? right.id) ||
    left.id - right.id
  );
}

function warning(
  code: LidarrTrackFilterWarningV2["code"],
  message: string,
  track?: LidarrTrack,
  trackFile?: LidarrTrackFile,
): LidarrTrackFilterWarningV2 {
  return Object.freeze({
    code,
    ...(track === undefined ? {} : { trackId: track.id }),
    ...(trackFile === undefined ? {} : { trackFileId: trackFile.id, path: trackFile.path }),
    message,
  });
}

async function calculateSelection(
  albumId: number,
  artistId: number,
  tracks: readonly LidarrTrack[],
  trackFiles: readonly LidarrTrackFile[],
  keepTrackIds: readonly number[],
  threshold: number | undefined,
): Promise<{
  readonly keptTrackIds: readonly number[];
  readonly candidates: readonly LidarrTrackFileDeleteCandidateV2[];
  readonly warnings: readonly LidarrTrackFilterWarningV2[];
}> {
  const knownTrackIds = new Set(tracks.map((track) => track.id));
  const unknownKeepIds = keepTrackIds.filter((id) => !knownTrackIds.has(id));
  if (unknownKeepIds.length > 0) {
    throw new LidarrPlanValidationError(
      `keep track IDs are not in album ${albumId}: ${unknownKeepIds.join(", ")}`,
    );
  }
  const explicit = new Set(keepTrackIds);
  const byId = new Map(trackFiles.map((trackFile) => [trackFile.id, trackFile]));
  const referenceCounts = new Map<number, number>();
  for (const track of tracks) {
    if (track.trackFileId !== undefined) {
      referenceCounts.set(track.trackFileId, (referenceCounts.get(track.trackFileId) ?? 0) + 1);
    }
  }
  const kept = new Set<number>();
  const candidates: LidarrTrackFileDeleteCandidateV2[] = [];
  const warnings: LidarrTrackFilterWarningV2[] = [];
  for (const track of [...tracks].sort(trackOrder)) {
    if (track.albumId !== albumId || track.artistId !== artistId) {
      kept.add(track.id);
      warnings.push(
        warning("cross-album-file", "Track belongs to a different parent; retained", track),
      );
      continue;
    }
    if (!track.hasFile || track.trackFileId === undefined) {
      kept.add(track.id);
      warnings.push(warning("missing-file", "Track has no managed file; retained", track));
      continue;
    }
    const trackFile = byId.get(track.trackFileId);
    if (trackFile === undefined) {
      kept.add(track.id);
      warnings.push(
        warning("unmapped-file", "Trackfile identity was not returned; retained", track),
      );
      continue;
    }
    if (trackFile.albumId !== albumId || trackFile.artistId !== artistId) {
      kept.add(track.id);
      warnings.push(
        warning(
          "cross-album-file",
          "Trackfile belongs to a different parent; retained",
          track,
          trackFile,
        ),
      );
      continue;
    }
    if ((referenceCounts.get(trackFile.id) ?? 0) !== 1) {
      kept.add(track.id);
      warnings.push(
        warning(
          "ambiguous-file",
          "Several tracks reference this trackfile; retained",
          track,
          trackFile,
        ),
      );
      continue;
    }
    if (explicit.has(track.id)) {
      kept.add(track.id);
      continue;
    }
    let rating: number | undefined;
    if (threshold !== undefined) {
      const parsed = await readRating(trackFile.path);
      rating = parsed?.value;
      if (rating === undefined) {
        kept.add(track.id);
        warnings.push(
          warning(
            "unrated-or-unreadable",
            "Embedded rating is missing or unreadable; retained",
            track,
            trackFile,
          ),
        );
        continue;
      }
      if (rating >= threshold / 5) {
        kept.add(track.id);
        continue;
      }
    }
    candidates.push(
      Object.freeze({
        trackId: track.id,
        trackTitle: track.title,
        trackFileId: trackFile.id,
        path: trackFile.path,
        size: trackFile.size,
        ...(track.mediumNumber === undefined ? {} : { mediumNumber: track.mediumNumber }),
        ...(track.absoluteTrackNumber === undefined
          ? {}
          : { absoluteTrackNumber: track.absoluteTrackNumber }),
        ...(rating === undefined ? {} : { rating }),
      }),
    );
  }
  for (const trackFile of trackFiles) {
    if (!referenceCounts.has(trackFile.id)) {
      warnings.push(
        trackFile.albumId !== albumId || trackFile.artistId !== artistId
          ? warning(
              "cross-album-file",
              "Trackfile belongs to a different parent; retained",
              undefined,
              trackFile,
            )
          : warning(
              "unmapped-file",
              "Trackfile is not mapped to an album track; retained",
              undefined,
              trackFile,
            ),
      );
    }
  }
  if (kept.size === 0) {
    throw new LidarrPlanValidationError("retention criteria would keep no tracks");
  }
  return {
    keptTrackIds: Object.freeze([...kept].sort((left, right) => left - right)),
    candidates: Object.freeze(candidates),
    warnings: Object.freeze(warnings),
  };
}

/** Plans an exact trackfile filter; no mutation occurs in this action. */
export async function executeLidarrTrackFilterPlan(
  options: LidarrTrackFilterPlanActionOptions,
): Promise<LidarrTrackFilterPlanGenerationResult> {
  const validated = validateOptions(options);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: `lidarr-plan-track-filter-${options.albumId}`,
    operation: "lidarr plan track filter",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(overrides, {
        tier: TIER,
        retryAttemptsOverride: 0,
      });
      const albums = await client.listAlbums({ albumIds: [options.albumId] });
      if (albums.length !== 1 || albums[0]?.id !== options.albumId) {
        throw new LidarrPlanValidationError(`Lidarr album ${options.albumId} was not found`);
      }
      const album = albums[0];
      const artist = await client.getArtist(album.artistId);
      const tracks = await client.listTracks({ albumId: album.id });
      const trackFiles = await client.listTrackFiles({ albumIds: [album.id] });
      const selection = await calculateSelection(
        album.id,
        album.artistId,
        tracks,
        trackFiles,
        validated.keepTrackIds,
        validated.minStars,
      );
      return { album, artist, tracks, trackFiles, selection };
    },
  });
  const { album, artist, tracks, trackFiles, selection: selected } = scheduled.value;
  const selection: LidarrTrackFilterPlanSelectionSummary = Object.freeze({
    tracks: tracks.length,
    trackFiles: trackFiles.length,
    kept: selected.keptTrackIds.length,
    deleteCandidates: selected.candidates.length,
    warnings: selected.warnings,
    totalDeleteBytes: selected.candidates.reduce((sum, candidate) => sum + candidate.size, 0),
  });
  if (selected.candidates.length === 0) {
    return Object.freeze({ status: "no-change", selection, execution: scheduled.execution });
  }
  if (selected.candidates.length > validated.maxBatch) {
    throw new LidarrPlanValidationError(
      `planned ${selected.candidates.length} trackfile deletion(s) exceed --max-batch ` +
        `${validated.maxBatch}`,
    );
  }
  const plan = buildLidarrTrackFilterPlanV3({
    origin,
    albumId: album.id,
    albumMonitored: album.monitored,
    operation: {
      kind: "track-file-filter",
      explicitKeepTrackIds: validated.keepTrackIds,
      ...(validated.minStars === undefined ? {} : { minStars: validated.minStars }),
    },
    maxBatch: validated.maxBatch,
    entry: {
      id: `album:${album.id}:track-file-filter`,
      albumId: album.id,
      albumTitle: album.title,
      artistId: album.artistId,
      artistName: artist.artistName,
      before: { deleteCandidates: selected.candidates },
      after: {
        deletedTrackFileIds: [...selected.candidates]
          .map((candidate) => candidate.trackFileId)
          .sort((left, right) => left - right),
      },
      keptTrackIds: selected.keptTrackIds,
      warnings: selected.warnings,
    },
    cascadePolicy,
  });
  if (options.dryRun === true) {
    return Object.freeze({
      status: "previewed",
      plan,
      selection,
      execution: scheduled.execution,
    });
  }
  const planPath = resolve(options.output ?? defaultOutputPath(plan.id, plan.createdAt));
  await writeLidarrPlanArtifact(planPath, plan);
  return Object.freeze({
    status: "planned",
    plan,
    planPath,
    selection,
    execution: scheduled.execution,
  });
}
