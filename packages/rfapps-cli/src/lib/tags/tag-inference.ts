/**
 * Tag inference engine, degraded mode, and YAML fragment renderer (design §8.1–§8.5).
 *
 * The declarative catalog lives in `./tag-inference-rules.js`; this module is the
 * engine that runs it over a scope of compose services and turns the raw proposals
 * into a `TagSuggestResult`.
 *
 * **Safety contract: this module never mutates configuration and never touches the
 * filesystem.** It returns the fragment as a string; persisting it is the action
 * layer's `--out` concern. It also never takes the global state lock, never opens
 * the state database, and never reads runtime state (`docker stats`, container
 * health) — that is issue #62's territory.
 *
 * The single external call is `docker compose config`. When it fails the run
 * **degrades** to the config-only rules instead of aborting (§8.4), because the whole
 * surface is advisory and mutates nothing: half an answer beats no answer here, and
 * the caller is told exactly which half is missing via `degraded` + `skippedRules`.
 */

import { logDebug } from "@rfmedia/common";
import YAML from "yaml";

import { getComposeConfig } from "../docker.js";
import { TAG_INFERENCE_RULES } from "./tag-inference-rules.js";
import type {
  TagInferenceComposeConfig,
  TagInferenceComposeService,
  TagInferenceContext,
  TagInferenceRule,
} from "./tag-inference-rules.js";
import { normalizeTag } from "./tag-path.js";
import { TAGS_SCHEMA_VERSION } from "../../types/tags.js";
import type { RfappsConfig } from "../../types/config.js";
import type { EnvToolExecConfig } from "../../types/options.js";
import type {
  TagIndex,
  TagInferenceConfidence,
  TagInferenceRuleId,
  TagPath,
  TagProposal,
  TagSuggestResult,
} from "../../types/tags.js";

/** Inputs the engine needs beyond the configuration and the tag index. */
export interface TagInferenceOptions {
  /**
   * Compose service names to evaluate, already narrowed by the action layer's
   * `-s` / `--services` / `-g` resolution. Required rather than derived, because the
   * universe must stay available in degraded mode when compose cannot be resolved.
   */
  readonly services: readonly string[];
  /** `--rule` subset. Absent or empty means the whole catalog, in declaration order. */
  readonly rules?: readonly TagInferenceRuleId[];
  /** `--include-tagged`: keep proposals the service already carries in full. */
  readonly includeTagged?: boolean;
  /** Compose file to resolve. Defaults to `config.composePath`. */
  readonly composePath?: string;
  /** Env file handed to `docker compose config`. Defaults to `config.envFile`. */
  readonly envFile?: string;
  /** Compose profiles to activate while resolving. */
  readonly profiles?: readonly string[];
  /** Secrets-injection wrapper for the compose invocation. */
  readonly envTool?: EnvToolExecConfig;
}

/** Options for the standalone fragment renderer. */
export interface TagFragmentOptions {
  /** Absolute path of the config layer that owns the `tags:` block (`TagIndex.source`). */
  readonly source: string;
  /** When true the header warns that label- and image-based rules were skipped. */
  readonly degraded?: boolean;
}

/** Confidence ordering. A proposal inherits the highest confidence that contributed. */
const CONFIDENCE_RANK: Readonly<Record<TagInferenceConfidence, number>> = {
  high: 2,
  medium: 1,
};

/** One service's raw inference result, before the `alreadyPresent` verdict. */
interface ServiceInference {
  readonly tags: readonly TagPath[];
  readonly rules: readonly TagInferenceRuleId[];
  readonly confidence: TagInferenceConfidence;
}

/**
 * Narrows the catalog to the requested rule ids, preserving declaration order.
 *
 * Order is load-bearing: it is the order proposals are attributed in and the order
 * `--list-rules` prints. Unknown ids cannot occur — `TagInferenceRuleId` is a closed
 * union and the command layer validates `--rule` before dispatch.
 */
function selectRules(
  requested: readonly TagInferenceRuleId[] | undefined,
): readonly TagInferenceRule[] {
  if (requested === undefined || requested.length === 0) {
    return TAG_INFERENCE_RULES;
  }

  const wanted = new Set<TagInferenceRuleId>(requested);
  return TAG_INFERENCE_RULES.filter((rule) => wanted.has(rule.id));
}

