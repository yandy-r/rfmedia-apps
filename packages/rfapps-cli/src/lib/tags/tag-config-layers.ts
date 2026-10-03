/**
 * The single answer to "does this config layer own the tag taxonomy?"
 *
 * Two surfaces need it and must never disagree: `tag-index.ts` attributes `TagIndex.source`
 * (what `rfapps tag list` prints) and `validation.ts` warns which layer wins and which are
 * shadowed (what `rfapps validate` prints). When they were separate near-verbatim copies, one
 * accepted a bare `tags:` key and the other required `tags.mapping`, so a `.rfapps.yaml`
 * containing only `tags: {}` made the two commands report *opposite* winners — and the
 * validate side named a shadowed layer that had in fact contributed everything.
 *
 * The rule mirrors `mergeConfig` exactly (`override.tags?.mapping ?? base.tags?.mapping ?? {}`):
 * **a layer owns the taxonomy only when it supplies a non-nullish `tags.mapping`.** A bare
 * `tags:` key or a `tags: {}` block does not shadow a lower layer, so attributing ownership to
 * it would point the operator at a file that contributed nothing.
 *
 * This module reads config layers and nothing else — no compose parsing, no state, no logging —
 * which is what keeps it importable from both `tag-index.ts` and `validation.ts` without
 * reintroducing the cycle `tag-index.ts`'s header forbids.
 *
 * @module rfapps-cli/lib/tags/tag-config-layers
 */

import { readFile } from "node:fs/promises";

import YAML from "yaml";

/** Narrows parsed YAML/JSON to a plain object without reaching for `any`. */
/**
 * Narrows to a **plain** object, so a layer whose `tags:` block is an explicit YAML type
 * tag (`!!set`, `!!timestamp`) is not mistaken for a well-formed block that owns the
 * taxonomy. Mirrors the guard in `tag-index.ts`; keep the three in step.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reports whether a config layer is the one whose `tags:` block survives merging.
 *
 * Read-only and non-throwing. A layer that cannot be read or parsed simply cannot be proven to
 * own the taxonomy; `loadConfig` is the authority for config errors and has already thrown for
 * any real one by the time this runs, so re-reporting here would only turn an attribution
 * detail into a spurious failure.
 *
 * @param path - Absolute path of one config layer
 * @returns `true` when the layer supplies a non-nullish `tags.mapping`
 *
 * @example
 * await layerSuppliesTagMapping("/repo/.rfapps.yaml"); // `tags: {}` -> false
 * await layerSuppliesTagMapping("/repo/rfapps.config.yaml"); // `tags: { mapping: ... }` -> true
 */
export async function layerSuppliesTagMapping(path: string): Promise<boolean> {
  let content: string;

  try {
    content = await readFile(path, "utf-8");
  } catch {
    return false;
  }

  let parsed: unknown;

  try {
    parsed = path.endsWith(".json") ? JSON.parse(content) : YAML.parse(content);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) {
    return false;
  }

  const tags = parsed["tags"];

  if (!isRecord(tags)) {
    return false;
  }

  const declaredMapping = tags["mapping"];

  return declaredMapping !== undefined && declaredMapping !== null;
}

/**
 * Filters config layers down to those that own the tag taxonomy, precedence order preserved.
 *
 * Layers arrive highest-precedence first, and `tags.mapping` is whole-value replacement rather
 * than a deep merge (design §5.4), so the first entry of the result is the sole contributor and
 * every later entry is shadowed.
 *
 * @param layers - Config layer paths, highest precedence first
 * @returns The subset that supplies `tags.mapping`, in the same order
 */
export async function findTagMappingLayers(layers: readonly string[]): Promise<string[]> {
  const owning: string[] = [];

  for (const layer of layers) {
    if (await layerSuppliesTagMapping(layer)) {
      owning.push(layer);
    }
  }

  return owning;
}
