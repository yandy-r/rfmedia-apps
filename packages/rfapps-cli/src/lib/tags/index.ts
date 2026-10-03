/**
 * Hierarchical service tagging primitives.
 *
 * One import site for the whole tag subsystem:
 *
 * - **tag-path**: normalization, ancestor derivation, ordering
 * - **tag-pattern**: pattern/term parsing and the segment matcher
 * - **tag-config-layers**: which config layer owns `tags.mapping`
 * - **tag-index**: the ancestor-closed service/tag projection and its memo
 * - **tag-suggestions**: segment-aware "did you mean" for an unmatched pattern
 * - **tag-inference-rules**: the rule catalog and compose structural view
 * - **tag-inference**: the inference engine and YAML fragment renderer
 *
 * Exports are explicit rather than blanket `export *`, matching `src/lib/index.ts`.
 * That is also what keeps `findClosestTag` unambiguous: it is implemented in
 * `tag-suggestions.ts` and re-exported by `tag-index.ts`, so a blanket re-export of
 * both would be a duplicate. It is surfaced here from its implementation module only.
 *
 * @module rfapps-cli/lib/tags
 */

// Tag path normalization, ancestry, and ordering
export {
  TAG_SEGMENT_PATTERN,
  compareTags,
  invalidSegmentReason,
  isValidTagSegment,
  normalizeTag,
  segmentTooLongReason,
  tagAncestors,
} from "./tag-path.js";
export type { TagInputOrigin } from "./tag-path.js";

// Pattern grammar and the segment matcher
export { parseTagPattern, parseTagTerm, serviceMatches, tagMatches } from "./tag-pattern.js";

// The one config-layer ownership predicate, shared with `lib/validation.ts`
export { findTagMappingLayers, layerSuppliesTagMapping } from "./tag-config-layers.js";

// The tag index: ancestor closure, staleness, and the per-config memo.
//
// `assertTagMapping` / `assertTagList` are the **single** definition of a legal `tags.mapping`,
// at the container level and the value level respectively. Both throw `ConfigValidationError`
// naming the config layer. A consumer that must not throw — `actions/completion.ts` runs from
// shell startup — calls them inside `try`/`catch` and degrades; it must not keep a private copy,
// because a second copy is how the container check came to exist on one surface and not another.
export { assertTagList, assertTagMapping, buildTagIndex, getTagIndex } from "./tag-index.js";
export type { TagIndexBuild, TagIndexInput, TagNormalizationWarning } from "./tag-index.js";

// Segment-aware suggestions for an unmatched `--tag` pattern
export { findClosestTag } from "./tag-suggestions.js";

// Auto-inference rule catalog and compose structural view
export {
  TAG_INFERENCE_RULES,
  TAG_INFERENCE_RULE_IDS,
  readComposeLabels,
} from "./tag-inference-rules.js";
export type {
  TagInferenceComposeConfig,
  TagInferenceComposeService,
  TagInferenceContext,
  TagInferenceRule,
} from "./tag-inference-rules.js";

// Inference engine and paste-ready YAML fragment renderer
export { inferTags, renderTagFragment } from "./tag-inference.js";
export type { TagFragmentOptions, TagInferenceOptions } from "./tag-inference.js";