/**
 * Resolves compose once, or returns `undefined` to trigger degraded mode (§8.4).
 *
 * Two distinct failures collapse to the same fail-soft outcome: `getComposeConfig`
 * returning `undefined` (compose resolved but the command failed) and it rejecting
 * (the Docker CLI is absent, so the spawn itself throws). Neither is fatal for an
 * advisory surface, and the caller learns about it through `degraded`/`skippedRules`
 * rather than through a swallowed exception.
 */
async function readComposeServices(
  config: RfappsConfig,
  options: TagInferenceOptions,
): Promise<Readonly<Record<string, TagInferenceComposeService>> | undefined> {
  try {
    const resolved = await getComposeConfig(options.composePath ?? config.composePath, {
      envFile: options.envFile ?? config.envFile,
      profiles: options.profiles === undefined ? undefined : [...options.profiles],
      envTool: options.envTool,
    });

    if (resolved === undefined) {
      return undefined;
    }

    // Single cast at the boundary, mirroring `HardenComposeConfig` in actions/harden.ts.
    // `ComposeServiceConfig` in lib/docker.ts has no `labels` field and MUST NOT gain
    // one: it is consumed by plan-generation fingerprinting.
    return (resolved as unknown as TagInferenceComposeConfig).services;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`Tag inference degrading to config-only rules: ${message}`);
    return undefined;
  }
}

/**
 * Runs the active rules over one service and merges their proposals.
 *
 * Every returned literal is normalized here, in the CLI flavour: a rule emitting a
 * malformed tag is a catalog bug, and `normalizeTag` throwing is the fail-fast signal
 * that says so. Rules are pure and synchronous by contract, so this stays synchronous.
 *
 * @returns The merged inference, or `undefined` when no rule fired
 */
function inferForService(
  service: string,
  config: RfappsConfig,
  composeService: TagInferenceComposeService | undefined,
  rules: readonly TagInferenceRule[],
): ServiceInference | undefined {
  const context: TagInferenceContext = { service, config, composeService };
  const tags: TagPath[] = [];
  const contributing: TagInferenceRuleId[] = [];
  let confidence: TagInferenceConfidence = "medium";

  for (const rule of rules) {
    const proposed = rule.evaluate(context);

    if (proposed.length === 0) {
      continue;
    }

    for (const literal of proposed) {
      const tag = normalizeTag(literal);

      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }

    contributing.push(rule.id);

    if (CONFIDENCE_RANK[rule.confidence] > CONFIDENCE_RANK[confidence]) {
      confidence = rule.confidence;
    }
  }

  return tags.length === 0 ? undefined : { tags, rules: contributing, confidence };
}

/**
 * Builds the `# …` header that precedes the YAML block.
 *
 * The "paste source" warning is not decoration. `tags:` layering is wholesale
 * replacement (§5.4), so pasting this block into a higher layer such as
 * `.rfapps.yaml` discards the base taxonomy instead of extending it.
 */
function renderFragmentHeader(options: TagFragmentOptions, hasProposals: boolean): string[] {
  const lines = [
    "# Suggested by `rfapps tag suggest`. Nothing has been written.",
    "#",
    "# PASTE SOURCE - NOT a loadable config layer.",
    `# Paste the block below into the 'tags:' section of ${options.source}.`,
    "# Writing it to a different layer (for example .rfapps.yaml) REPLACES the whole",
    "# taxonomy instead of extending it: 'tags:' layers wholesale, so a partial block",
    "# in a higher layer silently shadows the fleet taxonomy.",
    "#",
    "# Leaf paths only - ancestors are derived automatically, so a service tagged",
    "# 'media/automation/arr' also matches 'media/automation' and 'media'.",
  ];

  if (options.degraded === true) {
    lines.push(
      "#",
      "# DEGRADED: Docker was unavailable, so the label- and image-based rules were",
      "# skipped. Re-run with Docker reachable for the full proposal set.",
    );
  }

  if (!hasProposals) {
    lines.push("#", "# No tags were inferred for the selected scope; there is nothing to paste.");
  }

  return lines;
}

/**
 * Drops tags that are proper ancestors of another tag in the same list.
 *
 * `tags.mapping` stores **leaf paths only** (§5.1) because ancestors are derived by
 * the closure rule (§3.3), so emitting `media/automation` beside
 * `media/automation/arr` is redundant in the file the operator maintains by hand.
 * The collapse is lossless: both forms produce an identical effective tag set.
 *
 * This applies to the fragment only. `TagProposal.tags` keeps the full set because
 * the human table (§8.5) attributes each tag to the rule that proposed it, and
 * dropping a tag there would orphan its rule.
 */
