/**
 * `rfapps tag suggest` — advisory tag inference (design §8.1–§8.5).
 *
 * **This action writes nothing to configuration. Ever.** It renders a copy-pasteable
 * YAML fragment to stdout, or to `--out <path>` with `flag: "wx"` so an existing file
 * is never clobbered. It has no apply mode, it does not acquire the global state lock,
 * and it does not open the state database: the whole surface is a suggestion an
 * operator reviews before pasting.
 *
 * Prose goes to stderr and the fragment to stdout, so
 * `rfapps tag suggest > fragment.yaml` captures exactly the block and nothing else.
 *
 * Tag modules are imported by direct path rather than through the `lib/tags` barrel so
 * this module depends on exactly the two it uses.
 *
 * @module rfapps-cli/actions/tag-suggest
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formatDryRun, logInfo } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { parseServicesList, parseTagRuleIds, validateTagSuggestOptions } from "../commands/tag.js";
import { hasCode } from "../lib/backup-storage-shared.js";
import { applyCliOverrides, loadConfig } from "../lib/config.js";
import { GroupNotFoundError, InvalidArgumentError } from "../lib/errors.js";
import { formatOutput } from "../lib/formatters/index.js";
import { findClosestMatch } from "../lib/fuzzy-match.js";
import { expandServiceGroup, getAvailableGroups, isValidProfile } from "../lib/services.js";
import { TAG_INFERENCE_RULES } from "../lib/tags/tag-inference-rules.js";
import { inferTags } from "../lib/tags/tag-inference.js";
import { getTagIndex } from "../lib/tags/tag-index.js";
import { parseComposeFile, validateServiceNames } from "../lib/validation.js";
import type { RfappsConfig } from "../types/config.js";
import { getEnvToolExecConfig } from "../types/options.js";
import type { TagProposal, TagSuggestResult } from "../types/tags.js";
import { resolveTagFormat } from "./tag.js";
import type { TagGlobalOptions } from "./tag.js";

/** Raw Commander option values for `rfapps tag suggest`. */
export interface RawTagSuggestOptions {
  /** Target a specific service. */
  readonly service?: string;
  /** Comma-separated service targets. */
  readonly services?: string;
  /** Target a service group. */
  readonly group?: string;
  /** Comma-separated inference rule allowlist. */
  readonly rule?: string;
  /** Print the rule catalog and return. */
  readonly listRules?: boolean;
  /** Include services whose proposed tags are already effective. */
  readonly includeTagged?: boolean;
  /** Write the fragment to this path instead of stdout. */
  readonly out?: string;
  /** Path to the Docker Compose file. */
  readonly compose?: string;
  /** Path to the environment file. */
  readonly envFile?: string;
  /** Docker Compose profile to resolve with. */
  readonly profile?: string;
  /** Command-local JSON output flag. */
  readonly json?: boolean;
}

/** Renders the inference catalog, mirroring `formatHardenRulesCatalog`. */
function formatTagRulesCatalog(): string[] {
  const lines = [`Tag Inference Rules (${TAG_INFERENCE_RULES.length})`];

  for (const rule of TAG_INFERENCE_RULES) {
    lines.push(
      "",
      `  ${rule.id}  ${rule.confidence}  ${rule.needsDocker ? "needs-docker" : "config-only"}`,
      `    ${rule.description}`,
    );
  }

  return lines;
}

/**
 * Resolves the services inference runs over.
 *
 * `-s` / `--services` / `-g` union, exactly as the resolver does, and an absent
 * selector means the whole compose universe — inference is an authoring aid whose
 * default job is "tag the fleet". This deliberately does **not** call
 * `resolveServicesWithInteractive`: popping an Ink multi-select for a read-only
 * suggestion surface would be hostile, and there is nothing to confirm.
 *
 * @throws {GroupNotFoundError} When `-g` names an unknown group
 * @throws {ServiceNotFoundError} When a named service is absent from compose.yml
 */
