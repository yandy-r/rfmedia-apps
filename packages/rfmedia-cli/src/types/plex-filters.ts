/**
 * Deprecated Plex filter names retained for source and configuration
 * compatibility. New implementation code should import the provider-neutral
 * vocabulary from `media-filters.ts`.
 */

/** @deprecated Use {@link MediaFilterField}. */
export type { MediaFilterField as PlexFilterField } from "./media-filters.js";
/** @deprecated Use {@link MediaFilterOperator}. */
export type { MediaFilterOperator as PlexFilterOperator } from "./media-filters.js";
/** @deprecated Use {@link MediaFilterMatch}. */
export type { MediaFilterMatch as PlexFilterMatch } from "./media-filters.js";
/** @deprecated Use {@link MediaFilterRule}. */
export type { MediaFilterRule as PlexFilterRule } from "./media-filters.js";
/** @deprecated Use {@link MediaFilterGroup}. */
export type { MediaFilterGroup as PlexFilterGroup } from "./media-filters.js";
/** @deprecated Use {@link MediaFilterNode}. */
export type { MediaFilterNode as PlexSmartFilterRule } from "./media-filters.js";
/** @deprecated Use {@link MediaFilter}. */
export type { MediaFilter as PlexSmartFilter } from "./media-filters.js";
/**
 * Named filters remain configured under `plexFilters`; this alias preserves
 * that public configuration surface.
 *
 * @deprecated Use {@link MediaFiltersConfigOptions} internally.
 */
export type { MediaFiltersConfigOptions as PlexFiltersConfigOptions } from "./media-filters.js";

/** @deprecated Use {@link isMediaFilterRule}. */
export { isMediaFilterRule as isPlexFilterRule } from "./media-filters.js";
/** @deprecated Use {@link isMediaFilterGroup}. */
export { isMediaFilterGroup as isPlexFilterGroup } from "./media-filters.js";
