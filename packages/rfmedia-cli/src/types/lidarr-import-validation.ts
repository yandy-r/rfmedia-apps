import type {
  LidarrManualImportAlbum,
  LidarrManualImportArtist,
  LidarrManualImportAudioTags,
  LidarrManualImportRejection,
  LidarrManualImportTrack,
} from "./lidarr.js";

/** Deterministic validation verdicts, ordered from safe to most severe. */
export type LidarrImportValidationStatus = "ready" | "unmatched" | "ambiguous" | "rejected";

/** Optional CI failure threshold. */
export type LidarrImportValidationFailOn = LidarrImportValidationStatus;

/** One normalized manual-import file finding. */
export interface LidarrImportValidationFinding {
  readonly path: string;
  readonly name?: string;
  readonly size?: number;
  readonly status: LidarrImportValidationStatus;
  readonly reason: string;
  readonly artist?: LidarrManualImportArtist;
  readonly album?: LidarrManualImportAlbum;
  readonly albumReleaseId?: number;
  readonly albumReleaseForeignId?: string;
  readonly tracks: readonly LidarrManualImportTrack[];
  readonly audioTags?: LidarrManualImportAudioTags;
  readonly rejections: readonly LidarrManualImportRejection[];
}

/** Aggregate counts for one validation probe. */
export interface LidarrImportValidationSummary {
  readonly total: number;
  readonly ready: number;
  readonly unmatched: number;
  readonly ambiguous: number;
  readonly rejected: number;
  readonly highestStatus: LidarrImportValidationStatus;
}

/** Stable command-facing report. */
export interface LidarrImportValidationReport {
  readonly checkedAt: string;
  readonly folder: string;
  readonly artistId?: number;
  readonly filterExistingFiles: boolean;
  readonly replaceExistingFiles: boolean;
  readonly findings: readonly LidarrImportValidationFinding[];
  readonly summary: LidarrImportValidationSummary;
}

const STATUS_RANK: Readonly<Record<LidarrImportValidationStatus, number>> = Object.freeze({
  ready: 0,
  unmatched: 1,
  ambiguous: 2,
  rejected: 3,
});

/** Returns whether a report reaches an explicitly requested failure threshold. */
export function shouldFailLidarrImportValidation(
  report: LidarrImportValidationReport,
  failOn: LidarrImportValidationFailOn | undefined,
): boolean {
  return failOn !== undefined && STATUS_RANK[report.summary.highestStatus] >= STATUS_RANK[failOn];
}

/** Chooses the highest-severity status from a non-empty or empty finding list. */
export function highestLidarrImportValidationStatus(
  findings: readonly LidarrImportValidationFinding[],
): LidarrImportValidationStatus {
  return findings.reduce<LidarrImportValidationStatus>(
    (highest, finding) =>
      STATUS_RANK[finding.status] > STATUS_RANK[highest] ? finding.status : highest,
    "ready",
  );
}
