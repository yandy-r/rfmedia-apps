/**
 * The tag index: an immutable projection of `config.tags.mapping` (design §4.1, §5.1).
 *
 * `buildTagIndex()` is **pure**. The compose service universe is a *parameter*, never
 * something this module fetches, and that is structural rather than stylistic: `lib/validation.ts`
 * imports `buildTagIndex`, so reaching back into it for `parseComposeFile` would create a
 * circular ESM import between two modules — one of which holds mutable module-level compose
 * cache state. Every caller already has the universe in hand, so passing it costs nothing and
 * removes the cycle entirely. **Do not import the validation module here.**
 *
 * Storage is config-only (design §5.3): this module never reads or writes `compose.yml`, never
 * touches the SQLite state database, and never persists anything to disk. The one filesystem
 * read it does perform is in `getTagIndex()`, which re-reads the *config layers* purely to
 * attribute the winning `tags:` block to a path for `TagIndex.source`.
 *
 * ## What lives in the index
 *
 * The index covers **every service named in `tags.mapping`**, including those absent from the
 * compose universe. `unresolvedServices` marks that subset rather than silently dropping it.
 * That shape is load-bearing for post-condition P4 (design §7.2): a `--tag` selector whose only
 * matches were stale mapping entries must be able to report
 * *"tags.mapping assigns this tag to services absent from compose.yml: plex-old"* instead of a
 * useless "matched nothing". Restricting the index to the universe up front would make that
 * diagnosis uncomputable. Consumers that need a compose-only view intersect with the universe
 * themselves — `applyTagAxis()` does exactly that.
 *
 * All matching is against the **effective** set `E(s) = ⋃ tagAncestors(t)` over declared tags
 * (design §3.3), never the declared set.
 */

import type { RfappsConfig } from "../../types/config.js";
import type { TagIndex, TagPath } from "../../types/tags.js";
import { listConfigLayerPaths } from "../config.js";
import { ConfigValidationError } from "../errors.js";
import { layerSuppliesTagMapping } from "./tag-config-layers.js";
import type { TagInputOrigin } from "./tag-path.js";
import { compareTags, normalizeTag, tagAncestors } from "./tag-path.js";

/**
 * Segment-aware "did you mean" suggestions for an unmatched `--tag` pattern.
 *
 * Re-exported so every consumer has a single tag-index import site (design §3.9 places
 * `findClosestTag` on this module's public surface). The implementation deliberately lives in
 * `tag-suggestions.ts` next to the scoring rationale — do not reimplement it here.
 */
export { findClosestTag } from "./tag-suggestions.js";

/**
 * A `tags.mapping` entry that was accepted but rewritten into canonical form.
 *
 * Canonicalization (case folding, outer-slash stripping) is deliberate — `Media/Streaming` and
 * `media/streaming` denote one concept and maintaining two parallel hierarchies is the worse
 * outcome — but it is still a silent rewrite of authored config, so it is reported rather than
 * hidden. `validateTagReferences` turns these into operator-visible validation warnings.
 *
 * **This module does not log.** Warnings are returned to the caller, which owns presentation.
 */
export interface TagNormalizationWarning {
  /** The service whose mapping entry was rewritten */
  readonly service: string;
  /** The tag exactly as authored in the config file */
  readonly authored: string;
  /** The canonical form the tag was rewritten to */
  readonly normalized: TagPath;
  /** Ready-to-render explanation of the rewrite */
  readonly message: string;
}

/** Everything `buildTagIndex()` needs. The universe is supplied, never fetched. */
export interface TagIndexInput {
  /**
   * `config.tags.mapping` — service name to declared tag paths, **as authored**.
   *
   * The declared type is a claim about the config file, not a proof: `config.ts` casts
   * `YAML.parse(...)` straight to `PartialRfappsConfig`. `buildTagIndex` re-proves it at runtime
   * through {@link assertTagMapping} and {@link assertTagList}.
   */
  readonly mapping: Readonly<Record<string, readonly string[]>>;
  /** Compose service names, in compose declaration order */
  readonly universe: readonly string[];
  /** Absolute path of the config layer the `tags:` block came from */
  readonly source: string;
}

/** The index plus every canonicalization the build performed. */
export interface TagIndexBuild {
  readonly index: TagIndex;
  readonly warnings: readonly TagNormalizationWarning[];
}

