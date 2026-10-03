/**
 * Provider-neutral media filter definitions with nested boolean logic.
 *
 * The field and operator vocabulary intentionally preserves the existing
 * configuration DSL. Provider adapters may translate supported rules for
 * server-side pushdown; residual evaluation uses these same domain types.
 */

import type { MediaKind } from "./media-server.js";

/** Maximum supported nesting depth for filter groups. */
export const MEDIA_FILTER_MAX_DEPTH = 20;

/** Media-domain fields available to named server filters. */
export type MediaFilterField =
  | "album"
  | "albumRating"
  | "artist"
  | "artistRating"
  | "genre"
  | "maxYear"
  | "minPlays"
  | "minYear"
  | "mood"
  | "style"
  | "title"
  | "trackRating"
  | "year";

/** Comparisons supported by media filter rules. */
export type MediaFilterOperator = ">=" | "<=" | "==" | "!=" | "contains" | "not_contains";

/** Boolean match strategy for a filter or group. */
export type MediaFilterMatch = "all" | "any";

/** A leaf condition in a media filter expression. */
export interface MediaFilterRule {
  type: "rule";
  field: MediaFilterField;
  operator: MediaFilterOperator;
  /**
   * Comparison value. Rating values use the public 1-5 star input scale;
   * evaluators normalize them before comparing generic entity ratings.
   */
  value: string | number;
}

/** A nested boolean group in a media filter expression. */
export interface MediaFilterGroup {
  type: "group";
  match: MediaFilterMatch;
  rules: MediaFilterNode[];
}

/** Recursive media filter expression node. */
export type MediaFilterNode = MediaFilterRule | MediaFilterGroup;

/** A complete named media filter with optional query defaults. */
export interface MediaFilter {
  match: MediaFilterMatch;
  rules: MediaFilterNode[];
  library?: string;
  type?: MediaKind;
  limit?: number;
}

/** Named media filter definitions. */
export type MediaFiltersConfigOptions = Record<string, MediaFilter>;

/**
 * Check whether an expression node is a leaf rule.
 *
 * @param node - Filter expression node to inspect.
 * @returns True when the node is a leaf rule.
 */
export function isMediaFilterRule(node: MediaFilterNode): node is MediaFilterRule {
  return node.type === "rule";
}

/**
 * Check whether an expression node is a nested group.
 *
 * @param node - Filter expression node to inspect.
 * @returns True when the node is a group.
 */
export function isMediaFilterGroup(node: MediaFilterNode): node is MediaFilterGroup {
  return node.type === "group";
}
