/**
 * Barrel for the Lidarr baseline actions.
 *
 * Re-exports the four `execute*` entrypoints, their option/result types, and
 * each module's reliability `TIER` (aliased to avoid name collisions). The
 * command layer imports the `execute*` functions and reads the per-action tier.
 */

export { executeLidarrStatus } from "./status.js";
export type { LidarrStatusActionOptions, LidarrStatusActionResult } from "./status.js";

export { executeLidarrList } from "./list.js";
export type { LidarrListActionOptions, LidarrListActionResult, LidarrListItem } from "./list.js";

export { executeLidarrAlbums } from "./albums.js";
export type {
  LidarrAlbumsActionOptions,
  LidarrAlbumsActionResult,
  LidarrAlbumRow,
} from "./albums.js";

export { executeLidarrWanted } from "./wanted.js";
export type {
  LidarrWantedActionOptions,
  LidarrWantedActionResult,
  LidarrWantedItem,
} from "./wanted.js";

export { executeLidarrHealth } from "./health.js";
export type { LidarrHealthActionOptions, LidarrHealthActionResult } from "./health.js";

export { executeLidarrAudit } from "./audit.js";
export type { LidarrAuditActionOptions, LidarrAuditActionResult } from "./audit.js";

export { executeLidarrReconcile } from "./reconcile.js";
export type {
  LidarrReconcileActionOptions,
  LidarrReconcileActionResult,
  LidarrReconcileDependencies,
} from "./reconcile.js";

export { executeLidarrValidateImport } from "./validate-import.js";
export type {
  LidarrValidateImportActionOptions,
  LidarrValidateImportActionResult,
} from "./validate-import.js";

export { executeLidarrSearch } from "./search.js";
export type { LidarrSearchActionOptions } from "./search.js";

export {
  executeLidarrDiscover,
  LIDARR_DISCOVER_DEFAULT_LIMIT,
  LIDARR_DISCOVER_MAX_LIMIT,
} from "./discover.js";
export type { LidarrDiscoverActionOptions } from "./discover.js";

export { executeLidarrPlan } from "./plan.js";
export type { LidarrPlanActionOptions } from "./plan.js";

export { executeLidarrAlbumPlan } from "./plan-albums.js";
export type {
  LidarrAlbumPlanActionOptions,
  LidarrAlbumPlanGenerationResult,
  LidarrAlbumPlanSelectionSummary,
} from "./plan-albums.js";

export { executeLidarrArtistProfilePlan } from "./plan-artist-profiles.js";
export type { LidarrArtistProfilePlanActionOptions } from "./plan-artist-profiles.js";

export { executeLidarrArtistTagPlan } from "./plan-artist-tags.js";
export type { LidarrArtistTagPlanActionOptions } from "./plan-artist-tags.js";

export { executeLidarrAlbumEditPlan } from "./plan-album-edit.js";
export type {
  LidarrAlbumEditPlanActionOptions,
  LidarrAlbumEditPlanGenerationResult,
  LidarrAlbumEditPlanSelectionSummary,
} from "./plan-album-edit.js";

export { executeLidarrAlbumDeletePlan } from "./plan-album-delete.js";
export type {
  LidarrAlbumDeletePlanActionOptions,
  LidarrAlbumDeletePlanGenerationResult,
  LidarrAlbumDeletePlanSelectionSummary,
} from "./plan-album-delete.js";

export {
  executeLidarrTrackFilterPlan,
  LIDARR_TRACK_FILTER_DEFAULT_MAX_BATCH,
} from "./plan-track-filter.js";
export type {
  LidarrTrackFilterPlanActionOptions,
  LidarrTrackFilterPlanGenerationResult,
  LidarrTrackFilterPlanSelectionSummary,
} from "./plan-track-filter.js";

export { executeLidarrArtistDeletePlan } from "./plan-artist-delete.js";
export type { LidarrArtistDeletePlanActionOptions } from "./plan-artist-delete.js";

export type { LidarrPlanGenerationResultV2 } from "../../types/lidarr-plan.js";

export { executeLidarrApply } from "./apply.js";
export type { LidarrApplyActionOptions } from "./apply.js";

export {
  executeLidarrPresetDiff,
  executeLidarrPresetList,
  executeLidarrPresetShow,
} from "./profile-presets.js";
export type {
  LidarrPresetDiffActionOptions,
  LidarrPresetReferenceActionOptions,
} from "./profile-presets.js";

export { executeLidarrPolicyEvaluate } from "./policy-evaluate.js";
export type {
  LidarrPolicyEvaluateActionOptions,
  LidarrPolicyEvaluateActionResult,
  LidarrPolicyEvaluateDependencies,
} from "./policy-evaluate.js";

export { executeLidarrPolicyPlan } from "./policy-plan.js";
export type {
  LidarrPolicyPlanActionOptions,
  LidarrPolicyPlanActionResult,
  LidarrPolicyPlanDependencies,
} from "./policy-plan.js";

export { executeLidarrSyncRatings } from "./sync-ratings.js";
export type {
  LidarrSyncRatingsActionOptions,
  LidarrSyncRatingsActionResult,
  LidarrSyncRatingsDependencies,
} from "./sync-ratings.js";
