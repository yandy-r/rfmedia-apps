/**
 * Compose security hardening command definition for rfapps CLI.
 *
 * The registrar owns option wiring and usage validation only; every behaviour
 * lives in the lazily loaded action so CLI startup stays fast.
 */

import { isMachineFormat } from "@rfmedia/common";
import type { Command } from "commander";

import type { HardenGlobalOptions, RawHardenOptions } from "../actions/harden.js";
import { addServiceTargetOptions } from "../lib/command-options.js";
import { InvalidArgumentError } from "../lib/errors.js";

type ExecuteHarden = (
  rawOptions: RawHardenOptions,
  globalOptions: HardenGlobalOptions,
) => Promise<void>;

/** Lazily loaded action module, injectable so option wiring stays testable. */
export interface HardenCommandDependencies {
  loadAction(): Promise<{ executeHarden: ExecuteHarden }>;
}

const defaultDependencies: HardenCommandDependencies = {
  loadAction: () => import("../actions/harden.js"),
};

function isMachineOutput(options: RawHardenOptions, globalOptions: HardenGlobalOptions): boolean {
  // Must mirror resolveHardenFormat + isMachineFormat in actions/harden.ts: the
  // action skips the confirmation prompt for every machine format, csv included.
  if (options.json === true) {
    return true;
  }
  const format = globalOptions.output ?? (globalOptions.json === true ? "json" : "text");
  return isMachineFormat(format);
}

/**
 * Reject incoherent harden flag combinations before config, Docker, or the
 * state lock are touched.
 *
 * The root CLI pre-action hook invokes this ahead of lock acquisition; the
 * action repeats it so independently embedded registrars stay guarded.
 *
 * @param options - Raw Commander option values for `rfapps harden`
 * @param globalOptions - Program-level options (`--output`, `--yes`, ...)
 * @throws {InvalidArgumentError} On mutually exclusive or unsupported combinations
 */
export function validateHardenOptions(
  options: RawHardenOptions,
  globalOptions: HardenGlobalOptions,
): void {
  if (options.listRules === true) {
    return; // The catalog ignores every other flag.
  }
  if (options.apply === true && options.out !== undefined) {
    throw new InvalidArgumentError(
      "--apply",
      "true",
      "Cannot combine --apply with --out; --out writes a non-destructive override instead",
    );
  }
  if (options.allowReformat === true && options.apply !== true) {
    throw new InvalidArgumentError(
      "--allow-reformat",
      "true",
      "Only meaningful with --apply; propose and --out never rewrite compose.yml",
    );
  }
  if (options.backup === false && options.apply !== true) {
    throw new InvalidArgumentError(
      "--no-backup",
      "false",
      "Only meaningful with --apply; propose and --out never rewrite compose.yml",
    );
  }
  if (
    options.apply === true &&
    isMachineOutput(options, globalOptions) &&
    globalOptions.yes !== true
  ) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format --apply requires explicit --yes; a prompt cannot be answered in a JSON pipeline",
    );
  }
}

/**
 * Register the compose hardening command. Non-destructive unless --apply or --out.
 *
 * @param program - Root Commander program the command attaches to
 * @param dependencies - Injectable action loader, defaulted to the real module
 */
export function registerHardenCommand(
  program: Command,
  dependencies: HardenCommandDependencies = defaultDependencies,
): void {
  const harden = program
    .command("harden")
    .description("Propose or apply compose security hardening")
    .configureHelp({ showGlobalOptions: true });

  addServiceTargetOptions(harden)
    .option("--apply", "Edit compose.yml in place (requires confirmation)", false)
    .option("-o, --out <path>", "Write a compose override fragment to <path>")
    .option("--include-review", "Include review-confidence rules in written output", false)
    .option("--rule <ids>", "Restrict to a comma-separated rule allowlist")
    .option("--list-rules", "Print the rule catalog and exit", false)
    .option("--no-backup", "Skip the compose.yml.bak copy taken before --apply")
    .option("--allow-reformat", "Accept incidental YAML reformatting of untouched lines", false)
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .option("--json", "Output the harden result in JSON format", false)
    .addHelpText(
      "after",
      `
Non-destructive by default: with no write flag, harden resolves compose
configuration, reports proposed hardening, and prints an editable compose
override fragment. It writes nothing and does not touch containers, images, or
recorded state.

Proposals are split by confidence. Safe changes are mechanical and
workload-neutral. Review changes (cap_drop ALL, read-only rootfs, non-root
user) can break a workload and are excluded from writes unless --include-review
is passed. Health checks and resource limits are advisory only: rfapps will not
invent a probe command or a memory ceiling.

--apply refuses any edit whose target key is a YAML alias, because that would
change every service sharing the anchor; the refusal names the --out
alternative. It also refuses when serializing compose.yml would reformat lines
this command did not target, unless --allow-reformat is passed.

Rule suppressions come from the harden.ignore section of rfapps.config.yaml.

Exit codes:
  0  Proposals reported, override written, or apply completed
  1  Compose resolution failed, or a write failed
  2  Usage error, or reformatting untargeted lines was refused
  3  Apply completed with some patches refused`,
    )
    .action(async (options: RawHardenOptions) => {
      const globalOptions = program.opts<HardenGlobalOptions>();
      validateHardenOptions(options, globalOptions);
      const { executeHarden } = await dependencies.loadAction();
      await executeHarden(options, globalOptions);
    });
}
