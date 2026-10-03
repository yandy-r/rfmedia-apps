/**
 * Read-only Lidarr manual-import validation.
 *
 * Lidarr remains the matching authority. This action only normalizes its probe
 * response into deterministic findings; it never submits an import.
 */

import { resolveLidarrScheduler, resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { logDebug, logInfo } from "../../lib/logger.js";
import type { LidarrManualImportCandidate } from "../../types/lidarr.js";
import {
  highestLidarrImportValidationStatus,
  type LidarrImportValidationFinding,
  type LidarrImportValidationReport,
  type LidarrImportValidationStatus,
  type LidarrImportValidationSummary,
} from "../../types/lidarr-import-validation.js";

/** Reliability tier for a local Lidarr matching probe. */
export const TIER: LidarrTier = "local-only";

export interface LidarrValidateImportActionOptions {
  readonly folder: string;
  readonly artistId?: number;
  readonly filterExistingFiles?: boolean;
  readonly replaceExistingFiles?: boolean;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

export interface LidarrValidateImportActionResult {
  readonly execution: LidarrExecutionSuccessMetadata;
  readonly report: LidarrImportValidationReport;
}

function normalizedMusicBrainzId(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function identitiesConflict(source: string | undefined, selected: string | undefined): boolean {
  return (
    source !== undefined &&
    selected !== undefined &&
    normalizedMusicBrainzId(source) !== normalizedMusicBrainzId(selected)
  );
}

function classifyCandidate(candidate: LidarrManualImportCandidate): {
  readonly status: LidarrImportValidationStatus;
  readonly reason: string;
} {
  if (candidate.rejections.length > 0) {
    return {
      status: "rejected",
      reason: candidate.rejections.map((rejection) => rejection.reason).join("; "),
    };
  }

  const selectedTrack = candidate.tracks.length === 1 ? candidate.tracks[0] : undefined;
  const audioTags = candidate.audioTags;
  const conflictingMusicBrainzIds =
    identitiesConflict(audioTags?.artistMbId, candidate.artist?.foreignArtistId) ||
    identitiesConflict(audioTags?.albumMbId, candidate.album?.foreignAlbumId) ||
    identitiesConflict(audioTags?.releaseMbId, candidate.albumReleaseForeignId) ||
    identitiesConflict(audioTags?.recordingMbId, selectedTrack?.foreignRecordingId) ||
    identitiesConflict(audioTags?.trackMbId, selectedTrack?.foreignTrackId);
  if (conflictingMusicBrainzIds) {
    return {
      status: "ambiguous",
      reason: "Parsed MusicBrainz identifiers conflict with Lidarr's selected identities",
    };
  }

  const artistId = candidate.artist?.id;
  const album = candidate.album;
  const albumId = album?.id;
  if (
    artistId === undefined ||
    album === undefined ||
    albumId === undefined ||
    candidate.albumReleaseId === undefined ||
    candidate.tracks.length === 0 ||
    candidate.tracks.some((track) => track.id === undefined)
  ) {
    return {
      status: "unmatched",
      reason: "Lidarr did not return one complete artist, album, release, and track mapping",
    };
  }

  const conflictingParents =
    (album.artistId !== undefined && album.artistId !== artistId) ||
    candidate.tracks.some(
      (track) =>
        (track.artistId !== undefined && track.artistId !== artistId) ||
        (track.albumId !== undefined && track.albumId !== albumId),
    );
  if (candidate.tracks.length !== 1 || conflictingParents) {
    return {
      status: "ambiguous",
      reason: conflictingParents
        ? "Lidarr returned conflicting parent identities"
        : "Lidarr returned multiple possible track mappings",
    };
  }

  return { status: "ready", reason: "Lidarr returned one complete matching candidate" };
}

/** Converts one projected Lidarr candidate into a stable report finding. */
export function buildLidarrImportValidationFinding(
  candidate: LidarrManualImportCandidate,
): LidarrImportValidationFinding {
  const verdict = classifyCandidate(candidate);
  return Object.freeze({
    path: candidate.path,
    ...(candidate.name === undefined ? {} : { name: candidate.name }),
    ...(candidate.size === undefined ? {} : { size: candidate.size }),
    ...verdict,
    ...(candidate.artist === undefined ? {} : { artist: candidate.artist }),
    ...(candidate.album === undefined ? {} : { album: candidate.album }),
    ...(candidate.albumReleaseId === undefined ? {} : { albumReleaseId: candidate.albumReleaseId }),
    ...(candidate.albumReleaseForeignId === undefined
      ? {}
      : { albumReleaseForeignId: candidate.albumReleaseForeignId }),
    tracks: candidate.tracks,
    ...(candidate.audioTags === undefined ? {} : { audioTags: candidate.audioTags }),
    rejections: candidate.rejections,
  });
}

function summarize(
  findings: readonly LidarrImportValidationFinding[],
): LidarrImportValidationSummary {
  const count = (status: LidarrImportValidationStatus): number =>
    findings.filter((finding) => finding.status === status).length;
  return Object.freeze({
    total: findings.length,
    ready: count("ready"),
    unmatched: count("unmatched"),
    ambiguous: count("ambiguous"),
    rejected: count("rejected"),
    highestStatus: highestLidarrImportValidationStatus(findings),
  });
}

/** Runs exactly one read-only Lidarr manual-import probe. */
export async function executeLidarrValidateImport(
  options: LidarrValidateImportActionOptions,
): Promise<LidarrValidateImportActionResult> {
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-validate-import",
    operation: "lidarr validate import",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(
        {
          lidarrUrl: options.lidarrUrl,
          lidarrApiKey: options.lidarrApiKey,
        },
        { tier: TIER },
      );
      logDebug(`lidarr validate import: probing ${options.folder}`);
      const candidates = await client.probeManualImport({
        folder: options.folder,
        ...(options.artistId === undefined ? {} : { artistId: options.artistId }),
        filterExistingFiles: options.filterExistingFiles ?? false,
        replaceExistingFiles: options.replaceExistingFiles ?? false,
      });
      const findings = Object.freeze(
        candidates
          .map(buildLidarrImportValidationFinding)
          .sort((left, right) => left.path.localeCompare(right.path)),
      );
      const report = Object.freeze({
        checkedAt: new Date().toISOString(),
        folder: options.folder,
        ...(options.artistId === undefined ? {} : { artistId: options.artistId }),
        filterExistingFiles: options.filterExistingFiles ?? false,
        replaceExistingFiles: options.replaceExistingFiles ?? false,
        findings,
        summary: summarize(findings),
      });
      logInfo(`Lidarr import validation: ${report.summary.ready}/${report.summary.total} ready`);
      return { report };
    },
  });
  return Object.freeze({ ...scheduled.value, execution: scheduled.execution });
}
