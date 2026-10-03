/**
 * Type definitions for smart filters with nested boolean logic.
 *
 * Smart filters enable iTunes-style filtering with nested AND/OR groups.
 * Filters are defined in YAML configuration files and evaluated against
 * extended audio metadata (rating, genre, artist, year, BPM, date_added).
 *
 * Uses discriminated unions with `type: 'rule'` vs `type: 'group'` to enable
 * TypeScript exhaustiveness checking.
 */

/**
 * Supported filter fields for leaf conditions.
 * - rating: Normalized rating value (0.0-1.0 internally, displayed as stars)
 * - genre: Array field from music-metadata (uses contains for array.includes())
 * - artist: Array field from music-metadata (uses contains for array.includes())
 * - year: Numeric year extracted from metadata
 * - bpm: Beats per minute from metadata
 * - date_added: ISO date string (accepts human-readable input like "30d")
 */
export type FilterField = "rating" | "genre" | "artist" | "year" | "bpm" | "date_added";

/**
 * Supported comparison operators for filter rules.
 * - >=: Greater than or equal (numeric fields)
 * - <=: Less than or equal (numeric fields)
 * - ==: Exact equality (all fields)
 * - contains: Substring match for strings, array.includes() for array fields
 * - within: Time-based range (e.g., "30d" for date_added field)
 */
export type FilterOperator = ">=" | "<=" | "==" | "contains" | "within";

/**
 * Match strategy for filter groups.
 * - all: AND logic - all rules must match (short-circuits on first false)
 * - any: OR logic - at least one rule must match (short-circuits on first true)
 */
export type FilterMatch = "all" | "any";

/**
 * Supported radio-style energy arcs.
 *
 * Energy is a sequencing preference derived from library-relative BPM bands.
 * It does not represent stored or acoustically analyzed track metadata.
 */
export type SeparationEnergyMode = "alternate" | "rise" | "fall" | "wave";

/**
 * Optional post-filter sequencing policy for local smart playlists.
 *
 * Artist and genre values are minimum counts of intervening tracks. Tempo,
 * era, and energy are best-effort ordering preferences.
 */
export interface SeparationConfig {
  /** Minimum number of intervening tracks before an artist may repeat */
  artist?: number;
  /** Minimum number of intervening tracks before a genre may repeat */
  genre?: number;
  /** Prefer alternating library-relative BPM bands */
  tempo?: "alternate";
  /** Prefer balanced release-decade representation */
  era?: "distribute";
  /** Prefer a BPM-derived low/medium/high energy arc */
  energy?: SeparationEnergyMode;
}

/**
 * Leaf condition for filtering based on a specific field.
 *
 * Uses discriminated union with `type: 'rule'` for exhaustive type checking.
 *
 * @example
 * // Rating filter - matches tracks rated 4+ stars
 * const ratingRule: FilterRule = {
 *   type: 'rule',
 *   field: 'rating',
 *   operator: '>=',
 *   value: 4.0
 * };
 *
 * @example
 * // Genre filter - matches tracks containing "Rock" in genre
 * const genreRule: FilterRule = {
 *   type: 'rule',
 *   field: 'genre',
 *   operator: 'contains',
 *   value: 'Rock'
 * };
 */
export interface FilterRule {
  /** Discriminator for leaf conditions */
  type: "rule";
  /** Field to compare against */
  field: FilterField;
  /** Comparison operator */
  operator: FilterOperator;
  /** Value to compare - string for text/date fields, number for numeric fields */
  value: string | number;
}

/**
 * Nested boolean logic container for grouping rules.
 *
 * Uses discriminated union with `type: 'group'` for exhaustive type checking.
 * Groups can contain both leaf rules and nested groups, enabling arbitrary
 * boolean expression trees.
 *
 * @example
 * // OR group - matches Rock OR Alternative genres
 * const genreGroup: FilterGroup = {
 *   type: 'group',
 *   match: 'any',
 *   rules: [
 *     { type: 'rule', field: 'genre', operator: 'contains', value: 'Rock' },
 *     { type: 'rule', field: 'genre', operator: 'contains', value: 'Alternative' }
 *   ]
 * };
 */
export interface FilterGroup {
  /** Discriminator for group containers */
  type: "group";
  /** Boolean logic: 'all' for AND, 'any' for OR */
  match: FilterMatch;
  /** Array of rules or nested groups */
  rules: SmartFilterRule[];
}

/**
 * Discriminated union of filter rules and groups.
 *
 * This recursive type enables nested boolean logic of arbitrary depth.
 * Use the `type` field to discriminate between rules and groups.
 *
 * @example
 * function evaluateRule(rule: SmartFilterRule, metadata: TrackMetadata): boolean {
 *   switch (rule.type) {
 *     case 'rule':
 *       return evaluateLeafRule(rule, metadata);
 *     case 'group':
 *       return evaluateGroup(rule, metadata);
 *   }
 * }
 */
export type SmartFilterRule = FilterRule | FilterGroup;

/**
 * Top-level smart filter definition.
 *
 * Wraps the root-level boolean logic with match strategy and rules array.
 * This is the structure stored in filters.yml for named filter definitions.
 *
 * @example
 * // Complete filter: High-rated Rock or Alternative tracks
 * const filter: SmartFilter = {
 *   match: 'all',
 *   rules: [
 *     { type: 'rule', field: 'rating', operator: '>=', value: 4.0 },
 *     {
 *       type: 'group',
 *       match: 'any',
 *       rules: [
 *         { type: 'rule', field: 'genre', operator: 'contains', value: 'Rock' },
 *         { type: 'rule', field: 'genre', operator: 'contains', value: 'Alternative' }
 *       ]
 *     }
 *   ]
 * };
 */
export interface SmartFilter {
  /** Root-level boolean logic: 'all' for AND, 'any' for OR */
  match: FilterMatch;
  /** Array of rules or groups at the top level */
  rules: SmartFilterRule[];
  /** Optional post-filter ordering policy for local playlists */
  separation?: SeparationConfig;
}

/**
 * Named filter definitions from filters.yml configuration.
 *
 * Maps filter names to their SmartFilter definitions.
 * Used in ConfigFile.filters section.
 *
 * @example
 * // filters.yml content:
 * // filters:
 * //   high-quality-rock: { match: all, rules: [...] }
 * //   recent-favorites: { match: all, rules: [...] }
 *
 * const config: FiltersConfigOptions = {
 *   'high-quality-rock': { match: 'all', rules: [...] },
 *   'recent-favorites': { match: 'all', rules: [...] }
 * };
 */
export type FiltersConfigOptions = Record<string, SmartFilter>;

/**
 * Type guard to check if a SmartFilterRule is a FilterRule.
 */
export function isFilterRule(rule: SmartFilterRule): rule is FilterRule {
  return rule.type === "rule";
}

/**
 * Type guard to check if a SmartFilterRule is a FilterGroup.
 */
export function isFilterGroup(rule: SmartFilterRule): rule is FilterGroup {
  return rule.type === "group";
}