/**
 * Orders the mapping's services deterministically and splits out the stale ones.
 *
 * Services present in compose come first, in **compose declaration order**, so `byTag` lists and
 * every downstream rendering are stable and diffable (post-condition P5). Services absent from
 * compose are appended in authored order, which is the order an operator will find them in when
 * told to delete them.
 */
function orderMappedServices(
  mapping: Readonly<Record<string, readonly string[]>>,
  universe: readonly string[],
): { readonly ordered: readonly string[]; readonly unresolved: readonly string[] } {
  const mapped = new Set(Object.keys(mapping));
  const universeSet = new Set(universe);

  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const service of universe) {
    if (mapped.has(service) && !seen.has(service)) {
      seen.add(service);
      ordered.push(service);
    }
  }

  const unresolved: string[] = [];

  for (const service of mapped) {
    if (!universeSet.has(service)) {
      unresolved.push(service);
      ordered.push(service);
    }
  }

  return { ordered, unresolved };
}

/** Builds the operator-facing explanation of a canonicalization rewrite. */
function normalizationMessage(service: string, authored: string, normalized: TagPath): string {
  return `Tag '${authored}' for service '${service}' was normalized to '${normalized}'`;
}

/** Narrows a parsed YAML/JSON value to a plain object without reaching for `any`. */
/**
 * Narrows to a **plain** object, not merely `typeof "object"`.
 *
 * A prototype check is load-bearing rather than pedantic: an explicit YAML type tag
 * (`!!set`, `!!omap`, `!!timestamp`, `!!binary`) parses to a `Set` / `Map` / `Date` /
 * `Buffer`, all of which are non-null, non-array objects whose `Object.keys()` is empty
 * or index-like. Admitting them would let `tags.mapping` silently resolve to an empty
 * taxonomy — the exact silent-wrong-selection failure `assertTagMapping` exists to stop.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Proves the `tags.mapping` **container** really is a mapping before anything iterates it.
 *
 * This is the outer twin of {@link assertTagList}, and it has to exist separately because the
 * container is never iterated with `for…of` — it is read with `Object.keys` / `Object.entries`,
 * which do not throw on a non-object. For every shape whose `Object.keys` is `[]` — a number, a
 * boolean, an empty string — the whole taxonomy would evaporate in **total silence**: `tag list`
 * would report "no tags are defined" for a file that literally contains a `mapping:` key,
 * `validate` would report success with zero warnings, and `delete --tag '!media'` would match
 * *every* service and offer to delete the entire project. The leaf guard cannot cover this: it
 * only runs per service key, and there are no keys.
 *
 * The string and list cases are just as much a misdiagnosis as a miss. `Object.keys("media")` is
 * `["0", …]`, so the leaf guard fired on a phantom service named `0` and blamed
 * *"entry for '0' must be a list of tag paths"* — pointing the operator at a service that does
 * not exist instead of at the one real mistake, which is that `tags.mapping` is not a mapping.
 *
 * A nullish container keeps its existing meaning of "no taxonomy" and is normalized to `{}`: an
 * absent `tags:` block, `tags: {}`, and an explicit `mapping:` with nothing after it are all
 * legal ways to say a project has not adopted tags yet. Only a container that is *present and
 * the wrong shape* is rejected.
 *
 * @param value - The authored `tags.mapping` value, as the YAML parser delivered it
 * @param source - Absolute path of the config layer, for the error's `configSource`
 * @returns The mapping, or `{}` when it is absent or null
 * @throws ConfigValidationError naming the config layer when the value is not a mapping
 */
export function assertTagMapping(
  value: unknown,
  source: string,
): Readonly<Record<string, readonly string[]>> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ConfigValidationError(
      "tags.mapping",
      source,
      `tags.mapping must be a mapping of service name to tag list ` +
        `(got ${describeValue(value)}); write 'mapping:' with one 'service: [tag, …]' entry ` +
        `per line beneath it`,
    );
  }

  return value as Readonly<Record<string, readonly string[]>>;
}

