/**
 * `rfapps tag list` and `rfapps tag show` — read-only taxonomy inspection (design §6.5).
 *
 * Both actions build the tag index and project it into the machine contracts from
 * `types/tags.ts`. Neither writes configuration, mutates Docker, nor acquires the state
 * lock, and both exit 0 on an empty taxonomy: "there are no tags yet" is a legitimate
 * answer to a query, not a failure.
 *
 * **Rendered output goes to stdout; every line of prose goes to stderr**, so
 * `rfapps tag list --tree > taxonomy.txt` captures the taxonomy and nothing else.
 *
 * Tag modules are imported by direct path rather than through the `lib/tags` barrel so
 * this module depends on exactly the three it uses.
 *
 * @module rfapps-cli/actions/tag
 */

import type { OutputFormat } from "@rfmedia/common";

import { parseServicesList, validateTagShowOptions } from "../commands/tag.js";
import { applyCliOverrides, loadConfig } from "../lib/config.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { formatOutput } from "../lib/formatters/index.js";
import { isValidProfile } from "../lib/services.js";
import { getTagIndex } from "../lib/tags/tag-index.js";
import { compareTags } from "../lib/tags/tag-path.js";
import { parseComposeFile, validateServiceNames } from "../lib/validation.js";
import type { RfappsConfig } from "../types/config.js";
import { TAGS_SCHEMA_VERSION } from "../types/tags.js";
import type {
  TagIndex,
  TagListEntry,
  TagListResult,
  TagPath,
  TagShowEntry,
  TagShowResult,
} from "../types/tags.js";

/** Raw Commander option values for `rfapps tag list`. */
export interface RawTagListOptions {
  /** Render the taxonomy as an indented tree. */
  readonly tree?: boolean;
  /** Path to the Docker Compose file. */
  readonly compose?: string;
  /** Path to the environment file. */
  readonly envFile?: string;
  /** Docker Compose profile to resolve with. */
  readonly profile?: string;
  /** Command-local JSON output flag. */
  readonly json?: boolean;
}

/** Raw Commander option values for `rfapps tag show`. */
export interface RawTagShowOptions {
  /** Target a specific service. */
  readonly service?: string;
  /** Comma-separated service targets. */
  readonly services?: string;
  /** Path to the Docker Compose file. */
  readonly compose?: string;
  /** Path to the environment file. */
  readonly envFile?: string;
  /** Docker Compose profile to resolve with. */
  readonly profile?: string;
  /** Command-local JSON output flag. */
  readonly json?: boolean;
}

/** Program-level options every `tag` subcommand reads. Mirrors `HardenGlobalOptions`. */
export interface TagGlobalOptions {
  /** Preview actions without writing. */
  readonly dryRun?: boolean;
  /** Enable debug output. */
  readonly debug?: boolean;
  /** Program-level JSON output flag. */
  readonly json?: boolean;
  /** Program-level structured output format. */
  readonly output?: OutputFormat;
  /** Enable verbose output. */
  readonly verbose?: boolean;
  /** Skip confirmation prompts. */
  readonly yes?: boolean;
  /** Path to env file for dotenvx secrets injection. */
  readonly useDotenvx?: string;
  /** Path to env file for 1Password CLI secrets injection. */
  readonly useOp?: string;
}

/**
 * Resolves the effective output format for a `tag` subcommand.
 *
 * **The command-local `--json` is checked first, and that order is mandatory.** `cli.ts`
 * declares the global `--output` with `.default("text")`, so `globalOptions.output` is
 * never `undefined`; consulting it first would make every subcommand's `--json` flag
 * permanently dead. Copied from `resolveHardenFormat`.
 *
 * @param rawOptions - The subcommand's own options
 * @param globalOptions - Program-level options
 * @returns The format the action must render in
 */
export function resolveTagFormat(
  rawOptions: { readonly json?: boolean },
  globalOptions: TagGlobalOptions,
): OutputFormat {
  if (rawOptions.json === true) {
    return "json";
  }
  if (globalOptions.output !== undefined) {
    return globalOptions.output;
  }
  if (globalOptions.json === true) {
    return "json";
  }
  return "text";
}

/**
 * Rejects `--output csv` for the two hierarchical inspection surfaces (design §6.5).
 *
 * `TagListResult` and `TagShowResult` both nest arrays inside rows, which CSV cannot
 * represent without silently flattening them into an ambiguous string. Following the
 * `backup` precedent, the lossy format is refused rather than quietly emitted.
 *
 * @throws {InvalidArgumentError} When the resolved format is `csv`
 */
