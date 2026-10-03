/**
 * The `rfapps tag` command group — **read-only** (design §6.1).
 *
 * `list`, `show`, and `suggest` inspect the hierarchical tag taxonomy and propose
 * additions to it. None of them writes configuration, none takes the global state
 * lock, and there is deliberately no mutation subcommand in v1: the config writer is
 * tracked separately so that a taxonomy edit gets its own review.
 *
 * **The subcommand names are load-bearing.** `resolveStateLockOperation` (`cli.ts`)
 * tests `ALWAYS_MUTATING_COMMANDS.has(commandName)` against the **bare** subcommand
 * name, so a `tag` subcommand named `apply`, `build`, `delete`, `deploy`, `prune`,
 * `pull`, `rebuild`, `rollback`, or `stop` would silently acquire the global state
 * lock on a read-only command. `list` / `show` / `suggest` avoid that set, which is
 * why `resolveStateLockOperation` needs no edit. Anyone adding a subcommand here must
 * re-check that list — and anyone adding one that genuinely writes must revisit the
 * lock decision rather than inherit this one.
 *
 * Registration is dependency-injected in the `commands/state.ts` style so the shell
 * completion parity tests can derive the Commander option surface without spawning a
 * subprocess, and so the lazy-import invariant is mechanically testable.
 *
 * @module rfapps-cli/commands/tag
 */

import type { Command } from "commander";

import type { RawTagListOptions, RawTagShowOptions, TagGlobalOptions } from "../actions/tag.js";
import type { RawTagSuggestOptions } from "../actions/tag-suggest.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { TAG_INFERENCE_RULE_IDS } from "../lib/tags/tag-inference-rules.js";
import type { TagInferenceRuleId } from "../types/tags.js";

type ExecuteTagList = (
  rawOptions: RawTagListOptions,
  globalOptions: TagGlobalOptions,
) => Promise<void>;

type ExecuteTagShow = (
  rawOptions: RawTagShowOptions,
  globalOptions: TagGlobalOptions,
) => Promise<void>;

type ExecuteTagSuggest = (
  rawOptions: RawTagSuggestOptions,
  globalOptions: TagGlobalOptions,
) => Promise<void>;

/**
 * Action loaders, one per action module.
 *
 * Injected so a test can assert the loaders are never called during registration:
 * a static import of an action module would defeat the CLI's lazy-loading budget and
 * the failure is invisible without that assertion.
 */
export interface TagCommandDependencies {
  loadInspectActions(): Promise<{
    executeTagList: ExecuteTagList;
    executeTagShow: ExecuteTagShow;
  }>;
  loadSuggestAction(): Promise<{ executeTagSuggest: ExecuteTagSuggest }>;
}

const defaultDependencies: TagCommandDependencies = {
  loadInspectActions: () => import("../actions/tag.js"),
  loadSuggestAction: () => import("../actions/tag-suggest.js"),
};

/** Rejects a flag that was supplied but names nothing. */
function requireNonBlank(option: string, value: string | undefined, noun: string): void {
  if (value !== undefined && value.trim() === "") {
    throw new InvalidArgumentError(option, value, `Must name ${noun}`);
  }
}

/**
 * Splits a `--services` value, rejecting an empty or hole-punched list.
 *
 * Returned rather than merely validated so the action layer never re-implements the
 * split and the two cannot disagree about what `plex,,sonarr` means.
 *
 * @param value - The raw comma-separated `--services` value
 * @returns The trimmed service names, or `undefined` when the flag was absent
 * @throws {InvalidArgumentError} When the list is empty or contains a blank entry
 */
export function parseServicesList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const services = value.split(",").map((service) => service.trim());

  if (services.length === 0 || services.some((service) => service === "")) {
    throw new InvalidArgumentError(
      "--services",
      value,
      "Must be a comma-separated list of service names",
    );
  }

  return services;
}

/**
 * Parses and validates the `--rule` allowlist against the inference catalog.
 *
 * Validation lives here rather than in the engine because `TagInferenceRuleId` is a
 * closed union: the engine may assume every id it receives is real, and an unknown id
 * must fail as a usage error with the catalog attached instead of silently narrowing
 * the run to zero rules.
 *
 * @param value - The raw comma-separated `--rule` value
 * @returns The validated rule ids, or `undefined` when the flag was absent
 * @throws {InvalidArgumentError} When any id is not in the catalog
 */
export function parseTagRuleIds(value: string | undefined): TagInferenceRuleId[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const requested = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

  if (requested.length === 0) {
    throw new InvalidArgumentError("--rule", value, "Must name at least one inference rule", [
      ...TAG_INFERENCE_RULE_IDS,
    ]);
  }

  const known = new Set<string>(TAG_INFERENCE_RULE_IDS);
  const unknown = requested.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw new InvalidArgumentError("--rule", unknown.join(","), "Unknown inference rule", [
      ...TAG_INFERENCE_RULE_IDS,
    ]);
  }

  return requested as TagInferenceRuleId[];
}