function toLeafTags(tags: readonly TagPath[]): string[] {
  return tags.filter(
    (candidate) => !tags.some((other) => other !== candidate && other.startsWith(`${candidate}/`)),
  );
}

/**
 * Renders the copy-pasteable `tags: mapping:` fragment (§8.1).
 *
 * Serialization goes through the `yaml` package rather than string concatenation so
 * that a service name needing quoting (`no`, `on`, a bare number) survives the round
 * trip. `lineWidth: 0` disables folding, which would otherwise wrap a long tag path.
 *
 * With no proposals the fragment is **comments only** — deliberately no `tags:` key.
 * An empty `mapping:` would parse as null and pasting it would erase the taxonomy,
 * which is exactly the failure this whole surface exists to avoid.
 *
 * @param proposals - The proposals to render, in output order
 * @param options - The owning config layer and the degraded flag
 * @returns A newline-terminated fragment safe to print to stdout
 */
export function renderTagFragment(
  proposals: readonly TagProposal[],
  options: TagFragmentOptions,
): string {
  const header = renderFragmentHeader(options, proposals.length > 0);

  if (proposals.length === 0) {
    return `${header.join("\n")}\n`;
  }

  const mapping: Record<string, string[]> = {};

  for (const proposal of proposals) {
    mapping[proposal.service] = toLeafTags(proposal.tags);
  }

  const block = YAML.stringify({ tags: { mapping } }, { indent: 2, lineWidth: 0 });

  return `${header.join("\n")}\n${block}`;
}

/**
 * Infers hierarchical tags for a scope of services (design §8.1–§8.5).
 *
 * The tag index arrives as a **parameter** rather than being built here: the action
 * layer already holds one, and threading it in keeps this module free of the index
 * builder. It is used for exactly one thing — deciding `alreadyPresent`.
 *
 * `alreadyPresent` is true when the service's ancestor-closed effective tag set
 * already contains **every** proposed tag, i.e. the proposal adds nothing. Those
 * proposals are dropped unless `--include-tagged` is set, which is what makes
 * `suggest` idempotent: paste the fragment, re-run, get nothing back.
 *
 * `TagProposal.tags` is always the complete inferred set, in both modes, because the
 * fragment is a **replacement** block for `tags.mapping[service]` — emitting a delta
 * would produce a block that silently drops the tags it omitted.
 *
 * `unresolved` lists in-scope services no rule fired on at all. It is computed before
 * the `alreadyPresent` filter, so it means "inference had nothing to say about this
 * service, tag it by hand" in every mode.
 *
 * @param config - Fully merged rfapps configuration
 * @param index - The tag index for `config`, used only for `alreadyPresent`
 * @param options - Scope, rule subset, mode flags, and compose resolution inputs
 * @returns The suggest result, including the rendered fragment. Never writes anything.
 * @throws InvalidArgumentError when a rule emits a malformed tag (a catalog bug)
 */
export async function inferTags(
  config: RfappsConfig,
  index: TagIndex,
  options: TagInferenceOptions,
): Promise<TagSuggestResult> {
  const selected = selectRules(options.rules);
  const composeServices = await readComposeServices(config, options);
  const degraded = composeServices === undefined;

  const active = degraded ? selected.filter((rule) => !rule.needsDocker) : selected;
  const skippedRules: readonly TagInferenceRuleId[] = degraded
    ? selected.filter((rule) => rule.needsDocker).map((rule) => rule.id)
    : [];

  const proposals: TagProposal[] = [];
  const unresolved: string[] = [];

  for (const service of options.services) {
    const inferred = inferForService(service, config, composeServices?.[service], active);

    if (inferred === undefined) {
      unresolved.push(service);
      continue;
    }

    const effective = index.effective.get(service);
    const alreadyPresent = inferred.tags.every((tag) => effective?.has(tag) === true);

    if (alreadyPresent && options.includeTagged !== true) {
      continue;
    }

    proposals.push({
      service,
      tags: inferred.tags,
      rules: inferred.rules,
      confidence: inferred.confidence,
      alreadyPresent,
    });
  }

  return {
    schemaVersion: TAGS_SCHEMA_VERSION,
    proposals,
    unresolved,
    skippedRules,
    degraded,
    fragment: renderTagFragment(proposals, { source: index.source, degraded }),
  };
}