function rejectCsv(format: OutputFormat): void {
  if (format === "csv") {
    throw new InvalidArgumentError(
      "--output",
      "csv",
      "Tag output is hierarchical; use json, yaml, or table",
      ["json", "yaml", "table", "text"],
    );
  }
}

/** Applies the shared `-f` / `-e` / `-p` overrides after validating the profile. */
function resolveConfig(
  config: RfappsConfig,
  rawOptions: { compose?: string; envFile?: string; profile?: string },
): RfappsConfig {
  if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) {
    throw new InvalidArgumentError("--profile", rawOptions.profile, "Invalid profile", [
      ...config.profiles.validProfiles,
    ]);
  }

  return applyCliOverrides(config, {
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  });
}

/** Loads the config, the compose universe, and the memoized tag index in one step. */
async function loadTagContext(rawOptions: {
  compose?: string;
  envFile?: string;
  profile?: string;
}): Promise<{ config: RfappsConfig; universe: string[]; index: TagIndex }> {
  const config = resolveConfig(await loadConfig(), rawOptions);
  const universe = await parseComposeFile(config.composePath);
  const index = await getTagIndex(config, config.composePath, universe);

  return { config, universe, index };
}

/** Depth is segment count: `media` is 1, `media/automation/arr` is 3. */
function tagDepth(tag: TagPath): number {
  return tag.split("/").length;
}

/** The last segment of a tag path, which is what the tree renders at each level. */
function tagLeafSegment(tag: TagPath): string {
  const segments = tag.split("/");

  return segments[segments.length - 1] ?? tag;
}

/** Projects the index into the `tag list` machine contract. */
function buildTagListResult(index: TagIndex, universe: readonly string[]): TagListResult {
  const tags: TagListEntry[] = index.allTags.map((tag) => {
    const services = index.byTag.get(tag) ?? [];

    return {
      tag,
      depth: tagDepth(tag),
      declared: index.declaredTags.has(tag),
      services,
      serviceCount: services.length,
    };
  });

  const untaggedServices = universe.filter(
    (service) => (index.effective.get(service)?.size ?? 0) === 0,
  );

  return {
    schemaVersion: TAGS_SCHEMA_VERSION,
    tags,
    totalTags: tags.length,
    totalServices: universe.length - untaggedServices.length,
    untaggedServices,
    unresolvedServices: index.unresolvedServices,
    source: index.source,
  };
}

/** Column-aligned rows for `--output table`, flattening the nested service lists. */
function tagListTableRows(result: TagListResult): Record<string, unknown>[] {
  return result.tags.map((entry) => ({
    tag: entry.tag,
    depth: entry.depth,
    services: entry.services.join(", "),
    count: entry.serviceCount,
  }));
}

/** Width of the tree's left column, wide enough for the deepest label plus its indent. */
const TREE_LABEL_WIDTH = 38;

/**
 * Renders the indented tree (design §6.5) to stdout.
 *
 * A tag with children is a grouping level and carries no service column, because its
 * services are exactly the union of its descendants' and repeating them at every level
 * makes a 45-service fleet unreadable. The one exception is a root: its rollup count is
 * the number an operator actually wants at a glance.
 */
function renderTagTree(result: TagListResult): void {
  const parents = new Set<string>();

  for (const entry of result.tags) {
    const segments = entry.tag.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      parents.add(segments.slice(0, index).join("/"));
    }
  }

  for (const entry of result.tags) {
    const label = `${"  ".repeat(entry.depth - 1)}${tagLeafSegment(entry.tag)}`;
    const isParent = parents.has(entry.tag);

    if (isParent) {
      const rollup =
        entry.depth === 1 && entry.serviceCount > 1 ? `(${entry.serviceCount} services)` : "";
      console.log(rollup === "" ? label : `${label.padEnd(TREE_LABEL_WIDTH)}${rollup}`);
      continue;
    }

    console.log(`${label.padEnd(TREE_LABEL_WIDTH)}${entry.services.join(", ")}`);
  }
}

/** Renders the flat `tag  count  services` listing to stdout. */
function renderTagListFlat(result: TagListResult): void {
  const width = Math.max(...result.tags.map((entry) => entry.tag.length));

  for (const entry of result.tags) {
    console.log(
      `${entry.tag.padEnd(width)}  ${String(entry.serviceCount).padStart(3)}  ${entry.services.join(", ")}`,
    );
  }
}

