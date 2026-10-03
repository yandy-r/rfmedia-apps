/**
 * Provider-neutral media filter evaluation and residual query planning.
 *
 * Provider adapters decide which leaf rules they can push down and encode
 * those rules privately. This module only works with generic filter nodes and
 * normalized media entities.
 */

import {
  MEDIA_FILTER_MAX_DEPTH,
  isMediaFilterGroup,
  isMediaFilterRule,
  type MediaFilter,
  type MediaFilterField,
  type MediaFilterGroup,
  type MediaFilterNode,
  type MediaFilterRule,
} from "../types/media-filters.js";
import type { MediaItem, NormalizedMediaRating } from "../types/media-server.js";

const RATING_FIELDS: ReadonlySet<MediaFilterField> = new Set([
  "artistRating",
  "albumRating",
  "trackRating",
]);

/** A provider predicate for deciding whether one leaf rule can be pushed down. */
export type MediaFilterRuleSupport = (rule: MediaFilterRule) => boolean;

/**
 * Provider-neutral inputs for executing a filter as one or more server queries.
 *
 * `baseRules` are pushdown-compatible top-level conjuncts. Each
 * `queryVariants` entry is a possible branch rule set. Providers remain
 * responsible for deciding how to combine and encode these inputs.
 */
export interface MediaFilterQueryPlan {
  readonly baseRules: readonly MediaFilterRule[];
  readonly queryVariants: readonly (readonly MediaFilterRule[])[];
  readonly requiresResidualEvaluation: boolean;
}

function isRatingField(field: MediaFilterField): boolean {
  return RATING_FIELDS.has(field);
}

function assertNormalizedRating(rating: number): asserts rating is NormalizedMediaRating {
  if (!Number.isFinite(rating) || rating < 0 || rating > 1) {
    throw new RangeError("Normalized media rating must be a finite number between 0 and 1");
  }
}

function normalizeFilterRating(value: number): NormalizedMediaRating {
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    throw new RangeError("Media filter rating must be a finite number between 1 and 5 stars");
  }

  return value / 5;
}

function joined(values: readonly string[] | undefined): string | undefined {
  return values && values.length > 0 ? values.join(", ") : undefined;
}

/**
 * Read a filterable value from a generic media entity.
 *
 * @param item - Generic media entity to inspect.
 * @param field - Media-domain filter field to read.
 * @returns The field value, or undefined when that entity does not expose it.
 * @throws RangeError when an entity carries an invalid normalized rating.
 */
export function getMediaFieldValue(
  item: MediaItem,
  field: MediaFilterField,
): number | string | undefined {
  switch (field) {
    case "artistRating":
    case "albumRating":
    case "trackRating":
      if (item.rating === null) {
        return undefined;
      }
      assertNormalizedRating(item.rating);
      return item.rating;

    case "minPlays":
      return item.kind === "track" ? item.playCount : undefined;

    case "genre":
      return joined(item.genres);

    case "year":
    case "minYear":
    case "maxYear":
      return item.year;

    case "artist":
      switch (item.kind) {
        case "track":
        case "album":
          return item.artist;
        case "artist":
          return item.title;
      }

    case "album":
      switch (item.kind) {
        case "track":
          return item.album;
        case "album":
          return item.title;
        case "artist":
          return undefined;
      }

    case "title":
      return item.title;

    case "style":
      return item.kind === "track" ? undefined : joined(item.styles);

    case "mood":
      return joined(item.moods);

    default: {
      const exhaustiveField: never = field;
      throw new Error(`Unknown media filter field: ${String(exhaustiveField)}`);
    }
  }
}

/**
 * Evaluate one leaf rule against a generic media entity.
 *
 * @param rule - Leaf rule to evaluate.
 * @param item - Generic media entity to inspect.
 * @returns True when the rule matches.
 * @throws RangeError for invalid star or normalized rating values.
 */