async function resolveSuggestScope(
  rawOptions: RawTagSuggestOptions,
  config: RfappsConfig,
  universe: readonly string[],
): Promise<readonly string[]> {
  const named: string[] = [];

  if (rawOptions.service !== undefined) {
    named.push(rawOptions.service.trim());
  }

  for (const service of parseServicesList(rawOptions.services) ?? []) {
    if (!named.includes(service)) {
      named.push(service);
    }
  }

  if (named.length > 0) {
    await validateServiceNames(named, config.composePath);
  }

  if (rawOptions.group !== undefined) {
    const members = expandServiceGroup(rawOptions.group, config);

    if (members === undefined) {
      const groups = getAvailableGroups(config);
      throw new GroupNotFoundError(
        rawOptions.group,
        groups,
        findClosestMatch(rawOptions.group, groups),
      );
    }

    for (const service of members) {
      if (!named.includes(service)) {
        named.push(service);
      }
    }
  }

  if (named.length === 0) {
    return universe;
  }

  // Compose declaration order, so output is stable and diffable regardless of the
  // order the operator happened to type the flags in.
  const selected = new Set(named);
  const ordered = universe.filter((service) => selected.has(service));

  for (const service of named) {
    if (!ordered.includes(service)) {
      ordered.push(service);
    }
  }

  return ordered;
}

/** Indent and inter-column separator for the human proposal table (design §8.5). */
const ROW_INDENT = "  ";
const COLUMN_GAP = "  ";

/** One proposal flattened into the cells of its first line plus its continuation tags. */
interface ProposalRow {
  readonly service: string;
  readonly tag: string;
  readonly rules: string;
  readonly trailer: string;
  readonly extraTags: readonly string[];
}

/** Flattens a proposal into a row, or `undefined` when it proposes no tag at all. */
function proposalRow(proposal: TagProposal): ProposalRow | undefined {
  const [first, ...rest] = proposal.tags;

  if (first === undefined) {
    return undefined;
  }

  return {
    service: proposal.service,
    tag: first,
    rules: proposal.rules.join(", "),
    trailer: proposal.alreadyPresent
      ? `${proposal.confidence}  (already effective)`
      : proposal.confidence,
    extraTags: rest,
  };
}

/**
 * Renders the proposal table, sizing every column from the rows it actually emits.
 *
 * Fixed widths cannot work here: a two-rule join is 34 characters and the longest
 * service name in this repo is 19, so any constant wide enough today is one service
 * rename away from a `padEnd` no-op that glues adjacent cells together with no
 * separator. Measuring the content and always emitting `COLUMN_GAP` makes that
 * unrepresentable — the `renderTagListFlat` precedent in `actions/tag.ts`.
 */
function renderProposalTable(proposals: readonly TagProposal[]): string[] {
  const rows = proposals.map(proposalRow).filter((row): row is ProposalRow => row !== undefined);

  const serviceWidth = Math.max(0, ...rows.map((row) => row.service.length));
  const tagWidth = Math.max(0, ...rows.map((row) => row.tag.length));
  const rulesWidth = Math.max(0, ...rows.map((row) => row.rules.length));
  const lines: string[] = [];

  for (const row of rows) {
    lines.push(
      ROW_INDENT +
        row.service.padEnd(serviceWidth) +
        COLUMN_GAP +
        row.tag.padEnd(tagWidth) +
        COLUMN_GAP +
        row.rules.padEnd(rulesWidth) +
        COLUMN_GAP +
        row.trailer,
    );

    for (const tag of row.extraTags) {
      lines.push(ROW_INDENT + " ".repeat(serviceWidth) + COLUMN_GAP + tag);
    }
  }

  return lines;
}

/** Renders the human proposal table and its trailer to stderr (design §8.5). */
function renderSuggestProse(
  result: TagSuggestResult,
  scopeSize: number,
  source: string,
  writtenTo: string | undefined,
): void {
  console.error(
    `Proposed tags for ${result.proposals.length} of ${scopeSize} services ` +
      `(${result.unresolved.length} unresolved, ${result.skippedRules.length} rules skipped).`,
  );

  if (result.proposals.length > 0) {
    console.error("");
  }

  for (const line of renderProposalTable(result.proposals)) {
    console.error(line);
  }

  if (result.degraded) {
    console.error(
      `\nDegraded: Docker was unavailable, so these rules were skipped: ${result.skippedRules.join(", ")}.`,
    );
  }

  if (result.unresolved.length > 0) {
    console.error(
      `\nNo rule fired for ${result.unresolved.length} service(s): ${result.unresolved.join(", ")}`,
    );
  }

  if (writtenTo !== undefined) {
    console.error(`\nWrote the fragment to ${writtenTo}.`);
    console.error(`Paste its contents into the 'tags:' section of ${source}.`);
    return;
  }

  if (result.proposals.length === 0) {
    console.error("\nNothing to paste. Tag the fleet by hand in the 'tags:' section of");
    console.error(`${source}, or re-run with --include-tagged to see existing coverage.`);
    return;
  }

  console.error(`\nCopy the block below into the 'tags:' section of ${source},`);
  console.error("or re-run with --out <path>. This fragment is a paste source, not a");
  console.error("loadable config layer.");
}