/** Renders the stderr trailer: untagged services, stale mapping entries, and the source. */
function renderTagListProse(result: TagListResult): void {
  if (result.untaggedServices.length > 0) {
    console.error(
      `\nUntagged (${result.untaggedServices.length}): ${result.untaggedServices.join(", ")}`,
    );
  }

  if (result.unresolvedServices.length > 0) {
    console.error(
      `tags.mapping assigns tags to services absent from compose.yml: ${result.unresolvedServices.join(", ")}`,
    );
  }

  console.error(`Source: ${result.source}`);
}

/**
 * List every effective tag and the services carrying it.
 *
 * An empty taxonomy is a success: the command exits 0 and points at
 * `rfapps tag suggest` rather than failing on a fleet nobody has tagged yet.
 *
 * @param rawOptions - Raw Commander option values for `rfapps tag list`
 * @param globalOptions - Program-level options (`--output`, `--json`, ...)
 * @throws {InvalidArgumentError} On `--output csv` or an invalid `--profile`
 * @throws {ConfigValidationError} When `tags.mapping` holds a malformed tag path
 */
export async function executeTagList(
  rawOptions: RawTagListOptions,
  globalOptions: TagGlobalOptions,
): Promise<void> {
  const format = resolveTagFormat(rawOptions, globalOptions);
  rejectCsv(format);

  const { universe, index } = await loadTagContext(rawOptions);
  const result = buildTagListResult(index, universe);

  if (format !== "text") {
    await formatOutput(
      format,
      format === "table" ? tagListTableRows(result) : result,
      format === "table" ? { columns: ["tag", "depth", "services", "count"] } : undefined,
    );
    return;
  }

  if (result.totalTags === 0) {
    console.error(`No tags are defined in ${result.source}.`);
    console.error("Run `rfapps tag suggest` to infer a starter taxonomy to paste there.");
    return;
  }

  if (rawOptions.tree === true) {
    renderTagTree(result);
  } else {
    renderTagListFlat(result);
  }

  renderTagListProse(result);
}

/** The service names `tag show` was asked about, in the order they were given. */
function requestedServices(rawOptions: RawTagShowOptions): string[] {
  const services: string[] = [];

  if (rawOptions.service !== undefined) {
    services.push(rawOptions.service.trim());
  }

  for (const service of parseServicesList(rawOptions.services) ?? []) {
    if (!services.includes(service)) {
      services.push(service);
    }
  }

  return services;
}

/** Projects one service's declared and ancestor-closed tag sets. */
function buildTagShowEntry(index: TagIndex, service: string): TagShowEntry {
  const effective = [...(index.effective.get(service) ?? [])].sort(compareTags);

  return {
    service,
    declaredTags: index.declared.get(service) ?? [],
    effectiveTags: effective,
  };
}

/** Renders the per-service text view to stdout. */
function renderTagShow(result: TagShowResult): void {
  for (const entry of result.services) {
    console.log(entry.service);
    console.log(
      `  declared:  ${entry.declaredTags.length === 0 ? "(none)" : entry.declaredTags.join(", ")}`,
    );
    console.log(
      `  effective: ${entry.effectiveTags.length === 0 ? "(none)" : entry.effectiveTags.join(", ")}`,
    );
  }
}

/**
 * Show the declared and effective tags of specific services.
 *
 * The service names are validated against compose first, so a typo is a
 * `ServiceNotFoundError` with a suggestion rather than a service that silently reports
 * no tags.
 *
 * @param rawOptions - Raw Commander option values for `rfapps tag show`
 * @param globalOptions - Program-level options (`--output`, `--json`, ...)
 * @throws {InvalidArgumentError} On `--output csv`, a missing target, or an invalid `--profile`
 * @throws {ServiceNotFoundError} When a named service is absent from compose.yml
 */
export async function executeTagShow(
  rawOptions: RawTagShowOptions,
  globalOptions: TagGlobalOptions,
): Promise<void> {
  const format = resolveTagFormat(rawOptions, globalOptions);
  rejectCsv(format);
  validateTagShowOptions(rawOptions);

  const { config, index } = await loadTagContext(rawOptions);
  const services = requestedServices(rawOptions);
  await validateServiceNames(services, config.composePath);

  const result: TagShowResult = {
    schemaVersion: TAGS_SCHEMA_VERSION,
    services: services.map((service) => buildTagShowEntry(index, service)),
  };

  if (format !== "text") {
    await formatOutput(
      format,
      format === "table"
        ? result.services.map((entry) => ({
            service: entry.service,
            declared: entry.declaredTags.join(", "),
            effective: entry.effectiveTags.join(", "),
          }))
        : result,
      format === "table" ? { columns: ["service", "declared", "effective"] } : undefined,
    );
    return;
  }

  renderTagShow(result);
  console.error(`Source: ${index.source}`);
}