export function evaluateMediaFilterRule(rule: MediaFilterRule, item: MediaItem): boolean {
  const fieldValue = getMediaFieldValue(item, rule.field);

  if (fieldValue === undefined) {
    return rule.operator === "!=" || rule.operator === "not_contains";
  }

  if (typeof fieldValue === "string") {
    if (typeof rule.value !== "string") {
      return false;
    }

    const actual = fieldValue.toLowerCase();
    const expected = rule.value.toLowerCase();

    switch (rule.operator) {
      case "contains":
        return actual.includes(expected);
      case "not_contains":
        return !actual.includes(expected);
      case "==":
        return actual === expected;
      case "!=":
        return actual !== expected;
      case ">=":
      case "<=":
        return false;
      default: {
        const exhaustiveOperator: never = rule.operator;
        throw new Error(`Unknown media filter operator: ${String(exhaustiveOperator)}`);
      }
    }
  }

  if (typeof rule.value !== "number") {
    return false;
  }

  const expected = isRatingField(rule.field) ? normalizeFilterRating(rule.value) : rule.value;

  switch (rule.operator) {
    case ">=":
      return fieldValue >= expected;
    case "<=":
      return fieldValue <= expected;
    case "==":
      return fieldValue === expected;
    case "!=":
      return fieldValue !== expected;
    case "contains":
    case "not_contains":
      return false;
    default: {
      const exhaustiveOperator: never = rule.operator;
      throw new Error(`Unknown media filter operator: ${String(exhaustiveOperator)}`);
    }
  }
}

function assertDepth(depth: number): void {
  if (depth > MEDIA_FILTER_MAX_DEPTH) {
    throw new Error(
      `Max media filter recursion depth (${MEDIA_FILTER_MAX_DEPTH}) exceeded. Check for circular references.`,
    );
  }
}

/**
 * Evaluate one leaf or nested group node.
 *
 * @param node - Filter node to evaluate.
 * @param item - Generic media entity to inspect.
 * @param depth - Current traversal depth.
 * @returns True when the node matches.
 * @throws Error when the maximum filter depth is exceeded.
 */
export function evaluateMediaFilterNode(
  node: MediaFilterNode,
  item: MediaItem,
  depth: number = 0,
): boolean {
  assertDepth(depth);
  if (isMediaFilterRule(node)) {
    return evaluateMediaFilterRule(node, item);
  }

  return evaluateMediaFilterGroup(node, item, depth);
}

/**
 * Recursively evaluate an all/any group with short-circuit behavior.
 *
 * @param group - Recursive filter group.
 * @param item - Generic media entity to inspect.
 * @param depth - Current traversal depth.
 * @returns True when the group matches.
 * @throws Error when the maximum filter depth is exceeded.
 */
