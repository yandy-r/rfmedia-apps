/**
 * Hierarchical service tagging contracts for rfapps CLI.
 *
 * `TagPath` is a nominal (branded) type: **only `normalizeTag()` may mint a `TagPath`.**
 * Never cast a raw string to `TagPath` — the brand exists so that every value flowing
 * through the tag index, matcher, and inference engine is known to be lowercase,
 * slash-separated, and free of leading/trailing slashes and empty segments.
 */

/** Machine-output schema version for every tag surface. */
export const TAGS_SCHEMA_VERSION = "tags.v1" as const;

export const TAG_MAX_DEPTH = 8;
export const TAG_MAX_SEGMENT_LENGTH = 40;
export const TAG_MAX_LENGTH = 128;

/**
 * A normalized, validated hierarchical tag path: lowercase, slash-separated,
 * no leading/trailing slash, no empty segments.
 * Nominal type — only normalizeTag() may mint one.
 */
export type TagPath = string & { readonly __brand: "TagPath" };

/** The `tags:` section of rfapps.config.yaml. Service-keyed, mirrors profiles.mapping. */
export interface TagConfig {
  /** service name -> declared tag paths, as authored (pre-normalization). */
  readonly mapping?: Readonly<Record<string, readonly string[]>>;
}

export type TagPatternElement =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "single" } // *  — exactly one segment
  | { readonly kind: "deep" }; // ** — zero or more segments

export interface TagPattern {
  readonly source: string;
  readonly negated: boolean;
  readonly elements: readonly TagPatternElement[];
}

/** One `--tag` flag occurrence: comma-separated patterns within it OR together. */
export interface TagTerm {
  readonly source: string;
  readonly include: readonly TagPattern[];
  readonly exclude: readonly TagPattern[];
}

/** Immutable, memoized projection of config.tags for one RfappsConfig. */
export interface TagIndex {
  /** service -> declared (normalized) tags */
  readonly declared: ReadonlyMap<string, readonly TagPath[]>;
  /** service -> ancestor-closed effective tag set */
  readonly effective: ReadonlyMap<string, ReadonlySet<TagPath>>;
  /** tag -> services carrying it effectively */
  readonly byTag: ReadonlyMap<TagPath, readonly string[]>;
  /** every effective tag, sorted */
  readonly allTags: readonly TagPath[];
  /** only tags an operator actually wrote (no derived ancestors) */
  readonly declaredTags: ReadonlySet<TagPath>;
  /** services present in tags.mapping but absent from compose.yml */
  readonly unresolvedServices: readonly string[];
  /** the config file path the winning `tags:` block came from */
  readonly source: string;
}

export type TagInferenceRuleId =
  | "tag-infer-profile"
  | "tag-infer-group"
  | "tag-infer-arr"
  | "tag-infer-database"
  | "tag-infer-cache"
  | "tag-infer-ingress"
  | "tag-infer-tailnet";

export type TagInferenceConfidence = "high" | "medium";

export interface TagProposal {
  readonly service: string;
  readonly tags: readonly TagPath[];
  readonly rules: readonly TagInferenceRuleId[];
  readonly confidence: TagInferenceConfidence;
  /** true when the service already carries this tag (or an ancestor) */
  readonly alreadyPresent: boolean;
}

export interface TagSuggestResult {
  readonly schemaVersion: typeof TAGS_SCHEMA_VERSION;
  readonly proposals: readonly TagProposal[];
  readonly unresolved: readonly string[];
  readonly skippedRules: readonly TagInferenceRuleId[];
  readonly degraded: boolean;
  readonly fragment: string;
  readonly writtenTo?: string;
}

export interface TagListEntry {
  readonly tag: TagPath;
  readonly depth: number;
  readonly declared: boolean;
  readonly services: readonly string[];
  readonly serviceCount: number;
}

export interface TagListResult {
  readonly schemaVersion: typeof TAGS_SCHEMA_VERSION;
  readonly tags: readonly TagListEntry[];
  readonly totalTags: number;
  readonly totalServices: number;
  readonly untaggedServices: readonly string[];
  readonly unresolvedServices: readonly string[];
  /** absolute path of the config layer that won the `tags:` block */
  readonly source: string;
}

export interface TagShowEntry {
  readonly service: string;
  readonly declaredTags: readonly TagPath[];
  readonly effectiveTags: readonly TagPath[];
}

export interface TagShowResult {
  readonly schemaVersion: typeof TAGS_SCHEMA_VERSION;
  readonly services: readonly TagShowEntry[];
}