/**
 * Proves one `tags.mapping` value really is the list of strings the type claims.
 *
 * `config.ts` casts `YAML.parse(...)` straight to `PartialRfappsConfig`, so
 * `Readonly<Record<string, readonly string[]>>` is a claim about the file rather than a proof
 * about the value. The claim has to be checked here because **a string is iterable**: the
 * scalar shape `profiles.mapping` and `sidecars.mapping` use (`plex: media`) would otherwise
 * flow through `for…of` as one one-character tag *per character*, leaving `--tag media` to
 * silently drop plex and `--tag '!media'` to silently pull it into a `delete`. Non-string
 * elements are just as invisible: YAML types an unquoted `2024` as a number, which reaches
 * `normalizeTag` and dies with a bare `input.trim is not a function` naming no file.
 *
 * Mirrors `validateGroupReferences`'s array guard for the identical shape, but throws rather
 * than warns: the tag axis targets containers, and `validateTagReferences` already downgrades
 * this to a warning at the `rfapps validate` boundary.
 *
 * Exported alongside {@link assertTagMapping} so the **one** definition of "legal tags.mapping"
 * serves every surface. `actions/completion.ts` needs the same two checks but must never throw
 * (it runs from shell startup, where an unhandled error breaks every new shell), so it consumes
 * these and wraps the call in `try`/`catch` rather than keeping a near-verbatim private copy —
 * two copies is exactly how the container check came to exist on one surface and not the other.
 *
 * @throws ConfigValidationError naming the config layer when the value is not `string[]`
 */
export function assertTagList(value: unknown, service: string, source: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(
      "tags.mapping",
      source,
      `entry for '${service}' must be a list of tag paths (got ${describeValue(value)})`,
    );
  }

  const entries: readonly unknown[] = value;

  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new ConfigValidationError(
        "tags.mapping",
        source,
        `tag entry for '${service}' must be a string (got ${describeValue(entry)}); ` +
          `quote numeric tags, e.g. "2024"`,
      );
    }
  }

  return entries as readonly string[];
}

/**
 * Names a value's shape for an operator, distinguishing `null` and a list from an object.
 *
 * Bare `typeof` reports `"object"` for all three, which is the least useful thing to tell someone
 * whose `mapping:` is a YAML sequence.
 */
function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "list";
  }

  if (typeof value === "object") {
    // Name the constructor so a `!!set` / `!!timestamp` container reads as itself
    // rather than as an indistinguishable "object".
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)
      ?.constructor?.name;
    return name === undefined || name === "Object" ? "object" : name;
  }

  return typeof value;
}

/**
 * Builds the tag index from a declared mapping and the compose service universe.
 *
 * Pure: no I/O, no logging, no module state. Every `TagIndex` field is populated.
 *
 * The mapping is shape-checked at **both levels** before anything reads it: the container by
 * {@link assertTagMapping} and each value by {@link assertTagList}. Normalization then runs in
 * its **config flavour**, so any malformed `tags.mapping` throws `ConfigValidationError` naming
 * the config file — fail fast at the boundary (design §3.2) rather than letting bad config decay
 * into wrong container targeting.
 *
 * @param input - The declared mapping, the compose universe, and the winning config layer path
 * @returns The index and every canonicalization warning the build produced
 * @throws ConfigValidationError when the mapping is not a mapping, when a value is not a list of
 *   strings, or when an entry is not a legal tag path
 *
 * @example
 * const { index } = buildTagIndex({
 *   mapping: { traefik: ["infrastructure/core/networking"] },
 *   universe: ["traefik", "plex"],
 *   source: "/repo/rfapps.config.yaml",
 * });
 * index.effective.get("traefik");
 * // Set { "infrastructure", "infrastructure/core", "infrastructure/core/networking" }
 */