export function evaluateMediaFilterGroup(
  group: MediaFilterGroup,
  item: MediaItem,
  depth: number = 0,
): boolean {
  assertDepth(depth);

  if (group.match === "all") {
    for (const node of group.rules) {
      if (!evaluateMediaFilterNode(node, item, depth + 1)) {
        return false;
      }
    }
    return true;
  }

  for (const node of group.rules) {
    if (evaluateMediaFilterNode(node, item, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluate a complete media filter against a generic entity.
 *
 * @param filter - Complete media filter.
 * @param item - Generic media entity to inspect.
 * @returns True when the entity matches the filter.
 */
export function evaluateMediaFilter(filter: MediaFilter, item: MediaItem): boolean {
  return evaluateMediaFilterGroup(
    { type: "group", match: filter.match, rules: filter.rules },
    item,
  );
}

function sameRule(left: MediaFilterRule, right: MediaFilterRule): boolean {
  return (
    left.field === right.field && left.operator === right.operator && left.value === right.value
  );
}

function includesRule(
  appliedRules: readonly MediaFilterRule[],
  candidate: MediaFilterRule,
): boolean {
  return appliedRules.some((applied) => sameRule(applied, candidate));
}

function unwrapSingletonRule(node: MediaFilterNode, depth: number): MediaFilterRule | undefined {
  assertDepth(depth);

  if (isMediaFilterRule(node)) {
    return node;
  }
  if (node.rules.length !== 1) {
    return undefined;
  }

  const child = node.rules[0];
  return child === undefined ? undefined : unwrapSingletonRule(child, depth + 1);
}

/**
 * Evaluate only the residual portion of a top-level filter.
 *
 * Applied rules are skipped only in top-level `all` filters, where doing so is
 * logically safe. Nested multi-rule and top-level `any` expressions are always
 * evaluated because a provider may have matched only one branch.
 *
 * @param filter - Complete media filter.
 * @param item - Generic media entity to inspect.
 * @param appliedRules - Exact leaf rules already enforced by the provider.
 * @returns True when all remaining client-side rules match.
 */
export function evaluateMediaFilterWithAppliedRules(
  filter: MediaFilter,
  item: MediaItem,
  appliedRules: readonly MediaFilterRule[],
): boolean {
  if (filter.match === "any") {
    return evaluateMediaFilter(filter, item);
  }

  for (const node of filter.rules) {
    const singletonRule = unwrapSingletonRule(node, 0);
    if (singletonRule && includesRule(appliedRules, singletonRule)) {
      continue;
    }
    if (!evaluateMediaFilterNode(node, item, 0)) {
      return false;
    }
  }

  return true;
}

function assertFilterComplexity(nodes: readonly MediaFilterNode[], depth: number): void {
  assertDepth(depth);
  for (const node of nodes) {
    if (isMediaFilterGroup(node)) {
      assertFilterComplexity(node.rules, depth + 1);
    }
  }
}

/**
 * Build provider-neutral filter pushdown inputs and query variants.
 *
 * The planner recognizes top-level `all` rules, singleton wrappers, and one
 * expandable `any` group. It never maps rules to provider query keys; adapters
 * encode each returned rule themselves.
 *
 * @param filter - Complete media filter to plan.
 * @param supportsRule - Provider predicate for pushdown-compatible leaf rules.
 * @returns Base rules, optional variant rules, and residual-evaluation status.
 * @throws Error when the maximum filter depth is exceeded.
 */
export function planMediaFilterQueries(
  filter: MediaFilter,
  supportsRule: MediaFilterRuleSupport,
): MediaFilterQueryPlan {
  assertFilterComplexity(filter.rules, 0);

  if (filter.match === "any") {
    return {
      baseRules: [],
      queryVariants: [[]],
      requiresResidualEvaluation: true,
    };
  }

  const baseRules: MediaFilterRule[] = [];
  const candidateOrGroups: MediaFilterGroup[] = [];
  let requiresResidualEvaluation = false;

  for (const node of filter.rules) {
    const singletonRule = unwrapSingletonRule(node, 0);
    if (singletonRule) {
      if (supportsRule(singletonRule)) {
        baseRules.push(singletonRule);
      } else {
        requiresResidualEvaluation = true;
      }
      continue;
    }

    requiresResidualEvaluation = true;
    if (isMediaFilterGroup(node) && node.match === "any") {
      candidateOrGroups.push(node);
    }
  }

  let queryVariants: readonly (readonly MediaFilterRule[])[] = [[]];
  if (candidateOrGroups.length === 1) {
    const candidate = candidateOrGroups[0];
    if (candidate !== undefined && candidate.rules.length > 0) {
      const branchRules = candidate.rules.filter(isMediaFilterRule);
      if (
        branchRules.length === candidate.rules.length &&
        branchRules.every((branchRule) => supportsRule(branchRule))
      ) {
        queryVariants = branchRules.map((branchRule) => [branchRule]);
      }
    }
  }

  return {
    baseRules,
    queryVariants,
    requiresResidualEvaluation,
  };
}
