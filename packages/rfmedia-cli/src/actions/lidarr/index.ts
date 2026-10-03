/**
 * Barrel for the Lidarr baseline actions.
 *
 * Re-exports the four `execute*` entrypoints, their option/result types, and
 * each module's reliability `TIER` (aliased to avoid name collisions). The
 * command layer imports the `execute*` functions and reads the per-action tier.
 */

export { executeLidarrStatus, TIER as LIDARR_STATUS_TIER } from "./status.js";
export type { LidarrStatusActionOptions, LidarrStatusActionResult } from "./status.js";

export { executeLidarrList, TIER as LIDARR_LIST_TIER } from "./list.js";
export type { LidarrListActionOptions, LidarrListActionResult, LidarrListItem } from "./list.js";

export { executeLidarrAlbums, TIER as LIDARR_ALBUMS_TIER } from "./albums.js";
export type {
  LidarrAlbumsActionOptions,
  LidarrAlbumsActionResult,
  LidarrAlbumRow,
} from "./albums.js";

export { executeLidarrWanted, TIER as LIDARR_WANTED_TIER } from "./wanted.js";
export type {
  LidarrWantedActionOptions,
  LidarrWantedActionResult,
  LidarrWantedItem,
} from "./wanted.js";

export { executeLidarrHealth, TIER as LIDARR_HEALTH_TIER } from "./health.js";
export type { LidarrHealthActionOptions, LidarrHealthActionResult } from "./health.js";

export { executeLidarrAudit, TIER as LIDARR_AUDIT_TIER } from "./audit.js";
export type { LidarrAuditActionOptions, LidarrAuditActionResult } from "./audit.js";

export { executeLidarrReconcile, TIER as LIDARR_RECONCILE_TIER } from "./reconcile.js";
export type {
  LidarrReconcileActionOptions,
  LidarrReconcileActionResult,
  LidarrReconcileDependencies,
} from "./reconcile.js";

export {
  executeLidarrValidateImport,
  TIER as LIDARR_VALIDATE_IMPORT_TIER,
} from "./validate-import.js";
export type {
  LidarrValidateImportActionOptions,
  LidarrValidateImportActionResult,
} from "./validate-import.js";

export { executeLidarrSearch, TIER as LIDARR_SEARCH_TIER } from "./search.js";
export type { LidarrSearchActionOptions } from "./search.js";

export {
  executeLidarrDiscover,
  LIDARR_DISCOVER_DEFAULT_LIMIT,
  LIDARR_DISCOVER_MAX_LIMIT,
  TIER as LIDARR_DISCOVER_TIER,
} from "./discover.js";
export type { LidarrDiscoverActionOptions } from "./discover.js";

export { executeLidarrPlan, TIER as LIDARR_PLAN_TIER } from "./plan.js";
export type { LidarrPlanActionOptions } from "./plan.js";

export { executeLidarrAlbumPlan, TIER as LIDARR_ALBUM_PLAN_TIER } from "./plan-albums.js";
export type {
  LidarrAlbumPlanActionOptions,
  LidarrAlbumPlanGenerationResult,
  LidarrAlbumPlanSelectionSummary,
} from "./plan-albums.js";

export {
  executeLidarrArtistProfilePlan,
  TIER as LIDARR_ARTIST_PROFILE_PLAN_TIER,
} from "./plan-artist-profiles.js";
export type { LidarrArtistProfilePlanActionOptions } from "./plan-artist-profiles.js";

export {
  executeLidarrArtistTagPlan,
  TIER as LIDARR_ARTIST_TAG_PLAN_TIER,
} from "./plan-artist-tags.js";
export type { LidarrArtistTagPlanActionOptions } from "./plan-artist-tags.js";

export {
  executeLidarrAlbumEditPlan,
  TIER as LIDARR_ALBUM_EDIT_PLAN_TIER,
} from "./plan-album-edit.js";
export type {
  LidarrAlbumEditPlanActionOptions,
  LidarrAlbumEditPlanGenerationResult,
  LidarrAlbumEditPlanSelectionSummary,
} from "./plan-album-edit.js";

export {
  executeLidarrAlbumDeletePlan,
  TIER as LIDARR_ALBUM_DELETE_PLAN_TIER,
} from "./plan-album-delete.js";
export type {
  LidarrAlbumDeletePlanActionOptions,
  LidarrAlbumDeletePlanGenerationResult,
  LidarrAlbumDeletePlanSelectionSummary,
} from "./plan-album-delete.js";

export {
  executeLidarrTrackFilterPlan,
  LIDARR_TRACK_FILTER_DEFAULT_MAX_BATCH,
  TIER as LIDARR_TRACK_FILTER_PLAN_TIER,
} from "./plan-track-filter.js";
export type {
  LidarrTrackFilterPlanActionOptions,
  LidarrTrackFilterPlanGenerationResult,
  LidarrTrackFilterPlanSelectionSummary,
} from "./plan-track-filter.js";

export {
  executeLidarrArtistDeletePlan,
  TIER as LIDARR_ARTIST_DELETE_PLAN_TIER,
} from "./plan-artist-delete.js";
export type { LidarrArtistDeletePlanActionOptions } from "./plan-artist-delete.js";

export type { LidarrPlanGenerationResultV2 } from "../../types/lidarr-plan.js";

export { executeLidarrApply, TIER as LIDARR_APPLY_TIER } from "./apply.js";
export type { LidarrApplyActionOptions } from "./apply.js";

export {
  executeLidarrPresetDiff,
  executeLidarrPresetList,
  executeLidarrPresetShow,
  TIER as LIDARR_PRESET_TIER,
} from "./profile-presets.js";
export type {
  LidarrPresetDiffActionOptions,
  LidarrPresetReferenceActionOptions,
} from "./profile-presets.js";

export {
  executeLidarrPolicyEvaluate,
  TIER as LIDARR_POLICY_EVALUATE_TIER,
} from "./policy-evaluate.js";
export type {
  LidarrPolicyEvaluateActionOptions,
  LidarrPolicyEvaluateActionResult,
  LidarrPolicyEvaluateDependencies,
} from "./policy-evaluate.js";

export { executeLidarrPolicyPlan, TIER as LIDARR_POLICY_PLAN_TIER } from "./policy-plan.js";
export type {
  LidarrPolicyPlanActionOptions,
  LidarrPolicyPlanActionResult,
  LidarrPolicyPlanDependencies,
} from "./policy-plan.js";

export { executeLidarrSyncRatings, TIER as LIDARR_SYNC_RATINGS_TIER } from "./sync-ratings.js";
export type {
  LidarrSyncRatingsActionOptions,
  LidarrSyncRatingsActionResult,
  LidarrSyncRatingsDependencies,
} from "./sync-ratings.js";