/**
 * Persists the fragment to `--out`, refusing to clobber an existing file.
 *
 * `flag: "wx"` is the `actions/harden.ts` precedent. The EEXIST branch throws
 * `InvalidArgumentError` — a usage error, exit 2 — rather than an operational failure,
 * matching the only other `wx` writer in the package.
 *
 * @returns The absolute path written, or `undefined` under `--dry-run`
 * @throws {InvalidArgumentError} When the target already exists
 */
async function writeFragment(
  out: string,
  fragment: string,
  dryRun: boolean,
): Promise<string | undefined> {
  if (dryRun) {
    logInfo(formatDryRun(`write the tag fragment to ${out}`));
    return undefined;
  }

  try {
    await writeFile(out, fragment, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new InvalidArgumentError("--out", out, "file already exists");
    }
    throw error;
  }

  return resolve(out);
}

/** Column-aligned rows for `--output table`, flattening the nested tag and rule lists. */
function suggestTableRows(result: TagSuggestResult): Record<string, unknown>[] {
  return result.proposals.map((proposal) => ({
    service: proposal.service,
    tags: proposal.tags.join(", "),
    rules: proposal.rules.join(", "),
    confidence: proposal.confidence,
    alreadyPresent: proposal.alreadyPresent,
  }));
}

/**
 * Infer a starter tag taxonomy and render it as a paste-ready YAML fragment.
 *
 * Writes nothing to configuration under any combination of flags. The single
 * filesystem write this action can perform is the `--out` fragment, and it is
 * non-clobbering.
 *
 * @param rawOptions - Raw Commander option values for `rfapps tag suggest`
 * @param globalOptions - Program-level options (`--output`, `--json`, `--dry-run`, ...)
 * @throws {InvalidArgumentError} On an unknown `--rule`, an invalid `--profile`, or an existing `--out`
 * @throws {GroupNotFoundError} When `-g` names an unknown group
 * @throws {ServiceNotFoundError} When a named service is absent from compose.yml
 */
export async function executeTagSuggest(
  rawOptions: RawTagSuggestOptions,
  globalOptions: TagGlobalOptions,
): Promise<void> {
  const format: OutputFormat = resolveTagFormat(rawOptions, globalOptions);
  validateTagSuggestOptions(rawOptions);

  if (rawOptions.listRules === true) {
    for (const line of formatTagRulesCatalog()) {
      console.error(line);
    }
    return;
  }

  const config = await loadConfig();

  if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) {
    throw new InvalidArgumentError("--profile", rawOptions.profile, "Invalid profile", [
      ...config.profiles.validProfiles,
    ]);
  }

  const finalConfig = applyCliOverrides(config, {
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  });

  const universe = await parseComposeFile(finalConfig.composePath);
  const scope = await resolveSuggestScope(rawOptions, finalConfig, universe);
  const index = await getTagIndex(finalConfig, finalConfig.composePath, universe);

  const rules = parseTagRuleIds(rawOptions.rule);
  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);

  const inferred = await inferTags(finalConfig, index, {
    services: scope,
    ...(rules === undefined ? {} : { rules }),
    includeTagged: rawOptions.includeTagged === true,
    composePath: finalConfig.composePath,
    envFile: finalConfig.envFile,
    ...(rawOptions.profile === undefined ? {} : { profiles: [rawOptions.profile] }),
    ...(envTool === undefined ? {} : { envTool }),
  });

  const writtenTo =
    rawOptions.out === undefined
      ? undefined
      : await writeFragment(rawOptions.out, inferred.fragment, globalOptions.dryRun === true);

  const result: TagSuggestResult = {
    ...inferred,
    ...(writtenTo === undefined ? {} : { writtenTo }),
  };

  if (format !== "text") {
    await formatOutput(
      format,
      format === "table" ? suggestTableRows(result) : result,
      format === "table"
        ? { columns: ["service", "tags", "rules", "confidence", "alreadyPresent"] }
        : undefined,
    );
    return;
  }

  renderSuggestProse(result, scope.length, index.source, writtenTo);

  if (writtenTo === undefined) {
    process.stdout.write(result.fragment);
  }
}