export function buildTagIndex(input: TagIndexInput): TagIndexBuild {
  const { universe, source } = input;

  // The container is checked before `orderMappedServices` reads `Object.keys` off it. Reversed,
  // a `mapping: 42` would produce zero keys, an empty index, and no diagnostic anywhere.
  const mapping = assertTagMapping(input.mapping, source);
  const { ordered, unresolved } = orderMappedServices(mapping, universe);

  const origin: TagInputOrigin = { kind: "config", source, field: "tags.mapping" };

  const declared = new Map<string, readonly TagPath[]>();
  const effective = new Map<string, ReadonlySet<TagPath>>();
  const byTag = new Map<TagPath, string[]>();
  const declaredTags = new Set<TagPath>();
  const warnings: TagNormalizationWarning[] = [];

  for (const service of ordered) {
    // The guard must see the authored value, not a coalesced substitute. `ordered` is built
    // exclusively from `Object.keys(mapping)`, so the key is always present at runtime and a
    // `?? []` here could only ever fire for an *explicit* `plex:` (YAML null) — silently
    // rewriting the exact malformed entry this function exists to reject into "no tags".
    const raw: unknown = Object.hasOwn(mapping, service) ? mapping[service] : [];
    const authoredTags = assertTagList(raw, service, source);
    const serviceDeclared: TagPath[] = [];
    const serviceEffective = new Set<TagPath>();

    for (const authored of authoredTags) {
      const normalized = normalizeTag(authored, origin);

      if (authored.trim() !== normalized) {
        warnings.push({
          service,
          authored,
          normalized,
          message: normalizationMessage(service, authored, normalized),
        });
      }

      if (!serviceDeclared.includes(normalized)) {
        serviceDeclared.push(normalized);
      }

      declaredTags.add(normalized);

      for (const ancestor of tagAncestors(normalized)) {
        serviceEffective.add(ancestor);
      }
    }

    declared.set(service, serviceDeclared);
    effective.set(service, serviceEffective);

    // byTag is the inverse of `effective`, not of `declared`: a service tagged
    // `infrastructure/core/networking` must be findable under `infrastructure` (design §3.3).
    for (const tag of serviceEffective) {
      const carriers = byTag.get(tag);

      if (carriers === undefined) {
        byTag.set(tag, [service]);
      } else {
        carriers.push(service);
      }
    }
  }

  // Hierarchical ordering, not lexicographic: '-' and '.' sort below '/', so a plain string
  // sort would interleave `media-old` between `media` and `media/streaming`.
  const allTags = [...byTag.keys()].sort(compareTags);

  const index: TagIndex = {
    declared,
    effective,
    byTag,
    allTags,
    declaredTags,
    unresolvedServices: unresolved,
    source,
  };

  return { index, warnings };
}

/**
 * Resolves which config layer the effective `tags:` block came from.
 *
 * Layers arrive highest-precedence first, and `tags.mapping` is whole-value replacement rather
 * than a deep merge (design §5.4), so the first layer that supplies a mapping is the sole
 * contributor. When no layer does, the lowest-precedence (project) path is reported: that is
 * where an operator should add the block.
 *
 * Ownership is decided by `layerSuppliesTagMapping` rather than a local copy of the rule, so
 * this attribution and `validateTagLayerOwnership`'s warning can never disagree about which
 * layer wins.
 */
async function resolveTagSource(): Promise<string> {
  const layers = await listConfigLayerPaths();

  for (const layer of layers) {
    if (await layerSuppliesTagMapping(layer)) {
      return layer;
    }
  }

  return layers[layers.length - 1] ?? "";
}

/**
 * Per-config, per-compose-path memo.
 *
 * Keyed by config **identity** (a `WeakMap`, so a discarded config does not pin its index) and
 * then by compose path. The stored value is the in-flight promise rather than the resolved
 * index, so concurrent callers within one command share a single build instead of racing to
 * produce two.
 */
const TAG_INDEX_CACHE = new WeakMap<RfappsConfig, Map<string, Promise<TagIndex>>>();

/**
 * Returns the memoized tag index for a config, building it on first use.
 *
 * A single command builds the index **at most once** per `(config identity, compose path)`.
 * The compose universe stays a parameter for the same anti-cycle reason `buildTagIndex` takes
 * one; callers on the resolver path already hold it.
 *
 * Canonicalization warnings are dropped here by design — the memoized surface is the index
 * itself, and warning presentation belongs to `rfapps validate`, which calls `buildTagIndex`
 * directly.
 *
 * @param config - The merged rfapps config; its object identity is the cache key
 * @param composePath - Absolute compose file path the universe was derived from
 * @param universe - Compose service names, in compose declaration order
 * @returns The tag index for this config and compose file
 * @throws ConfigValidationError when a `tags.mapping` entry is not a legal tag path
 */
export async function getTagIndex(
  config: RfappsConfig,
  composePath: string,
  universe: readonly string[],
): Promise<TagIndex> {
  let perConfig = TAG_INDEX_CACHE.get(config);

  if (perConfig === undefined) {
    perConfig = new Map<string, Promise<TagIndex>>();
    TAG_INDEX_CACHE.set(config, perConfig);
  }

  const cached = perConfig.get(composePath);

  if (cached !== undefined) {
    return cached;
  }

  const pending = (async (): Promise<TagIndex> => {
    const source = await resolveTagSource();
    const { index } = buildTagIndex({
      mapping: config.tags?.mapping ?? {},
      universe,
      source,
    });

    return index;
  })();

  perConfig.set(composePath, pending);

  return pending;
}