/**
 * Validate `rfapps tag show` values Commander has parsed.
 *
 * Also invoked from the root CLI pre-action hook, so a usage error surfaces before any
 * config or compose I/O happens.
 *
 * @throws {InvalidArgumentError} When no service target is named, or one is blank
 */
export function validateTagShowOptions(options: RawTagShowOptions): void {
  requireNonBlank("--service", options.service, "a service");
  const services = parseServicesList(options.services);

  if (options.service === undefined && services === undefined) {
    throw new InvalidArgumentError(
      "--service",
      "",
      "tag show requires --service <name> or --services <names>",
    );
  }
}

/**
 * Validate `rfapps tag suggest` values Commander has parsed.
 *
 * @throws {InvalidArgumentError} When a scope flag is blank or `--rule` names an unknown id
 */
export function validateTagSuggestOptions(options: RawTagSuggestOptions): void {
  requireNonBlank("--service", options.service, "a service");
  requireNonBlank("--group", options.group, "a service group");
  requireNonBlank("--out", options.out, "a destination file");
  parseServicesList(options.services);
  parseTagRuleIds(options.rule);
}

/** Register the read-only `tag` inspection and inference command group. */
export function registerTagCommand(
  program: Command,
  dependencies: TagCommandDependencies = defaultDependencies,
): void {
  // `.configureHelp()` MUST be chained before the subcommands are created:
  // Commander copies the parent's help configuration into a subcommand at
  // creation time, so a later call never reaches `list`, `show`, or `suggest`.
  const tag = program
    .command("tag")
    .description("Inspect the hierarchical service tag taxonomy")
    .configureHelp({ showGlobalOptions: true })
    .addHelpText(
      "after",
      `
Every subcommand is read-only: none writes configuration, none mutates Docker,
and none acquires the rfapps state lock. Tags are authored by hand in the
'tags:' section of rfapps.config.yaml; 'tag suggest' only proposes a block to
paste there.

Selection with tags happens on the operating commands via --tag <pattern>,
for example:
  rfapps plan --tag media
  rfapps deploy --tag "media/streaming" --yes

Exit codes:
  0  Inspection completed (including zero tags and zero proposals)
  1  The compose file could not be read
  2  Invalid usage, a malformed tag pattern, or a malformed tags.mapping`,
    );

  tag
    .command("list")
    .description("List every effective tag and the services carrying it")
    .option("--tree", "Render the taxonomy as an indented tree")
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .option("--json", "Output in JSON format")
    .addHelpText(
      "after",
      `
Ancestors are derived, not authored: a service tagged 'media/automation/arr'
is listed under 'media' and 'media/automation' as well. The 'declared' field
in --json distinguishes an authored tag from a derived ancestor.

There is no positional pattern argument. To find out what a pattern selects,
run the operating command with --dry-run, or filter 'tag list --json' with jq.`,
    )
    .action(async (options: RawTagListOptions) => {
      const { executeTagList } = await dependencies.loadInspectActions();
      await executeTagList(options, program.opts());
    });

  tag
    .command("show")
    .description("Show the declared and effective tags of specific services")
    .option("-s, --service <name>", "Target a specific service")
    .option("--services <names>", "Comma-separated service targets")
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .option("--json", "Output in JSON format")
    .addHelpText(
      "after",
      `
'declared' is what rfapps.config.yaml assigns to the service; 'effective' adds
every ancestor of those paths, and is the set --tag patterns are matched
against.`,
    )
    .action(async (options: RawTagShowOptions) => {
      validateTagShowOptions(options);
      const { executeTagShow } = await dependencies.loadInspectActions();
      await executeTagShow(options, program.opts());
    });

  tag
    .command("suggest")
    .description("Infer a starter tag taxonomy from compose and configuration")
    .option("-s, --service <name>", "Target a specific service")
    .option("--services <names>", "Comma-separated service targets")
    .option("-g, --group <name>", "Target a service group")
    .option("--rule <ids>", "Comma-separated inference rule allowlist")
    .option("--list-rules", "Print the inference rule catalog and exit")
    .option("--include-tagged", "Include services whose tags are already present")
    .option("-o, --out <path>", "Write the YAML fragment to this path instead of stdout")
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .option("--json", "Output in JSON format")
    .addHelpText(
      "after",
      `
Writes NOTHING to configuration. The YAML fragment goes to stdout (prose goes
to stderr, so 'rfapps tag suggest > fragment.yaml' captures only the block) or
to --out <path>, which refuses to overwrite an existing file.

The fragment is a PASTE SOURCE, not a loadable config layer: 'tags:' layers
wholesale, so saving a partial block as .rfapps.yaml shadows the whole fleet
taxonomy instead of extending it.

By default only services that would gain something are proposed, which makes
repeated runs idempotent; --include-tagged shows everything.

If the Docker CLI is unavailable the run degrades to the configuration-only
rules and reports which rules were skipped.`,
    )
    .action(async (options: RawTagSuggestOptions) => {
      validateTagSuggestOptions(options);
      const { executeTagSuggest } = await dependencies.loadSuggestAction();
      await executeTagSuggest(options, program.opts());
    });
}
